import { expect, test } from "bun:test";
import {
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

const CHANGELOG = `# Changelog

## @ractive-ch/tab-mcp-client

### Unreleased

#### Added

- x

### [0.13.0][client-0.13.0] - 2026-11-12

## @ractive-ch/tab-mcp

The relay. Each relay release is also a Docker image.

### Unreleased

### [0.9.0][relay-0.9.0] - 2026-11-11

[client-0.13.0]: https://github.com/ractive/tab-mcp/releases/tag/client-v0.13.0
[relay-0.9.0]: https://github.com/ractive/tab-mcp/releases/tag/relay-v0.9.0
`;

test("datedChangelog dates the package's Unreleased section and adds its link", () => {
	const out = datedChangelog(CHANGELOG, "relay", "0.10.0", "2026-11-13");
	expect(out).toContain(
		"## @ractive-ch/tab-mcp\n\nThe relay. Each relay release is also a Docker image.\n\n### [0.10.0][relay-0.10.0] - 2026-11-13\n",
	);
	expect(out).toContain("## @ractive-ch/tab-mcp-client\n\n### Unreleased\n");
	expect(out).toContain(
		"[relay-0.10.0]: https://github.com/ractive/tab-mcp/releases/tag/relay-v0.10.0\n[relay-0.9.0]:",
	);
});

test("datedChangelog refuses a package without an Unreleased section", () => {
	const released = datedChangelog(CHANGELOG, "client", "0.14.0", "2026-11-13");
	expect(() =>
		datedChangelog(released, "client", "0.15.0", "2026-11-14"),
	).toThrow('is not "### Unreleased"');
});
