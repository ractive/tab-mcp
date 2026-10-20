/**
 * Pack a built npm package and check the tarball before it is signed or
 * published (DEC-055). Used by the release workflow and the pull-request
 * dry run; runs locally too:
 *
 *   bun run --cwd packages/tab-mcp-client build
 *   bun scripts/npm-pack.ts client --out /tmp/pack
 *   bun run --cwd packages/tab-mcp build
 *   bun scripts/npm-pack.ts relay --out /tmp/pack-relay
 *
 * Options: `--version V` (must equal the package version), `--release-tag T`
 * (must be `<prefix>v<version>`), `--prerelease true|false` (the GitHub
 * release's flag, must match the version). Writes `<out>/<tarball>.tgz` and
 * `<out>/pack.json` (npm's pack report for it) and, on GitHub Actions, the outputs
 * `name`, `version`, `dist_tag`, `tarball` and `integrity`.
 */

import { appendFileSync, mkdirSync, readdirSync } from "node:fs";
import { join, sep } from "node:path";
import { parseArgs } from "node:util";

/** The exact repository URL npm compares with the provenance statement. */
export const REPOSITORY_URL = "git+https://github.com/ractive/tab-mcp.git";

interface PackageSpec {
	name: string;
	/** Workspace directory; its `package.json` holds the version. */
	workspace: string;
	/** Built directory to pack, relative to the workspace. */
	dist: string;
	/** Git tag prefix of its GitHub releases (`client-v0.1.0`). */
	tagPrefix: string;
	exports: unknown;
	types: string;
	/** `bin` of the published package.json, if it has commands. */
	bin?: Record<string, string>;
	/** Files in the tarball, chunk hashes written as `[hash]`. */
	files: string[];
	/** Each `.ts` file under here (tests excluded) ships a `.d.ts`. */
	declarationsFrom: string;
	/** Source files (relative to `declarationsFrom`) that ship no `.d.ts`. */
	noDeclarations?: string[];
}

/** Packages this script knows. */
export const PACKAGES: Record<string, PackageSpec> = {
	client: {
		name: "@ractive-ch/tab-mcp-client",
		workspace: "packages/tab-mcp-client",
		dist: "dist",
		tagPrefix: "client-v",
		exports: {
			".": { types: "./index.d.ts", default: "./index.js" },
			"./cdn": "./cdn/tab-mcp-client.min.js",
		},
		types: "./index.d.ts",
		files: [
			"AI_NOTICE",
			"LICENSE",
			"README.md",
			"THIRD-PARTY-NOTICES.txt",
			"package.json",
			"index.js",
			"index.js.map",
			"connection-[hash].js",
			"connection-[hash].js.map",
			"ui-[hash].js",
			"ui-[hash].js.map",
			"cdn/tab-mcp-client.min.js",
			"cdn/tab-mcp-client.min.js.map",
			"cdn/connection-[hash].min.js",
			"cdn/connection-[hash].min.js.map",
			"cdn/ui-[hash].min.js",
			"cdn/ui-[hash].min.js.map",
		],
		declarationsFrom: "src",
	},
	relay: {
		name: "@ractive-ch/tab-mcp",
		workspace: "packages/tab-mcp",
		dist: "dist",
		tagPrefix: "relay-v",
		exports: {
			".": { types: "./index.d.ts", default: "./index.js" },
			"./testing": { types: "./testing.d.ts", default: "./testing.js" },
		},
		types: "./index.d.ts",
		bin: { "tab-mcp": "./main.js" },
		files: [
			"AI_NOTICE",
			"LICENSE",
			"README.md",
			"package.json",
			"main.js",
			"main.js.map",
			"index.js",
			"index.js.map",
			"testing.js",
			"testing.js.map",
		],
		declarationsFrom: "src",
		noDeclarations: ["main.ts"],
	},
};

/** Allowed dist-tags for pre-releases; a stable version goes to `latest`. */
const PRERELEASE_TAGS = new Set(["alpha", "beta", "rc"]);

