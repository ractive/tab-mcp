/**
 * Builds the unpacked extension into `dist/` (or `--outdir`), after
 * Overmark's `scripts/build.ts`.
 *
 *   bun scripts/build.ts          development build with the owner's key, so
 *                                 its id is the one the hosted relay allows
 *   bun scripts/build.ts --test   no key, host access to every http(s) site
 *                                 at install (end-to-end tests: no click on
 *                                 the icon), and the hooks the tests answer
 *                                 notifications with (only this build)
 *   bun scripts/build.ts --store  no key and no source maps, for the Chrome
 *                                 Web Store, into `dist-store/` (so it does
 *                                 not replace a development build in `dist/`)
 *   bun scripts/build.ts --store --zip
 *                                 also packs tab-mcp-for-chrome-<version>-store.zip
 *                                 (`--zip` only with `--store`: a zip of the
 *                                 development build would carry the key)
 *
 * The key is not in the repository: anyone with it could load an extension
 * with the development build's id and use the hosted relay as it. It is read
 * from `TAB_MCP_EXTENSION_KEY_FILE`, else `~/.config/tab-mcp/extension-key.txt`;
 * without it the development build gets an id of its own.
 */

import { readdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import { CONTENT_SCRIPT } from "../src/messages.ts";
import { SITE_MATCHES } from "../src/tabs.ts";
import { ICON_SIZES } from "./icons.ts";
import { writeZip, zipNames } from "./zip.ts";

const ROOT = join(import.meta.dir, "..");
const REPOSITORY = join(ROOT, "../..");

export interface BuildOptions {
	outdir?: string;
	/** No key, for the Chrome Web Store. */
	store?: boolean;
	/** No key, host access to every http(s) site granted at install. */
	test?: boolean;
	minify?: boolean;
}

export interface BuildResult {
	outdir: string;
	manifest: Record<string, unknown>;
	/** The id the key gives; `undefined` without a key. */
	id: string | undefined;
}

/** The extension id Chrome derives from a public key (base64 DER). */
export function extensionId(base64Key: string): string {
	const der = Buffer.from(base64Key, "base64");
	const hex = new Bun.CryptoHasher("sha256").update(der).digest("hex");
	return [...hex.slice(0, 32)]
		.map((c) => String.fromCharCode(97 + Number.parseInt(c, 16)))
		.join("");
}

/** The owner's key, or `undefined` if this machine has none. */
export async function readKey(): Promise<string | undefined> {
	const path =
		process.env["TAB_MCP_EXTENSION_KEY_FILE"] ??
		join(homedir(), ".config/tab-mcp/extension-key.txt");
	const file = Bun.file(path);
	return (await file.exists()) ? (await file.text()).trim() : undefined;
}

/** The licences of all that a build contains, in the build. */
export const NOTICES_FILE = "LICENSES.txt";

const CLIENT = "packages/tab-mcp-client";

/** Where each bundled package's licence is, from the repository's root. */
const LICENCES: Readonly<Record<string, string>> = {
	"@cfworker/json-schema": `${CLIENT}/THIRD-PARTY-NOTICES.txt`,
};

/** The licence in a notice file; one without an MIT text stops the build. */
export function mitText(name: string, file: string): string {
	const start = file.indexOf("MIT License");
	if (start < 0) throw new Error(`no MIT licence text for ${name}`);
	return file.slice(start);
}

/** tab-mcp's licence and those of `packages`; a package without one stops the build. */
export async function notices(packages: Iterable<string>): Promise<string> {
	const text = (path: string) => Bun.file(join(REPOSITORY, path)).text();
	const parts = [
		`tab-mcp for Chrome (with @ractive-ch/tab-mcp-client)\n\n${await text("LICENSE")}\n${await text("AI_NOTICE")}`,
	];
	for (const name of [...packages].sort()) {
		const path = LICENCES[name];
		if (path === undefined)
			throw new Error(`no licence known for the bundled package ${name}`);
		parts.push(`${name}\n\n${mitText(name, await text(path))}`);
	}
	return parts.join(`\n${"-".repeat(78)}\n\n`);
}

export function createManifest(
	version: string,
	options: { key?: string; test?: boolean },
): Record<string, unknown> {
	const icons = Object.fromEntries(
		ICON_SIZES.map((s) => [String(s), `icons/icon-${s}.png`]),
	);
	return {
		manifest_version: 3,
		name: "tab-mcp for Chrome",
		version,
		description:
			"Lets an AI app outside the browser call the WebMCP tools of the page in front and open pages in that tab, through a tab-mcp relay.",
		minimum_chrome_version: "116",
		icons,
		action: { default_title: "tab-mcp for Chrome", default_icon: icons },
		background: { service_worker: "background.js", type: "module" },
		side_panel: { default_path: "sidepanel/index.html" },
		permissions: [
			"activeTab",
			"alarms",
			"notifications",
			"scripting",
			"sidePanel",
		],
		// Sites only: http(s), the pages "allowed" and the navigation rules
		// know (ES 9). Not `file:` pages.
		optional_host_permissions: SITE_MATCHES,
		...(options.test ? { host_permissions: SITE_MATCHES } : {}),
		// Incognito tabs are not offered to the AI app, even where the user
		// allows the extension there.
		incognito: "not_allowed",
		...(options.key ? { key: options.key } : {}),
	};
}

/** How every entry point is bundled. */
interface BundleOptions {
	minify: boolean;
	sourcemap: "none" | "linked";
	/** The test build: its hooks for the DevTools Protocol are in. */
	test: boolean;
}

/** Bundle one entry point; returns the npm packages it contains. */
async function bundle(
	entrypoint: string,
	outdir: string,
	format: "esm" | "iife",
	options: BundleOptions,
	naming?: string,
): Promise<string[]> {
	const result = await Bun.build({
		entrypoints: [join(ROOT, entrypoint)],
		outdir,
		target: "browser",
		format,
		...(naming ? { naming } : {}),
		minify: options.minify,
		splitting: format === "esm" && entrypoint.endsWith(".html"),
		sourcemap: options.sourcemap,
		metafile: true,
		// The test hooks are code only in the test build (ES 7).
		define: { TAB_MCP_TEST: String(options.test) },
	});
	if (!result.success)
		throw new AggregateError(result.logs, `build of ${entrypoint} failed`);
	return Object.keys(result.metafile?.inputs ?? {}).flatMap(
		// The last `node_modules/`: Bun's isolated installs nest them in `.bun/`.
		(path) => /.*node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(path)?.[1] ?? [],
	);
}

/**
 * Refuse to empty a directory that is not a build: the repository, one of its
 * parents, or a folder with other files in it and no `manifest.json`.
 */
export async function checkOutdir(outdir: string): Promise<void> {
	const target = resolve(outdir);
	if (`${ROOT}${sep}`.startsWith(`${target}${sep}`))
		throw new Error(`refusing to empty ${target}: it holds the package`);
	let names: string[];
	try {
		names = await readdir(target);
	} catch (error) {
		if ((error as { code?: string }).code === "ENOENT") return;
		throw new Error(`refusing to use ${target}: ${String(error)}`);
	}
	if (names.length > 0 && !names.includes("manifest.json"))
		throw new Error(
			`refusing to empty ${target}: not empty and not a build (no manifest.json)`,
		);
}

export async function build(options: BuildOptions = {}): Promise<BuildResult> {
	const outdir = resolve(
		options.outdir ?? join(ROOT, options.store ? "dist-store" : "dist"),
	);
	await checkOutdir(outdir);
	const minify = options.minify ?? true;
	// The store package carries no source maps (iteration 23).
	const sourcemap = options.store ? "none" : "linked";
	const pkg = (await Bun.file(join(ROOT, "package.json")).json()) as {
		version: string;
	};
	await rm(outdir, { recursive: true, force: true });
	const how: BundleOptions = {
		minify,
		sourcemap,
		test: options.test === true,
	};
	const packages = new Set([
		...(await bundle("src/background.ts", outdir, "esm", how)),
		...(await bundle("src/content.ts", outdir, "iife", how, CONTENT_SCRIPT)),
		...(await bundle(
			"src/sidepanel/index.html",
			join(outdir, "sidepanel"),
			"esm",
			how,
		)),
		// A question's own window, where the side panel could not open.
		...(await bundle(
			"src/question/index.html",
			join(outdir, "question"),
			"esm",
			how,
		)),
	]);
	await Bun.write(join(outdir, NOTICES_FILE), await notices(packages));
	for (const size of ICON_SIZES) {
		const name = `icon-${size}.png`;
		await Bun.write(
			join(outdir, "icons", name),
			Bun.file(join(ROOT, "assets/icons", name)),
		);
	}
	const key = options.store || options.test ? undefined : await readKey();
	const manifest = createManifest(pkg.version, {
		...(key ? { key } : {}),
		...(options.test ? { test: true } : {}),
	});
	await Bun.write(
		join(outdir, "manifest.json"),
		`${JSON.stringify(manifest, null, "\t")}\n`,
	);
	return { outdir, manifest, id: key ? extensionId(key) : undefined };
}

/** The store package's file name for `version`. */
export function storeZipName(version: string): string {
	return `tab-mcp-for-chrome-${version}-store.zip`;
}

/** What only the test build's scripts contain: its hooks for the DevTools Protocol. */
export const TEST_HOOK = "tabMcpNotification";

/**
 * What the Chrome Web Store must not get: a `key` (the store gives the item
 * its own), host access granted at install, source maps, or the test build's
 * hooks in a script (`scripts`: the text of each script by its name).
 * Returns the problems; none means the package may go to the store.
 */
export function storeProblems(
	manifest: Record<string, unknown>,
	names: readonly string[],
	scripts: Readonly<Record<string, string>> = {},
): string[] {
	const problems: string[] = [];
	if ("key" in manifest) problems.push("the manifest has a key");
	if ("host_permissions" in manifest)
		problems.push("the manifest has host_permissions");
	for (const name of names.filter((n) => n.endsWith(".map")))
		problems.push(`source map ${name}`);
	if (!names.includes("manifest.json")) problems.push("no manifest.json");
	for (const [name, text] of Object.entries(scripts))
		if (text.includes(TEST_HOOK)) problems.push(`test hooks in ${name}`);
	return problems;
}

async function filesOf(dir: string): Promise<string[]> {
	const entries = await readdir(dir, { recursive: true, withFileTypes: true });
	return entries
		.filter((e) => e.isFile())
		.map((e) => relative(dir, join(e.parentPath, e.name)).split(sep).join("/"))
		.sort();
}

/**
 * The time a reproducible zip carries: `SOURCE_DATE_EPOCH` (seconds), else
 * the time of the repository's last commit, else 1980-01-01. The same commit
 * then gives the same zip, byte for byte, so a release's zip can be rebuilt
 * and compared with the hash its workflow prints.
 */
export async function sourceDate(
	env: Record<string, string | undefined> = process.env,
): Promise<Date> {
	const epoch = env["SOURCE_DATE_EPOCH"];
	if (epoch !== undefined && /^\d+$/.test(epoch))
		return new Date(Number(epoch) * 1000);
	const git = Bun.spawnSync(["git", "log", "-1", "--format=%ct"], {
		cwd: REPOSITORY,
		stderr: "ignore",
	});
	const seconds = git.stdout.toString().trim();
	if (git.exitCode === 0 && /^\d+$/.test(seconds))
		return new Date(Number(seconds) * 1000);
	return new Date(Date.UTC(1980, 0, 1));
}

/**
 * Pack a store build into `target`. A build that fails `storeProblems`, or
 * a zip that does not list the build's files, stops it.
 */
export async function zipStoreBuild(
	outdir: string,
	target: string,
): Promise<string[]> {
	const names = await filesOf(outdir);
	const before: string[] = [];
	let manifest: Record<string, unknown> = {};
	if (names.includes("manifest.json")) {
		const parsed: unknown = await Bun.file(join(outdir, "manifest.json"))
			.json()
			.catch(() => undefined);
		if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed))
			manifest = parsed as Record<string, unknown>;
		else before.push("manifest.json is not a JSON object");
	}
	const scripts: Record<string, string> = {};
	for (const name of names.filter((n) => n.endsWith(".js")))
		scripts[name] = await Bun.file(join(outdir, name)).text();
	before.push(...storeProblems(manifest, names, scripts));
	if (before.length > 0)
		throw new Error(`not a store build: ${before.join("; ")}`);
	const entries = [];
	for (const name of names)
		entries.push({
			name,
			data: new Uint8Array(await Bun.file(join(outdir, name)).arrayBuffer()),
		});
	const zip = await writeZip(entries, { date: await sourceDate() });
	const packed = zipNames(zip);
	if (packed.join("\n") !== names.join("\n"))
		throw new Error("the zip does not list the build's files");
	await Bun.write(target, zip);
	return packed;
}

if (import.meta.main) {
	const { values } = parseArgs({
		options: {
			store: { type: "boolean" },
			test: { type: "boolean" },
			zip: { type: "boolean" },
			outdir: { type: "string" },
		},
	});
	if (values.zip && !values.store) {
		console.error("--zip packs only the store build: add --store");
		process.exit(2);
	}
	const result = await build({
		...(values.outdir ? { outdir: values.outdir } : {}),
		...(values.store ? { store: true } : {}),
		...(values.test ? { test: true } : {}),
	});
	const where = relative(process.cwd(), result.outdir) || ".";
	console.log(
		result.id
			? `Built ${where} (extension ID ${result.id})`
			: values.store || values.test
				? `Built ${where} (no key)`
				: `Built ${where} without a key: no ~/.config/tab-mcp/extension-key.txt, so the hosted relay will not accept this build's id`,
	);
	if (values.zip) {
		const target = join(ROOT, storeZipName(String(result.manifest["version"])));
		await zipStoreBuild(result.outdir, target);
		console.log(`Packed ${relative(process.cwd(), target)}`);
	}
}
