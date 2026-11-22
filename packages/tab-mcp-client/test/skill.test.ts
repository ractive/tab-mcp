/**
 * The agent skill in the npm package (DEC-216): its links work from
 * `node_modules/@ractive-ch/tab-mcp-client/skill/`, and the plugin's copy
 * works from `plugins/tab-mcp/skills/tab-mcp/`.
 */
import { expect, test } from "bun:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, posix } from "node:path";
import { expectedFiles, PACKAGES } from "../../../scripts/npm-pack.ts";
import { packagedSkill, SKILL_SOURCE, skillFiles } from "../scripts/skill.ts";

const root = join(import.meta.dir, "..");
const repo = join(root, "../..");
const version = async (dir: string) =>
	(
		(await Bun.file(join(repo, dir, "package.json")).json()) as {
			version: string;
		}
	).version;
const client = await version("packages/tab-mcp-client");
const relay = await version("packages/tab-mcp");
const skill = await packagedSkill(repo, client);
const spec = PACKAGES["client"];
if (spec === undefined) throw new Error("no client spec");
const packageFiles = new Set(expectedFiles(repo, spec));

/** The text without fenced code blocks, whose URLs are no links. */
const prose = (text: string) => text.replace(/^```[^\n]*\n[\s\S]*?^```/gm, "");

/** Targets of `[text](target)` and `<https://…>` links. */
function links(text: string): string[] {
	const body = prose(text);
	return [
		...[...body.matchAll(/\]\(([^)\s]+)\)/g)].map((m) => m[1] ?? ""),
		...[...body.matchAll(/<(https?:\/\/[^>\s]+)>/g)].map((m) => m[1] ?? ""),
	];
}

/** GitHub's anchors for the headings of a Markdown text. */
function anchors(text: string): Set<string> {
	const seen = new Map<string, number>();
	const out = new Set<string>();
	for (const m of prose(text).matchAll(/^#{1,6}\s+(.+)$/gm)) {
		const slug = (m[1] ?? "")
			.trim()
			.toLowerCase()
			.replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, "")
			.replace(/\s/g, "-");
		const n = seen.get(slug) ?? 0;
		seen.set(slug, n + 1);
		out.add(n === 0 ? slug : `${slug}-${n}`);
	}
	return out;
}

/** The text of a Markdown file of the package, from its source. */
async function packageText(path: string): Promise<string | undefined> {
	const fromSkill = skill.get(path);
	if (fromSkill !== undefined) return fromSkill;
	if (path === "README.md" || path === "CHANGELOG.md")
		return Bun.file(join(root, path)).text();
	return undefined;
}

test("every relative link of the packaged skill names a file of the package", async () => {
	const wrong: string[] = [];
	let relative = 0;
	for (const [path, text] of skill) {
		for (const link of links(text)) {
			if (/^[a-z]+:/.test(link)) continue;
			relative++;
			const [file = "", anchor] = link.split("#");
			const target =
				file === ""
					? path
					: posix.normalize(posix.join(posix.dirname(path), file));
			if (target.startsWith("../") || !packageFiles.has(target)) {
				wrong.push(`${path}: ${link} (not in the package)`);
				continue;
			}
			if (anchor === undefined || !target.endsWith(".md")) continue;
			const markdown = await packageText(target);
			if (markdown === undefined || !anchors(markdown).has(anchor))
				wrong.push(`${path}: ${link} (no such heading)`);
		}
	}
	expect(wrong).toEqual([]);
	// The README, the CHANGELOG, the references and a declaration file.
	expect(relative).toBeGreaterThanOrEqual(8);
	const top = skill.get("skill/SKILL.md")?.split("\n## ")[0] ?? "";
	// Near the top: the version it describes, the README beside it.
	expect(top).toContain(`\`@ractive-ch/tab-mcp-client\` ${client}`);
	expect(top).toContain("](../README.md)");
	expect(top).toContain("](../CHANGELOG.md)");
	expect(links(skill.get("skill/references/react.md") ?? "")).toContain(
		"../../README.md#tools-in-a-usestate-app",
	);
});

test("the packaged skill names the client's files only beside it, not on GitHub", () => {
	for (const text of skill.values())
		expect(text).not.toMatch(
			/github\.com\/ractive\/tab-mcp\/(?:blob|tree)\/[^/)\s]+\/packages\/tab-mcp-client\//,
		);
});

test("the plugin's skill links only into its own folder by a relative path", async () => {
	const folder = join(repo, SKILL_SOURCE);
	const wrong: string[] = [];
	for (const file of await skillFiles(repo)) {
		const text = await Bun.file(join(folder, file)).text();
		for (const link of links(text)) {
			if (/^[a-z]+:/.test(link)) continue;
			const target = posix.normalize(
				posix.join(posix.dirname(file), link.split("#")[0] ?? ""),
			);
			if (target.startsWith("../") || !existsSync(join(folder, target)))
				wrong.push(`${file}: ${link}`);
		}
	}
	expect(wrong).toEqual([]);
});

const git = (...args: string[]) =>
	Bun.spawnSync(["git", ...args], { cwd: repo, stderr: "ignore" });
/** Whether the release tags are in this checkout (CI fetches them, ci.yml). */
const tagsFetched = git("tag", "--list", "client-v*").stdout.toString() !== "";
if (!tagsFetched)
	console.warn(
		"skill.test.ts: no release tags in this checkout (git fetch --tags): links at a release's tag are not checked",
	);

/**
 * A file of the repository at a ref: the working tree for `main` and for
 * the tag of a version not released yet (a release's own pull request);
 * `undefined` when it is not there.
 */
function fileAt(ref: string, file: string): string | undefined {
	const released =
		ref !== "main" &&
		git("rev-parse", "--verify", "--quiet", `refs/tags/${ref}^{commit}`)
			.exitCode === 0;
	if (!released) {
		const path = join(repo, file);
		if (!existsSync(path)) return undefined;
		return statSync(path).isDirectory() ? "" : readFileSync(path, "utf8");
	}
	const show = git("show", `${ref}:${file}`);
	return show.exitCode === 0 ? show.stdout.toString() : undefined;
}

// Without the tags, a fresh shallow clone skips this with the warning above;
// CI must have them.
test.skipIf(!tagsFetched && !process.env["CI"])(
	"the skill's links into the repository name files that exist at the ref they name: main or a current release's tag",
	() => {
		expect(tagsFetched).toBe(true);
		const refs = new Set(["main", `client-v${client}`, `relay-v${relay}`]);
		const wrong: string[] = [];
		let checked = 0;
		for (const [path, text] of skill) {
			for (const link of links(text)) {
				const m =
					/^https:\/\/github\.com\/ractive\/tab-mcp\/(blob|tree)\/([^/]+)\/([^#]+)(?:#(.+))?$/.exec(
						link,
					);
				if (m === null) continue;
				checked++;
				const [, kind, ref = "", file = "", anchor] = m;
				if (!refs.has(ref)) wrong.push(`${path}: ${link} (ref ${ref})`);
				if (fileAt(ref, file) === undefined) {
					wrong.push(`${path}: ${link} (no such file at ${ref})`);
					continue;
				}
				if (anchor === undefined) continue;
				const markdown = fileAt(
					ref,
					kind === "tree" ? `${file}/README.md` : file,
				);
				if (markdown === undefined || !anchors(markdown).has(anchor))
					wrong.push(`${path}: ${link} (no such heading at ${ref})`);
			}
		}
		expect(wrong).toEqual([]);
		expect(checked).toBeGreaterThanOrEqual(5);
	},
);
