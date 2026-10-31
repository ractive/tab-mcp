/**
 * Build the relay's npm package into `dist/` (DEC-024, DEC-053, DEC-068); the
 * release workflow packs and publishes this directory (DEC-055):
 *
 * - `dist/main.js` (the `tab-mcp` command, `#!/usr/bin/env bun`),
 *   `dist/index.js` (`createRelay`, the stores, the types) and
 *   `dist/testing.js` (the `TokenStore` conformance suite, and `startTestRelay`
 *   and `tokenFor`, which bundle their own copy of the relay): `bun build
 *   --target=bun`, one self-contained file each (the relay has no runtime
 *   dependencies; `bun:*` modules stay imports);
 * - `dist/**\/*.d.ts`: declarations from `tsc` with `isolatedDeclarations`;
 * - `dist/package.json`, LICENSE, AI_NOTICE, README.md.
 *
 * `--no-declarations` skips `tsc` (the Docker build, which has no
 * `node_modules`, needs only `main.js`).
 */

import { rm } from "node:fs/promises";
import { join } from "node:path";
import { $ } from "bun";

const root = join(import.meta.dir, "..");
const dist = join(root, "dist");
const declarations = !process.argv.includes("--no-declarations");

await rm(dist, { recursive: true, force: true });

const result = await Bun.build({
	entrypoints: ["main", "index", "testing"].map((n) =>
		join(root, `src/${n}.ts`),
	),
	target: "bun",
	format: "esm",
	outdir: dist,
	sourcemap: "linked",
	naming: { entry: "[name].js" },
});
if (!result.success) {
	for (const log of result.logs) console.error(log);
	process.exit(1);
}

// The bin keeps its `#!/usr/bin/env bun` line as the very first line.
const main = await Bun.file(join(dist, "main.js")).text();
if (!main.startsWith("#!/usr/bin/env bun\n")) {
	console.error("dist/main.js does not start with #!/usr/bin/env bun");
	process.exit(1);
}

if (declarations) {
	// The `.ts` specifiers in the declarations become `.js` like the code.
	await $`bunx tsc -p ${join(root, "tsconfig.build.json")}`;
	for await (const file of new Bun.Glob("**/*.d.ts").scan(dist)) {
		const path = join(dist, file);
		const text = await Bun.file(path).text();
		await Bun.write(
			path,
			text.replace(/(["']\.{1,2}\/[^"']+)\.ts(["'])/g, "$1.js$2"),
		);
	}
	// main.ts has no exports; its declaration would be an empty module.
	await rm(join(dist, "main.d.ts"), { force: true });
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
	bin: { "tab-mcp": "./main.js" },
	exports: {
		".": { types: "./index.d.ts", default: "./index.js" },
		"./testing": { types: "./testing.d.ts", default: "./testing.js" },
	},
	types: "./index.d.ts",
	engines: pkg["engines"],
	license: pkg["license"],
	author: pkg["author"],
	repository: pkg["repository"],
	homepage: pkg["homepage"],
	bugs: pkg["bugs"],
	keywords: pkg["keywords"],
	publishConfig: { access: "public" },
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

for (const output of result.outputs) {
	if (output.kind === "sourcemap") continue;
	const kb = (output.size / 1024).toFixed(1);
	console.log(`  ${output.path.slice(dist.length + 1).padEnd(12)} ${kb} KB`);
}