/**
 * The npm dist-tag for a version: `latest` for a stable version, else the
 * pre-release name (`0.1.0-alpha.0` → `alpha`). Never `latest` for a
 * pre-release.
 */
export function distTag(version: string): string {
	const match =
		/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?$/.exec(
			version,
		);
	if (match === null) throw new Error(`not a release version: ${version}`);
	const pre = match[4];
	if (pre === undefined) return "latest";
	const name = /^[a-z]+/.exec(pre)?.[0] ?? "";
	if (!PRERELEASE_TAGS.has(name)) {
		throw new Error(
			`pre-release ${version} must start with one of ${[...PRERELEASE_TAGS].join(", ")}`,
		);
	}
	return name;
}

/** `connection-1gf7vqz2.js` → `connection-[hash].js`. */
export function normalizeChunk(path: string): string {
	return path.replace(/-[a-z0-9]{8}(?=(?:\.min)?\.js(?:\.map)?$)/, "-[hash]");
}

/** Problems with a package.json that is about to be published. */
export function checkManifest(
	pkg: Record<string, unknown>,
	spec: PackageSpec,
	version: string,
): string[] {
	const problems: string[] = [];
	const expect = (key: string, actual: unknown, wanted: unknown) => {
		if (JSON.stringify(actual) !== JSON.stringify(wanted))
			problems.push(
				`${key} is ${JSON.stringify(actual)}, expected ${JSON.stringify(wanted)}`,
			);
	};
	expect("name", pkg["name"], spec.name);
	expect("version", pkg["version"], version);
	expect("license", pkg["license"], "MIT");
	expect("type", pkg["type"], "module");
	expect("exports", pkg["exports"], spec.exports);
	expect("types", pkg["types"], spec.types);
	expect("bin", pkg["bin"], spec.bin);
	expect("publishConfig", pkg["publishConfig"], { access: "public" });
	const repository = pkg["repository"] as Record<string, unknown> | undefined;
	expect("repository.url", repository?.["url"], REPOSITORY_URL);
	expect("repository.directory", repository?.["directory"], spec.workspace);
	if (pkg["private"] !== undefined) problems.push("private must not be set");
	if (pkg["scripts"] !== undefined)
		problems.push("scripts must not be set (nothing runs on install)");
	for (const field of [
		"dependencies",
		"peerDependencies",
		"optionalDependencies",
	]) {
		const deps = (pkg[field] ?? {}) as Record<string, string>;
		for (const [dep, range] of Object.entries(deps)) {
			if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(range))
				problems.push(
					`${field}.${dep} is "${range}", expected an exact version`,
				);
		}
	}
	return problems;
}

/** One package in `npm pack --json`'s report. */
interface PackResult {
	name: string;
	version: string;
	filename: string;
	integrity: string;
	files: { path: string }[];
}

