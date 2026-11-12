/**
 * The store build (`--store`): what goes to the Chrome Web Store carries no
 * key, no host access granted at install and no source maps (iteration 23).
 */

import { afterAll, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	build,
	sourceDate,
	storeProblems,
	storeZipName,
	zipStoreBuild,
} from "../scripts/build.ts";
import { writeZip, zipNames } from "../scripts/zip.ts";

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

test("the store zip lists the store build's files, without source maps", async () => {
	const { outdir, manifest } = await build({
		outdir: join(dir, "store-zip"),
		store: true,
	});
	const target = join(dir, storeZipName(String(manifest["version"])));
	expect(storeZipName("0.1.0")).toBe("tab-mcp-for-chrome-0.1.0-store.zip");
	await zipStoreBuild(outdir, target);
	const names = zipNames(new Uint8Array(await Bun.file(target).arrayBuffer()));
	expect(names).toContain("manifest.json");
	expect(names).toContain("background.js");
	expect(names).toContain("sidepanel/index.html");
	expect(names).toContain("LICENSES.txt");
	expect(names.filter((name) => name.endsWith(".map"))).toEqual([]);
	// The zipped manifest is the store build's: no key, no host access.
	// unzip (macOS and the CI runners have it) checks every entry's CRC.
	expect(Bun.spawnSync(["unzip", "-tq", target]).exitCode).toBe(0);
	const unzipped = Bun.spawnSync(["unzip", "-p", target, "manifest.json"]);
	expect(unzipped.exitCode).toBe(0);
	const zipped = JSON.parse(unzipped.stdout.toString()) as Record<
		string,
		unknown
	>;
	expect(zipped["key"]).toBeUndefined();
	expect(zipped["host_permissions"]).toBeUndefined();
	expect(zipped["version"]).toBe(manifest["version"]);
	// The same build packs to the same bytes (sourceDate, UTC times).
	const again = join(dir, "again.zip");
	await zipStoreBuild(outdir, again);
	expect(Bun.hash(await Bun.file(again).arrayBuffer())).toBe(
		Bun.hash(await Bun.file(target).arrayBuffer()),
	);
}, 60_000);

test("the zip's time is SOURCE_DATE_EPOCH, else the last commit's", async () => {
	expect(
		(await sourceDate({ SOURCE_DATE_EPOCH: "1700000000" })).toISOString(),
	).toBe("2023-11-14T22:13:20.000Z");
	const commit = await sourceDate({});
	expect(commit.getTime()).toBeGreaterThan(Date.UTC(2026, 0, 1));
});

test("a manifest that is not a JSON object is not packed", async () => {
	const broken = join(dir, "broken");
	await Bun.write(join(broken, "manifest.json"), "{ cut");
	await Bun.write(join(broken, "background.js"), "");
	await expect(zipStoreBuild(broken, join(dir, "broken.zip"))).rejects.toThrow(
		"not a store build: manifest.json is not a JSON object",
	);
	await Bun.write(join(broken, "manifest.json"), "[]");
	await expect(zipStoreBuild(broken, join(dir, "broken.zip"))).rejects.toThrow(
		"manifest.json is not a JSON object",
	);
});

test("a build with a key, host access or source maps is not packed for the store", async () => {
	expect(storeProblems({ key: "x" }, ["manifest.json"])).toEqual([
		"the manifest has a key",
	]);
	expect(
		storeProblems({ host_permissions: ["<all_urls>"] }, ["manifest.json"]),
	).toEqual(["the manifest has host_permissions"]);
	expect(storeProblems({}, ["manifest.json", "background.js.map"])).toEqual([
		"source map background.js.map",
	]);
	expect(storeProblems({}, ["background.js"])).toEqual(["no manifest.json"]);
	// The test build has host access and source maps: zipping it fails.
	const { outdir } = await build({ outdir: join(dir, "test-zip"), test: true });
	const target = join(dir, "refused.zip");
	await expect(zipStoreBuild(outdir, target)).rejects.toThrow(
		/not a store build: the manifest has host_permissions; source map/,
	);
	expect(await Bun.file(target).exists()).toBe(false);
}, 60_000);

test("the zip writer round-trips names and contents", async () => {
	const text = new TextEncoder().encode("a".repeat(1000));
	const zip = await writeZip([
		{ name: "a.txt", data: text },
		{ name: "dir/b.png", data: new Uint8Array([1, 2, 3]) },
	]);
	expect(zipNames(zip)).toEqual(["a.txt", "dir/b.png"]);
	await expect(
		writeZip([
			{ name: "a", data: text },
			{ name: "a", data: text },
		]),
	).rejects.toThrow("duplicate entry: a");
	const path = join(dir, "round.zip");
	await Bun.write(path, zip);
	const unzipped = Bun.spawnSync(["unzip", "-p", path, "a.txt"]);
	expect(unzipped.exitCode).toBe(0);
	expect(unzipped.stdout.toString()).toBe("a".repeat(1000));
	const png = Bun.spawnSync(["unzip", "-p", path, "dir/b.png"]);
	expect([...new Uint8Array(png.stdout)]).toEqual([1, 2, 3]);
});

test("--zip without --store is refused", () => {
	const run = Bun.spawnSync(
		[process.execPath, join(import.meta.dir, "../scripts/build.ts"), "--zip"],
		{ stderr: "pipe" },
	);
	expect(run.exitCode).toBe(2);
	expect(run.stderr.toString()).toContain("add --store");
});
