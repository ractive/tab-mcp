/**
 * Iteration 18's spike: can an extension reach a page's WebMCP tools? Runs
 * the test page and the test extension in Chrome for Testing and prints what
 * each world saw as JSON (kb/research/webmcp-from-extension.md reads it).
 *
 * Run: `bun test/webmcp-spike/spike.ts` with CHROME_PATH set to Chrome for
 * Testing (or one in Puppeteer's or Playwright's cache). The pages are served
 * through the DevTools Protocol on https://spike.test and https://other.test
 * (no server, no network: it runs in a sandbox too); only the polyfill is
 * downloaded, from unpkg.
 */

import {
	generateKeyPairSync,
	type KeyObject,
	sign as signWith,
} from "node:crypto";
import { join } from "node:path";
import {
	Browser,
	findChromeForTesting,
	type Page,
	type Served,
	unpackedExtensionId,
	type Worker,
	type World,
} from "./browser.ts";

/** The switch that turns WebMCP on (see the research note for the others). */
export const WEBMCP_ON = "--enable-features=WebMCP";

const EXTENSION_NAME = "WebMCP spike";
export const extensionDir = join(import.meta.dir, "extension");
const pagesDir = join(import.meta.dir, "pages");

export const SITE = "https://spike.test";
export const OTHER_SITE = "https://other.test";
export const pageUrl = `${SITE}/page.html`;

const POLYFILL = "https://unpkg.com/@mcp-b/global@6.0.3/dist/index.iife.js";
let polyfill: Uint8Array | undefined;

/**
 * Answers the pages' requests: `pages/<name>.html` on both sites
 * (`?trial=<token>` adds an `Origin-Trial` header), the polyfill from a copy
 * downloaded once (the page checks its integrity hash), 404 for the rest.
 */
export async function serve(url: string): Promise<Served> {
	const { origin, pathname, searchParams } = new URL(url);
	if (url === POLYFILL) {
		if (polyfill === undefined) {
			const response = await fetch(POLYFILL);
			if (!response.ok)
				throw new Error(`${POLYFILL} answered ${response.status}`);
			polyfill = new Uint8Array(await response.arrayBuffer());
		}
		return {
			status: 200,
			headers: {
				"content-type": "text/javascript",
				"access-control-allow-origin": "*",
			},
			body: polyfill,
		};
	}
	const name = pathname.slice(1);
	const file = Bun.file(join(pagesDir, name));
	if (
		(origin !== SITE && origin !== OTHER_SITE) ||
		!/^[a-z]+\.html$/.test(name) ||
		!(await file.exists())
	)
		return { status: 404, body: "not found" };
	const trial = searchParams.get("trial");
	return {
		status: 200,
		headers: {
			"content-type": "text/html; charset=utf-8",
			...(trial ? { "origin-trial": trial } : {}),
		},
		body: await file.bytes(),
	};
}

/**
 * An origin trial token (format 3, as Chromium's generate_token.py writes
 * it) signed with our own key; Chrome accepts it with
 * `--origin-trial-public-key=<that key>`. So the spike tries the trial
 * without a token from Google.
 */
export function trialToken(
	privateKey: KeyObject,
	origin: string,
	feature: string,
): string {
	const payload = Buffer.from(
		JSON.stringify({
			origin,
			feature,
			expiry: Math.floor(Date.now() / 1000) + 3600,
		}),
	);
	const version = Buffer.from([3]);
	const length = Buffer.alloc(4);
	length.writeUInt32BE(payload.length);
	const signature = signWith(
		null,
		Buffer.concat([version, length, payload]),
		privateKey,
	);
	return Buffer.concat([version, signature, length, payload]).toString(
		"base64",
	);
}

/** An Ed25519 key pair; the public key as `--origin-trial-public-key` takes it. */
export function trialKeys(): { privateKey: KeyObject; publicKey: string } {
	const { privateKey, publicKey } = generateKeyPairSync("ed25519");
	const raw = Buffer.from(
		publicKey.export({ format: "jwk" }).x as string,
		"base64url",
	);
	return { privateKey, publicKey: raw.toString("base64") };
}

/** Chrome with the extension, serving the test pages. */
export async function launch(
	binary: string,
	args: string[],
	labs: string[] = [],
): Promise<{ browser: Browser; worker: Worker }> {
	const browser = await Browser.launch(binary, {
		extension: extensionDir,
		args,
		labs,
		serve,
	});
	const worker = await browser.serviceWorker(unpackedExtensionId(extensionDir));
	return { browser, worker };
}

