/**
 * The failure paths of the signing and publishing scripts that need neither
 * the registry nor an OIDC token (they run on Node, as in the workflow).
 */
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "npm-cli-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function run(script: string, args: string[]) {
	const r = Bun.spawnSync(["node", join(import.meta.dir, script), ...args], {
		env: { ...process.env, GITHUB_ACTIONS: "false" },
	});
	return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() };
}

const empty = join(tmp, "empty");
mkdirSync(empty);
const one = join(tmp, "one");
mkdirSync(one);
writeFileSync(join(one, "x.tgz"), "not the packed tarball");

test("publish: an empty artifact fails with a clear message", () => {
	const r = run("npm-publish.mjs", [
		empty,
		"--integrity",
		"sha512-AAA",
		"--version",
		"0.1.0",
		"--dist-tag",
		"latest",
	]);
	expect(r.code).toBe(1);
	expect(r.out).toContain("expected exactly one .tgz");
});

test("publish: a tarball other than the checked one is refused", () => {
	const r = run("npm-publish.mjs", [
		one,
		"--integrity",
		"sha512-AAA",
		"--version",
		"0.1.0",
		"--dist-tag",
		"latest",
	]);
	expect(r.code).toBe(1);
	expect(r.out).toContain("not the checked sha512-AAA");
});

test("sign: an empty artifact fails; signing needs GitHub Actions", () => {
	const r = run("npm-provenance.mjs", ["sign", empty, "--integrity", "x"]);
	expect(r.code).toBe(1);
	expect(r.out).toContain("expected exactly one .tgz");
	const tar = join(tmp, "pkg");
	mkdirSync(join(tar, "package"), { recursive: true });
	writeFileSync(
		join(tar, "package", "package.json"),
		JSON.stringify({ name: "@ractive-ch/tab-mcp-client", version: "0.1.0" }),
	);
	const dir = join(tmp, "signdir");
	mkdirSync(dir);
	Bun.spawnSync(["tar", "-czf", join(dir, "p.tgz"), "-C", tar, "package"]);
	const s = run("npm-provenance.mjs", ["sign", dir, "--integrity", "x"]);
	expect(s.code).toBe(2);
	expect(s.out).toContain("GitHub Actions only");
	expect(run("npm-provenance.mjs", ["verify", "only-one-arg"]).code).toBe(2);
});
