/**
 * Builds the unpacked extension into `dist/` (or `--outdir`), after
 * Overmark's `scripts/build.ts`.
 *
 *   bun scripts/build.ts          development build with the owner's key, so
 *                                 its id is the one the hosted relay allows
 *   bun scripts/build.ts --test   no key, `<all_urls>` host access at install
 *                                 (end-to-end tests: no click on the icon)
 *   bun scripts/build.ts --store  no key and no source maps, for the Chrome
 *                                 Web Store
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
import { ICON_SIZES } from "./icons.ts";

const ROOT = join(import.meta.dir, "..");
const REPOSITORY = join(ROOT, "../..");

export interface BuildOptions {
	outdir?: string;
	/** No key, for the Chrome Web Store. */
	store?: boolean;
	/** No key, `<all_urls>` granted at install. */
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
			"Offers the WebMCP tools of the page in front to your AI app outside the browser, through a tab-mcp relay.",
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
			"storage",
		],
		optional_host_permissions: ["<all_urls>"],
		...(options.test ? { host_permissions: ["<all_urls>"] } : {}),
		...(options.key ? { key: options.key } : {}),
	};
}

/** Bundle one entry point; returns the npm packages it contains. */
async function bundle(
	entrypoint: string,
	outdir: string,
	format: "esm" | "iife",
	minify: boolean,
	sourcemap: "none" | "linked",
	naming?: string,
): Promise<string[]> {
	const result = await Bun.build({
		entrypoints: [join(ROOT, entrypoint)],
		outdir,
		target: "browser",
		format,
		...(naming ? { naming } : {}),
		minify,
		splitting: format === "esm" && entrypoint.endsWith(".html"),
		sourcemap,
		metafile: true,
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
	const outdir = resolve(options.outdir ?? join(ROOT, "dist"));
	await checkOutdir(outdir);
	const minify = options.minify ?? true;
	// The store package carries no source maps (iteration 23).
	const sourcemap = options.store ? "none" : "linked";
	const pkg = (await Bun.file(join(ROOT, "package.json")).json()) as {
		version: string;
	};
	await rm(outdir, { recursive: true, force: true });
	const packages = new Set([
		...(await bundle("src/background.ts", outdir, "esm", minify, sourcemap)),
		...(await bundle(
			"src/content.ts",
			outdir,
			"iife",
			minify,
			sourcemap,
			CONTENT_SCRIPT,
		)),
		...(await bundle(
			"src/sidepanel/index.html",
			join(outdir, "sidepanel"),
			"esm",
			minify,
			sourcemap,
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

if (import.meta.main) {
	const { values } = parseArgs({
		options: {
			store: { type: "boolean" },
			test: { type: "boolean" },
			outdir: { type: "string" },
		},
	});
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
}
