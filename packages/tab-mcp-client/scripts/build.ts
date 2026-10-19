/**
 * Build the npm package layout into `dist/` (not published yet, DEC-024):
 *
 * - `dist/*.js`: ESM for bundlers (`--packages=external`), split so that the
 *   connection and the UI stay separate chunks loaded by `connect()`;
 * - `dist/*.d.ts`: declarations from `tsc` with `isolatedDeclarations`;
 * - `dist/cdn/`: a minified, self-contained build for `<script type="module">`;
 * - `dist/package.json`, README, LICENSE, AI_NOTICE: the directory to pack.
 *
 * Prints the gzipped sizes of the core and the lazily loaded chunks.
 */

import { rm } from "node:fs/promises";
import { join } from "node:path";
import { $ } from "bun";

const root = join(import.meta.dir, "..");
const dist = join(root, "dist");
const entry = join(root, "src/index.ts");

await rm(dist, { recursive: true, force: true });

const common = {
	entrypoints: [entry],
	target: "browser",
	format: "esm",
	splitting: true,
} as const;

const npm = await Bun.build({
	...common,
	outdir: dist,
	sourcemap: "linked",
	packages: "external",
	naming: { entry: "[name].js", chunk: "[name]-[hash].js" },
});
const cdn = await Bun.build({
	...common,
	outdir: join(dist, "cdn"),
	minify: true,
	sourcemap: "linked",
	naming: { entry: "tab-mcp-client.min.js", chunk: "[name]-[hash].min.js" },
});
for (const result of [npm, cdn]) {
	if (!result.success) {
		for (const log of result.logs) console.error(log);
		process.exit(1);
	}
}

// Declarations; the `.ts` specifiers in them become `.js` like the code.
await $`bunx tsc -p ${join(root, "tsconfig.build.json")}`;
for await (const file of new Bun.Glob("*.d.ts").scan(dist)) {
	const path = join(dist, file);
	const text = await Bun.file(path).text();
	await Bun.write(path, text.replace(/(from\s+"\.\/[^"]+)\.ts"/g, '$1.js"'));
}

// The package to pack: package.json pointing at the built files.
const pkg = (await Bun.file(join(root, "package.json")).json()) as Record<
	string,
	unknown
>;
const published = {
	name: pkg["name"],
	version: pkg["version"],
	description: pkg["description"],
	type: "module",
	exports: {
		".": { types: "./index.d.ts", default: "./index.js" },
		"./cdn": "./cdn/tab-mcp-client.min.js",
	},
	types: "./index.d.ts",
	sideEffects: false,
	license: pkg["license"],
	author: pkg["author"],
	repository: pkg["repository"],
	homepage: pkg["homepage"],
	bugs: pkg["bugs"],
	keywords: pkg["keywords"],
	dependencies: pkg["dependencies"],
};
await Bun.write(
	join(dist, "package.json"),
	`${JSON.stringify(published, null, "\t")}\n`,
);
for (const [from, to] of [
	[join(root, "../../LICENSE"), "LICENSE"],
	[join(root, "../../AI_NOTICE"), "AI_NOTICE"],
	[join(root, "README.md"), "README.md"],
] as const) {
	const file = Bun.file(from);
	if (await file.exists()) await Bun.write(join(dist, to), file);
}

// Sizes: the CDN build is what a page pays (dependencies included).
const sizes: [string, number, number][] = [];
for (const output of cdn.outputs) {
	if (output.kind === "sourcemap") continue;
	const bytes = new Uint8Array(await output.arrayBuffer());
	sizes.push([
		output.path.slice(dist.length + 1),
		bytes.length,
		Bun.gzipSync(bytes).length,
	]);
}
const kb = (n: number) => `${(n / 1024).toFixed(1)} KB`;
console.log("CDN build (minified / gzipped):");
for (const [path, min, gz] of sizes)
	console.log(
		`  ${path.padEnd(40)} ${kb(min).padStart(9)} ${kb(gz).padStart(9)}`,
	);