/** Open the test page and wait until its late tool is registered. */
/**
 * page.html is ready when its log says the late tool is registered (on the
 * native object or a forgery), or that WebMCP is off.
 */
const PAGE_READY = `/late_tool|WebMCP is off/.test(document.getElementById("log")?.textContent ?? "")`;
/** polyfill.html is ready when its tool is listed. */
const POLYFILL_READY = `Promise.resolve(document.modelContext?.getTools()).then((tools) => (tools ?? []).length > 0)`;

/**
 * Open a test page and wait until `ready` (evaluated in the page's world) is
 * true, up to 10 s: by default until page.html's late tool is registered.
 */
export async function openPage(
	browser: Browser,
	url: string,
	ready = PAGE_READY,
): Promise<{ page: Page; isolated: World }> {
	const page = await browser.newPage(url);
	for (let waited = 0; !(await page.eval<boolean>(ready)); waited += 100) {
		if (waited >= 10_000) throw new Error(`${url} was not ready in 10 s`);
		await Bun.sleep(100);
	}
	return { page, isolated: await page.isolatedWorld(EXTENSION_NAME) };
}

const js = (value: unknown) => JSON.stringify(value);

/**
 * The probe's source, for evaluating in the page's own world: what a page
 * script (or a main-world script) sees. The declared main-world content
 * script's own copy is not reachable from there: its top-level declarations
 * do not become globals of the page.
 */
const probeSource = await Bun.file(join(extensionDir, "probe.js")).text();
const inMain = (call: string) =>
	`(() => { ${probeSource}; return ${call}; })()`;

