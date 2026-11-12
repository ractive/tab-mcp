/**
 * Sets a new version of the client or the relay everywhere it is pinned:
 *
 *   bun scripts/bump-version.ts client 0.14.0
 *   bun scripts/bump-version.ts relay 0.10.0
 *
 * - the package's package.json (the code reads its version from there);
 * - every mention of the old version in the pinned docs (scripts/pinned-files.ts),
 *   including `@ractive-ch/<package>@<v>` and, for the relay, image tags;
 * - for the client, the plugin manifests' version (it follows the client);
 * - CHANGELOG.md: the package's "### Unreleased" becomes the new version with
 *   today's date, and its link is added;
 * - bun.lock, through `bun install`.
 *
 * Refuses when the old version is also the other package's current version
 * (a bare "0.9.0" in the docs could then mean either), when the new version
 * is not greater, or when the package has no "### Unreleased" section.
 * The release itself (PR, merge, `gh release create`) stays manual: see
 * .claude/skills/release/SKILL.md.
 */

import { join } from "node:path";
import { PINNED_FILES, PLUGIN_MANIFESTS } from "./pinned-files.ts";

export type Package = "client" | "relay";

const DIRS: Record<Package, string> = {
	client: "packages/tab-mcp-client",
	relay: "packages/tab-mcp",
};
const NAMES: Record<Package, string> = {
	client: "@ractive-ch/tab-mcp-client",
	relay: "@ractive-ch/tab-mcp",
};

const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/;

/** -1, 0 or 1; prerelease tags compare as strings and sort before the release. */
export function compareVersions(a: string, b: string): number {
	const [ma, pa] = a.split("-", 2) as [string, string | undefined];
	const [mb, pb] = b.split("-", 2) as [string, string | undefined];
	const na = ma.split(".").map(Number);
	const nb = mb.split(".").map(Number);
	for (let i = 0; i < 3; i++) {
		const d = (na[i] ?? 0) - (nb[i] ?? 0);
		if (d !== 0) return Math.sign(d);
	}
	if (pa === pb) return 0;
	if (pa === undefined) return 1;
	if (pb === undefined) return -1;
	return pa < pb ? -1 : 1;
}

/** Every whole-version mention of `from` (not part of an IP address or a longer version) as `to`. */
export function replaceVersion(text: string, from: string, to: string): string {
	const escaped = from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return text.replace(
		new RegExp(`(?<![\\d.])${escaped}(?!\\.?\\d|-[0-9A-Za-z])`, "g"),
		to,
	);
}

/** The package's "### Unreleased" as the dated version, and its link above the first one of its kind. */
export function datedChangelog(
	text: string,
	pkg: Package,
	version: string,
	date: string,
): string {
	const heading = `## ${NAMES[pkg]}\n\n### Unreleased\n`;
	if (!text.includes(heading))
		throw new Error(
			`CHANGELOG.md: no "### Unreleased" right under "## ${NAMES[pkg]}"`,
		);
	const tag = `${pkg}-${version}`;
	let out = text.replace(
		heading,
		`## ${NAMES[pkg]}\n\n### [${version}][${tag}] - ${date}\n`,
	);
	const link = `[${tag}]: https://github.com/ractive/tab-mcp/releases/tag/${pkg}-v${version}\n`;
	const first = out.search(new RegExp(`^\\[${pkg}-`, "m"));
	out =
		first === -1
			? `${out.trimEnd()}\n${link}`
			: out.slice(0, first) + link + out.slice(first);
	return out;
}

async function main(): Promise<void> {
	const [pkg, next] = Bun.argv.slice(2);
	if (
		(pkg !== "client" && pkg !== "relay") ||
		next === undefined ||
		!VERSION.test(next)
	) {
		console.error("usage: bun scripts/bump-version.ts client|relay <version>");
		process.exit(2);
	}
	const root = join(import.meta.dir, "..");
	const file = (p: string) => Bun.file(join(root, p));
	const versionOf = async (p: Package) =>
		((await file(`${DIRS[p]}/package.json`).json()) as { version: string })
			.version;
	const current = await versionOf(pkg);
	const other = await versionOf(pkg === "client" ? "relay" : "client");
	if (compareVersions(next, current) <= 0)
		throw new Error(`${next} is not greater than ${current}`);
	if (current === other)
		throw new Error(
			`${current} is also the other package's version; edit the pinned docs by hand`,
		);

	// Everything is worked out first, so a refusal leaves no file half done.
	const edits = new Map<string, string>();
	const date = new Date().toISOString().slice(0, 10);
	edits.set(
		"CHANGELOG.md",
		datedChangelog(await file("CHANGELOG.md").text(), pkg, next, date),
	);
	const manifest = `${DIRS[pkg]}/package.json`;
	edits.set(
		manifest,
		(await file(manifest).text()).replace(
			`"version": "${current}"`,
			`"version": "${next}"`,
		),
	);
	for (const p of PINNED_FILES) {
		if (pkg === "relay" && PLUGIN_MANIFESTS.includes(p)) continue;
		edits.set(p, replaceVersion(await file(p).text(), current, next));
	}
	const changed: string[] = [];
	for (const [p, text] of edits) {
		if ((await file(p).text()) === text) continue;
		await Bun.write(join(root, p), text);
		changed.push(p);
	}

	const install = Bun.spawnSync(["bun", "install"], {
		cwd: root,
		stdout: "inherit",
		stderr: "inherit",
	});
	if (install.exitCode !== 0) throw new Error("bun install failed");
	console.log(
		`${NAMES[pkg]} ${current} -> ${next}:\n  ${[...changed, "bun.lock"].join("\n  ")}`,
	);
	console.log(
		"Next: bun run verify, then commit, PR, merge, release (.claude/skills/release/SKILL.md).",
	);
}

if (import.meta.main) await main();
