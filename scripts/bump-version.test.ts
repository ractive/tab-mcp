import { expect, test } from "bun:test";
import { join } from "node:path";
import {
	changelogPath,
	compareVersions,
	datedChangelog,
	replaceVersion,
} from "./bump-version.ts";

test("replaceVersion rewrites whole versions only", () => {
	const text = [
		"@ractive-ch/tab-mcp-client@0.13.0/cdn",
		"**Status: 0.13.0.** Until 1.0",
		"ractive/tab-mcp:0.13.0",
		"10.13.0 0.13.01 0.13.0.1 0.13.0-rc.1 127.0.13.0",
	].join("\n");
	expect(replaceVersion(text, "0.13.0", "0.14.0")).toBe(
		[
			"@ractive-ch/tab-mcp-client@0.14.0/cdn",
			"**Status: 0.14.0.** Until 1.0",
			"ractive/tab-mcp:0.14.0",
			"10.13.0 0.13.01 0.13.0.1 0.13.0-rc.1 127.0.13.0",
		].join("\n"),
	);
});

test("compareVersions orders releases and pre-releases", () => {
	expect(compareVersions("0.14.0", "0.13.9")).toBe(1);
	expect(compareVersions("0.13.0", "0.13.0")).toBe(0);
	expect(compareVersions("0.13.0-rc.1", "0.13.0")).toBe(-1);
	expect(compareVersions("1.0.0", "0.99.99")).toBe(1);
	expect(compareVersions("0.14.0-rc.10", "0.14.0-rc.9")).toBe(1);
	expect(compareVersions("0.14.0-10", "0.14.0-2")).toBe(1);
	expect(compareVersions("0.14.0-alpha", "0.14.0-alpha.1")).toBe(-1);
	expect(compareVersions("0.14.0-1", "0.14.0-alpha")).toBe(-1);
});

const RELAY_CHANGELOG = `# Changelog of @ractive-ch/tab-mcp

All notable changes to the relay.

The relay. Each relay release is also a Docker image.

## Unreleased

### Added

- x

## [0.9.0][relay-0.9.0] - 2026-11-11

### Fixed

- y

[relay-0.9.0]: https://github.com/ractive/tab-mcp/releases/tag/relay-v0.9.0
`;

test("datedChangelog dates the Unreleased section and adds its link", () => {
	const out = datedChangelog(RELAY_CHANGELOG, "relay", "0.10.0", "2026-11-13");
	expect(out).toBe(
		RELAY_CHANGELOG.replace(
			"## Unreleased\n",
			"## [0.10.0][relay-0.10.0] - 2026-11-13\n",
		).replace(
			"[relay-0.9.0]:",
			"[relay-0.10.0]: https://github.com/ractive/tab-mcp/releases/tag/relay-v0.10.0\n[relay-0.9.0]:",
		),
	);
});

test("datedChangelog appends the first link of a changelog without one", () => {
	const out = datedChangelog(
		"# Changelog of @ractive-ch/tab-mcp-client\n\n## Unreleased\n\n- x\n",
		"client",
		"0.1.0",
		"2026-11-13",
	);
	expect(out).toBe(
		"# Changelog of @ractive-ch/tab-mcp-client\n\n## [0.1.0][client-0.1.0] - 2026-11-13\n\n- x\n\n[client-0.1.0]: https://github.com/ractive/tab-mcp/releases/tag/client-v0.1.0\n",
	);
});

test("datedChangelog refuses a changelog without an Unreleased section", () => {
	const released = datedChangelog(
		RELAY_CHANGELOG,
		"relay",
		"0.10.0",
		"2026-11-13",
	);
	expect(() =>
		datedChangelog(released, "relay", "0.11.0", "2026-11-14"),
	).toThrow(
		'packages/tab-mcp/CHANGELOG.md: the first section is not "## Unreleased"',
	);
	// A "### Unreleased" under a version is not the package's Unreleased.
	expect(() =>
		datedChangelog(
			"# C\n\n## [0.1.0][relay-0.1.0] - 2026-11-13\n\n### Unreleased\n",
			"relay",
			"0.2.0",
			"2026-11-14",
		),
	).toThrow("is not");
});

test("each package's changelog names its current version first, with a link for every version", async () => {
	const root = join(import.meta.dir, "..");
	for (const pkg of ["client", "relay"] as const) {
		const path = changelogPath(pkg);
		const text = await Bun.file(join(root, path)).text();
		const { version } = (await Bun.file(
			join(root, path.replace("CHANGELOG.md", "package.json")),
		).json()) as { version: string };
		const headings = [...text.matchAll(/^## (.*)$/gm)].map((m) => m[1] ?? "");
		const released = headings.filter((h) => h !== "Unreleased");
		expect(headings.indexOf("Unreleased")).toBeLessThanOrEqual(0);
		expect(released[0]).toStartWith(`[${version}][${pkg}-${version}] - `);
		for (const h of released) {
			const m = /^\[([^\]]+)\]\[([^\]]+)\] - \d{4}-\d{2}-\d{2}$/.exec(h);
			expect(m?.[2], `${path}: ${h}`).toBe(`${pkg}-${m?.[1]}`);
			expect(text, `${path}: link for ${h}`).toContain(
				`\n[${m?.[2]}]: https://`,
			);
		}
	}
});
