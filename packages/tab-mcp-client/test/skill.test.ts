/**
 * The agent skill in the npm package (DEC-216): its links work from
 * `node_modules/@ractive-ch/tab-mcp-client/skill/`, and the plugin's copy
 * works from `plugins/tab-mcp/skills/tab-mcp/`.
 */
import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
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

test("the skill's links into the repository name files that exist, at main or a current release's tag", async () => {
	const refs = new Set(["main", `client-v${client}`, `relay-v${relay}`]);
	const wrong: string[] = [];
	for (const [path, text] of skill) {
		for (const link of links(text)) {
			const m =
				/^https:\/\/github\.com\/ractive\/tab-mcp\/(blob|tree)\/([^/]+)\/([^#]+)(?:#(.+))?$/.exec(
					link,
				);
			if (m === null) continue;
			const [, kind, ref = "", file = "", anchor] = m;
			if (!refs.has(ref)) wrong.push(`${path}: ${link} (ref ${ref})`);
			if (!existsSync(join(repo, file))) {
				wrong.push(`${path}: ${link} (no such file)`);
				continue;
			}
			if (anchor === undefined) continue;
			const markdown = join(repo, kind === "tree" ? `${file}/README.md` : file);
			if (!anchors(await Bun.file(markdown).text()).has(anchor))
				wrong.push(`${path}: ${link} (no such heading)`);
		}
	}
	expect(wrong).toEqual([]);
});
