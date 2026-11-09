/**
 * The store build (`--store`): what goes to the Chrome Web Store carries no
 * key, no host access granted at install and no source maps (iteration 23).
 */

import { afterAll, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "../scripts/build.ts";

const dir = await mkdtemp(join(tmpdir(), "tab-mcp-extension-build-"));
afterAll(() => rm(dir, { recursive: true, force: true }));

test("the store build has no key, no host_permissions and no source maps", async () => {
	const { outdir } = await build({ outdir: join(dir, "store"), store: true });
	const manifest = (await Bun.file(
		join(outdir, "manifest.json"),
	).json()) as Record<string, unknown>;
	expect(manifest["key"]).toBeUndefined();
	expect(manifest["host_permissions"]).toBeUndefined();
	const files = await readdir(outdir, { recursive: true });
	expect(files).toContain("background.js");
	expect(files.filter((name) => name.endsWith(".map"))).toEqual([]);
	for (const name of files.filter((name) => /\.(js|css|html)$/.test(name)))
		expect(await Bun.file(join(outdir, name)).text()).not.toContain(
			"sourceMappingURL",
		);
}, 60_000);

test("the test build keeps its source maps", async () => {
	const { outdir } = await build({ outdir: join(dir, "test"), test: true });
	const files = await readdir(outdir, { recursive: true });
	expect(files.some((name) => name.endsWith(".map"))).toBe(true);
}, 60_000);
