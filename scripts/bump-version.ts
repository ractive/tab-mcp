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

/** -1, 0 or 1 in SemVer order (§11): a pre-release sorts before its release. */
export function compareVersions(a: string, b: string): number {
	const split = (v: string) => {
		const dash = v.indexOf("-");
		return dash === -1
			? { core: v, pre: undefined }
			: { core: v.slice(0, dash), pre: v.slice(dash + 1) };
	};
	const va = split(a);
	const vb = split(b);
	const na = va.core.split(".").map(Number);
	const nb = vb.core.split(".").map(Number);
	for (let i = 0; i < 3; i++) {
		const d = (na[i] ?? 0) - (nb[i] ?? 0);
		if (d !== 0) return Math.sign(d);
	}
	if (va.pre === vb.pre) return 0;
	if (va.pre === undefined) return 1;
	if (vb.pre === undefined) return -1;
	const ia = va.pre.split(".");
	const ib = vb.pre.split(".");
	for (let i = 0; i < Math.max(ia.length, ib.length); i++) {
		const x = ia[i];
		const y = ib[i];
		if (x === undefined) return -1;
		if (y === undefined) return 1;
		if (x === y) continue;
		const xn = /^\d+$/.test(x);
		const yn = /^\d+$/.test(y);
		if (xn && yn) return Math.sign(Number(x) - Number(y));
		if (xn) return -1;
		if (yn) return 1;
		return x < y ? -1 : 1;
	}
	return 0;
}

/** Every whole-version mention of `from` (not part of an IP address or a longer version) as `to`. */
export function replaceVersion(text: string, from: string, to: string): string {
	const escaped = from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return text.replace(
		new RegExp(`(?<![\\d.])${escaped}(?!\\.?\\d|-[0-9A-Za-z])`, "g"),
		to,
	);
}

/**
 * The package's "### Unreleased" (its first "###" heading; an intro paragraph
 * may come before it) as the dated version, and its link above the first one
 * of its kind.
 */
export function datedChangelog(
	text: string,
	pkg: Package,
	version: string,
	date: string,
): string {
	const start = text.indexOf(`\n## ${NAMES[pkg]}\n`);
	const sub = start === -1 ? -1 : text.indexOf("\n### ", start + 1);
	const nextSection = start === -1 ? -1 : text.indexOf("\n## ", start + 1);
	const unreleased = "\n### Unreleased\n";
	if (
		sub === -1 ||
		(nextSection !== -1 && nextSection < sub) ||
		!text.startsWith(unreleased, sub)
	)
		throw new Error(
			`CHANGELOG.md: the first section under "## ${NAMES[pkg]}" is not "### Unreleased"`,
		);
	const tag = `${pkg}-${version}`;
	let out = `${text.slice(0, sub)}\n### [${version}][${tag}] - ${date}\n${text.slice(sub + unreleased.length)}`;
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
	// tab-mcp for Chrome's version is named in the pinned docs too.
	const extension = (
		(await file("packages/tab-mcp-extension/package.json").json()) as {
			version: string;
		}
	).version;
	if (compareVersions(next, current) <= 0)
		throw new Error(`${next} is not greater than ${current}`);
	// A bare version in the docs must name one package only.
	for (const [v, what] of [
		[current, "old"],
		[next, "new"],
	] as const)
		if (v === other || v === extension)
			throw new Error(
				`the ${what} version ${v} is also another package's version (relay, client or tab-mcp for Chrome); edit the pinned docs by hand`,
			);

	// Everything is worked out first, so a refusal leaves no file half done.
	const edits = new Map<string, string>();
	// The local date (YYYY-MM-DD), not UTC's.
	const date = new Date().toLocaleDateString("sv-SE");
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
