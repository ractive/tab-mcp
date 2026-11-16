/**
 * Which real sites register WebMCP tools in Firefox with the Firefox build's
 * `document.modelContext` (iteration 44, question 1). By hand, it needs the
 * network:
 *
 *   bun test/firefox-sites.ts                 the sites below
 *   bun test/firefox-sites.ts https://a.example https://b.example
 *
 * Each site is loaded in headless Firefox with the test build installed (host
 * access granted at install), given `WAIT_MS` to register, and asked for its
 * tools on its own `document.modelContext`: the extension's object, or a
 * page polyfill's that wraps it (`@mcp-b/global` does).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "../scripts/build.ts";
import { Firefox, findFirefox } from "./firefox.ts";

const WAIT_MS = 10_000;

/** From the research note: Shopify (Liquid, Hydrogen) and the docs platforms. */
const SITES = [
	"https://www.allbirds.com/",
	"https://www.gymshark.com/",
	"https://kyliecosmetics.com/",
	"https://www.brooklinen.com/",
	"https://colourpop.com/",
	"https://www.fashionnova.com/",
	"https://launchdarkly.com/docs/home",
	"https://openrouter.ai/docs/quickstart",
	"https://gitbook.com/docs",
	"https://developer.themoviedb.org/docs/getting-started",
];

interface Seen {
	url: string;
	available: boolean;
	wrapped: boolean;
	tools: string[];
	error?: string;
}

const binary = findFirefox();
if (binary === undefined) {
	console.error("no Firefox: set FIREFOX_PATH");
	process.exit(2);
}
const sites = process.argv.slice(2).length > 0 ? process.argv.slice(2) : SITES;
const dir = mkdtempSync(join(tmpdir(), "tab-mcp-firefox-sites-"));
const outdir = join(dir, "dist");
await build({ outdir, firefox: true, test: true });
const firefox = await Firefox.launch(binary);
const results: Seen[] = [];
try {
	await firefox.installExtension(outdir);
	for (const url of sites) {
		try {
			const tab = await firefox.newTab("about:blank");
			await Promise.race([tab.navigate(url), Bun.sleep(30_000)]);
			await Bun.sleep(WAIT_MS);
			const seen = await tab.eval<Omit<Seen, "url">>(`(async () => {
				const context = document.modelContext;
				const own = Object.getOwnPropertyDescriptor(Document.prototype, "modelContext")?.get?.call(document);
				if (!context) return { available: false, wrapped: false, tools: [] };
				const tools = await context.getTools();
				return { available: true, wrapped: context !== own, tools: tools.map((t) => t.name) };
			})()`);
			results.push({ url, ...seen });
			await tab.close();
		} catch (error) {
			results.push({
				url,
				available: false,
				wrapped: false,
				tools: [],
				error: String(error).slice(0, 200),
			});
		}
		const last = results.at(-1) as Seen;
		console.log(
			`${last.url}\t${last.error ? `error: ${last.error}` : `${last.tools.length} tools${last.wrapped ? " (through the page's own polyfill)" : ""}: ${last.tools.join(", ")}`}`,
		);
	}
} finally {
	await firefox.close();
	rmSync(dir, { recursive: true, force: true });
}
console.log(JSON.stringify(results, null, "\t"));
