/**
 * scripts/ci-changes.sh, CI's check whether a pull request changes only kb/,
 * on a scratch repository: a merge commit per case, as GitHub makes one.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";

const SCRIPT = join(import.meta.dir, "ci-changes.sh");
let dir: string;
let repo: string;

const git = (...args: string[]) =>
	$`git -c user.name=test -c user.email=test@example.invalid -c commit.gpgsign=false ${args}`
		.cwd(repo)
		.quiet();

beforeAll(async () => {
	dir = mkdtempSync(join(tmpdir(), "tab-mcp-ci-changes-"));
	repo = join(dir, "repo");
	mkdirSync(repo);
	await git("init", "-q", "-b", "main");
	await Bun.write(join(repo, "kb/a.md"), "a\n");
	await Bun.write(join(repo, "docs/b.md"), "b\n");
	await Bun.write(join(repo, "src/c.ts"), "c\n");
	await git("add", ".");
	await git("commit", "-qm", "base");
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** A branch from main with `change` committed, merged into a detached main as GitHub's merge commit. */
async function pullRequest(name: string, change: () => Promise<unknown>) {
	await git("checkout", "-q", "-b", name, "main");
	await change();
	await git("add", "-A");
	await git("commit", "-qm", name);
	await git("checkout", "-q", "--detach", "main");
	await git("merge", "-q", "--no-ff", "-m", `merge ${name}`, name);
}

async function code(event: string): Promise<string> {
	const out = join(dir, "output");
	rmSync(out, { force: true });
	await $`bash ${SCRIPT}`
		.cwd(repo)
		.env({ ...process.env, EVENT: event, GITHUB_OUTPUT: out })
		.quiet();
	return (await Bun.file(out).text()).trim();
}

test("a pull request that changes only kb/ skips; as a push it runs", async () => {
	await pullRequest("kb-only", () => Bun.write(join(repo, "kb/a.md"), "a2\n"));
	expect(await code("pull_request")).toBe("code=false");
	expect(await code("push")).toBe("code=true");
});

test("kb/ and anything else runs", async () => {
	await pullRequest("kb-and-docs", async () => {
		await Bun.write(join(repo, "kb/a.md"), "a3\n");
		await Bun.write(join(repo, "docs/b.md"), "b2\n");
	});
	expect(await code("pull_request")).toBe("code=true");
});

test("a file moved into kb/ runs: its old path counts as deleted", async () => {
	await pullRequest("move-into-kb", () => git("mv", "docs/b.md", "kb/b.md"));
	expect(await code("pull_request")).toBe("code=true");
});

test("a deletion outside kb/ runs, a deletion in kb/ alone skips", async () => {
	await pullRequest("delete-code", () => git("rm", "-q", "src/c.ts"));
	expect(await code("pull_request")).toBe("code=true");
	await pullRequest("delete-kb", () => git("rm", "-q", "kb/a.md"));
	expect(await code("pull_request")).toBe("code=false");
});

test("a type change outside kb/ (a file made a link) runs", async () => {
	await pullRequest("type-change", async () => {
		rmSync(join(repo, "docs/b.md"));
		await $`ln -s ../kb/a.md docs/b.md`.cwd(repo).quiet();
	});
	expect(await code("pull_request")).toBe("code=true");
});

test("no merge commit runs", async () => {
	await git("checkout", "-q", "--detach", "main");
	expect(await code("pull_request")).toBe("code=true");
});