async function main(): Promise<void> {
	const binary = findChromeForTesting();
	if (binary === undefined)
		throw new Error("no Chrome for Testing; set CHROME_PATH");
	const report: Record<string, unknown> = { binary };
	{
		// 1. Turning it on: which switches give document.modelContext.
		const switches: Record<string, unknown> = {};
		for (const [label, args, labs] of [
			["(none)", [], []],
			["--enable-features=WebMCP", ["--enable-features=WebMCP"], []],
			[
				"--enable-features=WebMCPTesting",
				["--enable-features=WebMCPTesting"],
				[],
			],
			[
				"--enable-blink-features=WebMCP",
				["--enable-blink-features=WebMCP"],
				[],
			],
			// chrome://flags writes "<flag>@1" for Enabled; the bare name does nothing.
			[
				"chrome://flags enable-webmcp-testing@1",
				[],
				["enable-webmcp-testing@1"],
			],
			["chrome://flags enable-webmcp-testing", [], ["enable-webmcp-testing"]],
		] as const) {
			const { browser } = await launch(binary, [...args], [...labs]);
			try {
				const { page, isolated } = await openPage(browser, pageUrl);
				switches[label] = {
					version: (
						(await browser.send("Browser.getVersion")) as { product: string }
					).product,
					main: await page.eval("typeof document.modelContext"),
					isolated: await page.eval("typeof document.modelContext", isolated),
				};
			} finally {
				await browser.close();
			}
		}
		report["switches"] = switches;

		const { browser, worker } = await launch(binary, [WEBMCP_ON]);
		try {
			// 2. From the content script (isolated world).
			const { page, isolated } = await openPage(browser, pageUrl);
			const call = (world: World | undefined, name: string, input = {}) =>
				page.eval(
					world === undefined
						? inMain(`webmcpProbe("call", ${js({ name, input })})`)
						: `webmcpProbe("call", ${js({ name, input })})`,
					world,
				);
			report["isolated"] = {
				report: await page.eval(`spike.probe("report")`, isolated),
				toolchanges: await page.eval("spike.toolchanges()", isolated),
				calls: {
					get_greeting: await call(isolated, "get_greeting", { name: "Ada" }),
					place_order: await call(isolated, "place_order", { item: "tea" }),
					get_weather: await call(isolated, "get_weather", { city: "Bern" }),
					invalid_input: await call(isolated, "get_greeting", { name: 42 }),
				},
				pageSaw: await page.eval("window.spikeCalls"),
			};

			// 3. From the page's world: what any main-world script sees, the
			// declared main-world script over CustomEvents, and executeScript.
			report["main"] = {
				cdpEval: await page.eval(inMain(`webmcpProbe("report")`)),
				call: await call(undefined, "get_greeting", { name: "Bob" }),
				declaredScriptToolchanges: await page.eval(
					`spike.viaMain("toolchanges")`,
					isolated,
				),
				viaCustomEvent: await page.eval(
					`spike.viaMain("call", ${js({ name: "get_greeting", input: { name: "Cy" } })})`,
					isolated,
				),
				executeScriptMain: await worker.eval(
					`spike.execute(${js(pageUrl)}, "MAIN", "call", ${js({ name: "get_weather", input: { city: "Chur" } })})`,
				),
				executeScriptIsolated: await worker.eval(
					`spike.execute(${js(pageUrl)}, "ISOLATED", "call", ${js({ name: "place_order", input: { item: "milk", quantity: 2 } })})`,
				),
			};

			// 4. Registering from the extension, and what DevTools' WebMCP
			// domain (the browser side) sees.
			const domain: unknown[] = [];
			const off = browser.on((method, params, sessionId) => {
				if (method.startsWith("WebMCP.") && sessionId === page.sessionId)
					domain.push({ method, params });
			});
			let domainEnable: unknown;
			try {
				domainEnable = await page.send("WebMCP.enable");
			} catch (error) {
				domainEnable = String(error);
			}
			const registered = {
				fromIsolated: await page.eval(
					`spike.probe("register", { name: "ext_isolated_tool" })`,
					isolated,
				),
				fromExecuteScriptMain: await worker.eval(
					`spike.execute(${js(pageUrl)}, "MAIN", "register", { name: "ext_main_tool" })`,
				),
				// A name the page already holds, and the page taking one of ours.
				pageNameFromIsolated: await page.eval(
					`spike.probe("register", { name: "get_greeting" })`,
					isolated,
				),
				pageTakesExtensionName: await page.eval(
					`document.modelContext.registerTool({ name: "ext_isolated_tool", description: "The page's.", inputSchema: { type: "object" }, execute: async () => "page" }).then(() => "registered", (e) => \`\${e.name}: \${e.message}\`)`,
				),
			};
			await Bun.sleep(300);
			report["register"] = {
				registered,
				pageLists: (
					(await page.eval(inMain(`webmcpProbe("report")`))) as {
						tools?: { name: string }[];
					}
				).tools?.map((t) => t.name),
				pageCallsIsolatedTool: await call(undefined, "ext_isolated_tool", {
					x: 1,
				}),
				pageCallsMainTool: await call(undefined, "ext_main_tool", { x: 2 }),
				isolatedCallsMainTool: await call(isolated, "ext_main_tool", { x: 3 }),
				devtoolsDomain: { enable: domainEnable, events: domain },
			};
			off();

			// 5. Edges on the same page.
			const slow = page.eval(
				`webmcpProbe("call", { name: "slow_tool" })`,
				isolated,
			);
			await Bun.sleep(500);
			await page.eval(`spikeUnregister("slow_tool")`);
			report["edges"] = {
				unregisteredDuringCall: await slow,
				listedAfterUnregister: (
					(await page.eval(`spike.probe("report")`, isolated)) as {
						tools: { name: string }[];
					}
				).tools.map((t) => t.name),
				// Long enough to see a timeout of Chrome's own, if it had one.
				hangWithTimeout: await page.eval(
					`webmcpProbe("call", { name: "hang_tool", timeoutMs: 30000 })`,
					isolated,
				),
				hangCancelled: await page.eval(
					`webmcpProbe("call", { name: "hang_tool", cancelAfterMs: 300, timeoutMs: 2000 })`,
					isolated,
				),
				pageConsole: await Bun.sleep(500).then(() =>
					page.console.filter((l) => l.includes("hang_tool")),
				),
			};

			// The page replaces document.modelContext with its own object.
			const forged = await openPage(browser, `${pageUrl}?forge`);
			report["forged"] = {
				main: await forged.page.eval(inMain(`webmcpProbe("report")`)),
				isolated: await forged.page.eval(
					`spike.probe("report")`,
					forged.isolated,
				),
				declaredScriptCaptured: await forged.page.eval(
					`spike.viaMain("captured")`,
					forged.isolated,
				),
				executeScriptMain: await worker.eval(
					`spike.execute(${js(`${pageUrl}?forge`)}, "MAIN", "report")`,
				),
			};

			// Cross-origin frames: spike.test embeds other.test.
			const frameBase = `${OTHER_SITE}/frame.html`;
			const frames: Record<string, unknown> = {};
			for (const [label, query] of [
				["no allow", `?frame=${encodeURIComponent(frameBase)}`],
				["allow=tools", `?allow&frame=${encodeURIComponent(frameBase)}`],
				[
					"allow=tools, exposedTo spike.test",
					`?allow&frame=${encodeURIComponent(`${frameBase}?expose=${SITE}`)}`,
				],
			] as const) {
				const { page: framed, isolated: topWorld } = await openPage(
					browser,
					`${pageUrl}${query}`,
				);
				const inFrame = await framed.isolatedWorld(EXTENSION_NAME, OTHER_SITE);
				const names = async (expression: string, world: World) =>
					(
						(await framed.eval(expression, world)) as {
							tools?: { name: string; origin: string }[];
						}
					).tools?.map((t) => `${t.name} (${t.origin})`);
				frames[label] = {
					topLists: await names(`spike.probe("report")`, topWorld),
					topListsFromOrigins: await names(
						`spike.probe("report", { fromOrigins: ["${OTHER_SITE}"] })`,
						topWorld,
					),
					topCallsFrameTool: await framed.eval(
						`spike.probe("call", { name: "frame_tool", fromOrigins: ["${OTHER_SITE}"] })`,
						topWorld,
					),
					frameLists: await names(`spike.probe("report")`, inFrame),
					frameCallsOwnTool: await framed.eval(
						`spike.probe("call", { name: "frame_tool" })`,
						inFrame,
					),
					console: framed.console.filter((l) => l.startsWith("[frame]")),
				};
			}
			report["frames"] = frames;
		} finally {
			await browser.close();
		}

		// 6. The origin trial: the page turns WebMCP on with a token (our own
		// key standing in for Google's), no switch.
		{
			const keys = trialKeys();
			const trial: Record<string, unknown> = {};
			const launched = await launch(binary, [
				`--origin-trial-public-key=${keys.publicKey}`,
			]);
			try {
				for (const feature of ["WebMCP", "WebMCPTesting"]) {
					const token = trialToken(keys.privateKey, SITE, feature);
					const { page, isolated } = await openPage(
						launched.browser,
						`${pageUrl}?trial=${encodeURIComponent(token)}`,
					);
					const tools = (expression: string, world?: World) =>
						page
							.eval<{ tools?: { name: string }[] }>(expression, world)
							.then((r) => r.tools?.map((t) => t.name) ?? null);
					trial[feature] = {
						main: await tools(inMain(`webmcpProbe("report")`)),
						isolated: await tools(`spike.probe("report")`, isolated),
						isolatedCall: await page.eval(
							`spike.probe("call", { name: "get_greeting", input: { name: "Trial" } })`,
							isolated,
						),
					};
				}
				const { page, isolated } = await openPage(launched.browser, pageUrl);
				trial["no token"] = {
					main: await page.eval("typeof document.modelContext"),
					isolated: await page.eval("typeof document.modelContext", isolated),
				};
			} finally {
				await launched.browser.close();
			}
			report["originTrial"] = trial;
		}

		// 7. A page using @mcp-b/global (from unpkg), with WebMCP on and off.
		{
			const url = `${SITE}/polyfill.html`;
			const polyfill: Record<string, unknown> = {};
			for (const [label, args] of [
				["native off", []],
				["native on", [WEBMCP_ON]],
			] as const) {
				const launched = await launch(binary, [...args]);
				try {
					const { page, isolated } = await openPage(
						launched.browser,
						url,
						POLYFILL_READY,
					);
					polyfill[label] = {
						main: await page.eval(inMain(`webmcpProbe("report")`)),
						isolated: await page.eval(`spike.probe("report")`, isolated),
						isolatedCall: await page.eval(
							`spike.probe("call", { name: "poly_tool" })`,
							isolated,
						),
						executeScriptMainCall: await launched.worker.eval(
							`spike.execute(${js(url)}, "MAIN", "call", { name: "poly_tool" })`,
						),
						console: page.console,
					};
				} finally {
					await launched.browser.close();
				}
			}
			report["polyfill"] = polyfill;
		}
	}
	console.log(JSON.stringify(report, null, 2));
}

if (import.meta.main) await main();