async function main() {
	const { values, positionals } = parseArgs({
		args: Bun.argv.slice(2),
		allowPositionals: true,
		options: {
			out: { type: "string" },
			version: { type: "string" },
			"release-tag": { type: "string" },
			prerelease: { type: "string" },
		},
	});
	const key = positionals[0] ?? "";
	const spec = PACKAGES[key];
	if (spec === undefined || positionals.length !== 1 || !values.out) {
		throw new Error(
			`usage: bun scripts/npm-pack.ts <${Object.keys(PACKAGES).join("|")}> --out DIR [--version V] [--release-tag T] [--prerelease true|false]`,
		);
	}
	const root = join(import.meta.dir, "..");
	const workspace = join(root, spec.workspace);
	const dist = join(workspace, spec.dist);
	const problems: string[] = [];

	const source = (await Bun.file(join(workspace, "package.json")).json()) as {
		version: string;
	};
	const version = source.version;
	const tag = distTag(version);
	if (values.version !== undefined && values.version !== version)
		problems.push(
			`requested version ${values.version}, package has ${version}`,
		);
	const releaseTag = values["release-tag"];
	if (releaseTag !== undefined && releaseTag !== `${spec.tagPrefix}${version}`)
		problems.push(
			`release tag ${releaseTag} does not match ${spec.tagPrefix}${version}`,
		);
	if (values.prerelease !== undefined) {
		const isPre = tag !== "latest";
		if (values.prerelease !== String(isPre))
			problems.push(
				`the GitHub release is ${values.prerelease === "true" ? "" : "not "}marked as a pre-release, but ${version} is ${isPre ? "" : "not "}one`,
			);
	}

	const manifest = (await Bun.file(
		join(dist, "package.json"),
	).json()) as Record<string, unknown>;
	problems.push(...checkManifest(manifest, spec, version));
	if (problems.length > 0) fail(problems);

	mkdirSync(values.out, { recursive: true });
	if (readdirSync(values.out).some((f) => f.endsWith(".tgz")))
		fail([`${values.out} already holds a tarball`]);
	const pack = Bun.spawnSync(
		["npm", "pack", dist, "--json", "--pack-destination", values.out],
		{ stderr: "inherit" },
	);
	if (pack.exitCode !== 0) fail(["npm pack failed"]);
	// npm 11 prints an array of results, npm 12 an object keyed by name.
	const parsed = JSON.parse(pack.stdout.toString()) as unknown;
	const report = (
		Array.isArray(parsed) ? parsed : Object.values(parsed as object)
	) as PackResult[];
	const [packed] = report;
	if (report.length !== 1 || packed === undefined)
		fail([`npm pack reported ${report.length} packages`]);
	await Bun.write(
		join(values.out, "pack.json"),
		`${JSON.stringify(packed, null, 2)}\n`,
	);
	const tarball = join(values.out, packed.filename);
	if (packed.name !== spec.name || packed.version !== version)
		problems.push(`packed ${packed.name}@${packed.version}`);

	// The file list, with chunk hashes normalised and declarations derived.
	const declarations = readdirSync(join(workspace, spec.declarationsFrom), {
		recursive: true,
		encoding: "utf8",
	})
		.map((f) => f.split(sep).join("/"))
		.filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
		.filter((f) => !spec.noDeclarations?.includes(f))
		.map((f) => f.replace(/\.ts$/, ".d.ts"));
	const expected = [...spec.files, ...declarations].sort();
	const actual = packed.files.map((f) => normalizeChunk(f.path)).sort();
	const missing = expected.filter((f) => !actual.includes(f));
	const extra = actual.filter((f) => !expected.includes(f));
	if (missing.length > 0) problems.push(`missing files: ${missing.join(", ")}`);
	if (extra.length > 0) problems.push(`unexpected files: ${extra.join(", ")}`);

	// The package.json inside the tarball is the one npm will publish.
	const inner = Bun.spawnSync([
		"tar",
		"-xzOf",
		tarball,
		"package/package.json",
	]);
	if (inner.exitCode !== 0) fail(["cannot read package.json from the tarball"]);
	problems.push(
		...checkManifest(JSON.parse(inner.stdout.toString()), spec, version).map(
			(p) => `tarball: ${p}`,
		),
	);
	if (problems.length > 0) fail(problems);

	const outputs = {
		name: spec.name,
		version,
		dist_tag: tag,
		tarball,
		integrity: packed.integrity,
	};
	for (const [k, v] of Object.entries(outputs)) console.log(`${k}=${v}`);
	console.log(`files: ${packed.files.length}, all as expected`);
	const githubOutput = process.env["GITHUB_OUTPUT"];
	if (githubOutput) {
		appendFileSync(
			githubOutput,
			Object.entries(outputs)
				.map(([k, v]) => `${k}=${v}\n`)
				.join(""),
		);
	}
}

function fail(problems: string[]): never {
	for (const p of problems) console.error(`npm-pack: ${p}`);
	process.exit(1);
}

if (import.meta.main) await main();
