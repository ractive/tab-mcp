/**
 * The agent skill in the npm package (DEC-216): `plugins/tab-mcp/skills/tab-mcp/`
 * (SKILL.md and `references/`) is the one source; `scripts/build.ts` writes
 * it to `dist/skill/`, and the release's tarball check
 * (`scripts/npm-pack.ts` at the root) compares the tarball's copy with it.
 *
 * As a plugin the skill links the client's README, CHANGELOG and sources on
 * GitHub, at the tag of the version it describes. In the package those links
 * point to the files beside it (`../README.md`, `../strings.d.ts`), which
 * describe the version that is installed. Every other link stays as it is.
 */

import { posix } from "node:path";

/** The skill's folder, from the repository root. */
export const SKILL_SOURCE = "plugins/tab-mcp/skills/tab-mcp";

/** Where the skill goes in the package. */
export const SKILL_TARGET = "skill";

/** The files of the skill that ship, relative to its folder. */
export async function skillFiles(repo: string): Promise<string[]> {
	const files = await Array.fromAsync(
		new Bun.Glob("**/*.md").scan(posix.join(repo, SKILL_SOURCE)),
	);
	return files.map((f) => f.replaceAll("\\", "/")).sort();
}

/**
 * The text of one skill file as it ships: links to the client's README,
 * CHANGELOG or a source file at `client-v<version>` become relative links to
 * the package's README, CHANGELOG or that file's declarations.
 */
export function packagedText(
	file: string,
	text: string,
	version: string,
): string {
	const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const link = new RegExp(
		`\\]\\(https://github\\.com/ractive/tab-mcp/blob/client-v${escaped}/packages/tab-mcp-client/(README\\.md|CHANGELOG\\.md|src/([A-Za-z0-9_-]+)\\.ts)(#[^)\\s]*)?\\)`,
		"g",
	);
	const up = posix.relative(posix.dirname(posix.join(SKILL_TARGET, file)), ".");
	return text.replace(
		link,
		(_, path: string, source: string | undefined, anchor = "") =>
			`](${posix.join(up, source === undefined ? path : `${source}.d.ts`)}${anchor})`,
	);
}

/** The packaged skill: package path (`skill/SKILL.md`) to text. */
export async function packagedSkill(
	repo: string,
	version: string,
): Promise<Map<string, string>> {
	const out = new Map<string, string>();
	for (const file of await skillFiles(repo)) {
		const text = await Bun.file(posix.join(repo, SKILL_SOURCE, file)).text();
		out.set(posix.join(SKILL_TARGET, file), packagedText(file, text, version));
	}
	return out;
}
