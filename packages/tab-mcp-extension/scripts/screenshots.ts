/**
 * The Chrome Web Store screenshots (1280×800, light): the store build in
 * Chrome for Testing (`CHROME_PATH`, as for the end-to-end tests), an example
 * shop page on a made-up origin served through the DevTools Protocol, a relay
 * in this process whose addresses read as the hosted relay's, and an MCP
 * client as the AI app. Each shot puts the page and the side panel side by
 * side, as Chrome shows them. Writes `assets/store/*.png`; look at each one
 * before an upload. The listing: `kb/operations/chrome-web-store.md`.
 *
 *   bun scripts/screenshots.ts
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	Client,
	StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { startTestRelay, tokenFor } from "@ractive-ch/tab-mcp/testing";
import { Browser, findChromeForTesting, type Page } from "../test/browser.ts";
import { build } from "./build.ts";

const ROOT = join(import.meta.dir, "..");
const OUT = join(ROOT, "assets/store");
const SHOP = "https://bakery.example";
const OTHER = "https://other.example";
/** What the panel shows as the AI app's address: the hosted relay's form. */
const PUBLIC_RELAY = "https://tab-mcp.ractive.ch";
const WIDTH = 1280;
const HEIGHT = 800;
const PANEL = 400;
const PAGE = WIDTH - PANEL - 1;

const SHOP_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Corner Bakery</title>
<style>
	body { margin: 0; font: 16px/1.5 system-ui, sans-serif; color: #2b2622; background: #fffaf3; }
	header { padding: 20px 40px; border-bottom: 1px solid #eadfce; display: flex; justify-content: space-between; align-items: center; }
	header h1 { margin: 0; font-size: 24px; }
	nav a { margin-left: 20px; color: #7a4a1d; text-decoration: none; }
	main { padding: 32px 40px; }
	.grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 20px; }
	.item { background: #fff; border: 1px solid #eadfce; border-radius: 10px; padding: 16px; }
	.item .pic { height: 110px; border-radius: 6px; margin-bottom: 12px; }
	.item h2 { font-size: 17px; margin: 0 0 4px; }
	.item p { margin: 0; color: #6b6158; font-size: 14px; }
	.price { font-weight: 600; color: #2b2622; margin-top: 8px !important; }
	button { margin-top: 10px; font: inherit; font-size: 14px; padding: 6px 12px; border-radius: 6px; border: 1px solid #7a4a1d; background: #fff; color: #7a4a1d; }
	.hours { margin-top: 28px; color: #6b6158; font-size: 14px; }
</style>
</head>
<body>
<header><h1>Corner Bakery</h1><nav><a href="/">Bread</a><a href="/">Pastries</a><a href="/">Cart (0)</a></nav></header>
<main>
	<div class="grid">
		<div class="item"><div class="pic" style="background:#d9b48a"></div><h2>Sourdough loaf</h2><p>Rye and wheat, 800 g</p><p class="price">CHF 7.50</p><button>Add to cart</button></div>
		<div class="item"><div class="pic" style="background:#e8c99b"></div><h2>Butter croissant</h2><p>Baked every morning</p><p class="price">CHF 2.40</p><button>Add to cart</button></div>
		<div class="item"><div class="pic" style="background:#c99a6b"></div><h2>Walnut bread</h2><p>Whole wheat, 500 g</p><p class="price">CHF 6.80</p><button>Add to cart</button></div>
		<div class="item"><div class="pic" style="background:#f0d9b5"></div><h2>Lemon tart</h2><p>Shortcrust, lemon curd</p><p class="price">CHF 5.20</p><button>Add to cart</button></div>
		<div class="item"><div class="pic" style="background:#b98a5e"></div><h2>Pretzel</h2><p>Lye-dipped, coarse salt</p><p class="price">CHF 2.10</p><button>Add to cart</button></div>
		<div class="item"><div class="pic" style="background:#e3bf8f"></div><h2>Apple strudel</h2><p>By the slice</p><p class="price">CHF 4.60</p><button>Add to cart</button></div>
	</div>
	<p class="hours">Open Monday to Saturday, 7:00 to 18:30.</p>
</main>
<script>
	"use strict";
	const register = (tool) => document.modelContext?.registerTool(tool);
	const products = ["Sourdough loaf", "Butter croissant", "Walnut bread", "Lemon tart", "Pretzel", "Apple strudel"];
	register({
		name: "search_products",
		title: "Search products",
		description: "Finds products by name.",
		inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
		annotations: { readOnlyHint: true },
		async execute({ query }) {
			return products.filter((p) => p.toLowerCase().includes(String(query).toLowerCase()));
		},
	});
	register({
		name: "opening_hours",
		title: "Opening hours",
		description: "The shop's opening hours.",
		inputSchema: { type: "object" },
		annotations: { readOnlyHint: true },
		async execute() {
			return "Monday to Saturday, 7:00 to 18:30";
		},
	});
	register({
		name: "add_to_cart",
		title: "Add to cart",
		description: "Adds a product to the cart.",
		inputSchema: {
			type: "object",
			properties: { product: { type: "string" }, quantity: { type: "integer" } },
			required: ["product"],
		},
		async execute({ product, quantity = 1 }) {
			return { cart: [{ product, quantity }] };
		},
	});
	register({
		name: "place_order",
		title: "Place order",
		description: "Orders what is in the cart, for pickup.",
		inputSchema: { type: "object", properties: { pickup: { type: "string" } }, required: ["pickup"] },
		async execute() {
			return { order: "A-1042" };
		},
	});
</script>
</body>
</html>`;

const shots = new Map<string, Uint8Array>();

function serve(url: string) {
	const { origin, pathname } = new URL(url);
	if (origin === SHOP && pathname === "/")
		return {
			status: 200,
			headers: { "content-type": "text/html; charset=utf-8" },
			body: SHOP_PAGE,
		};
	const shot = shots.get(pathname.slice(1));
	if (origin === "https://shots.test" && shot)
		return {
			status: 200,
			headers: { "content-type": "image/png" },
			body: shot,
		};
	return { status: 404, body: "not found" };
}

async function capture(page: Page, width: number): Promise<Uint8Array> {
	await page.send("Emulation.setDeviceMetricsOverride", {
		width,
		height: HEIGHT,
		deviceScaleFactor: 1,
		mobile: false,
	});
	await page.send("Emulation.setEmulatedMedia", {
		features: [{ name: "prefers-color-scheme", value: "light" }],
	});
	await Bun.sleep(400);
	const { data } = (await page.send("Page.captureScreenshot", {
		format: "png",
	})) as { data: string };
	return Buffer.from(data, "base64");
}

/** The shop page and the panel as they are now, under `name`. */
async function take(name: string, tab: Page, panel: Page): Promise<void> {
	shots.set(`${name}-page.png`, await capture(tab, PAGE));
	shots.set(`${name}-panel.png`, await capture(panel, PANEL));
}

/** Put each page beside its panel, 1280×800, and write the PNGs. */
async function compose(browser: Browser, names: string[]): Promise<void> {
	const page = await browser.newPage(`${SHOP}/`, { window: true });
	for (const name of names) {
		await page.send("Emulation.setDeviceMetricsOverride", {
			width: WIDTH,
			height: HEIGHT,
			deviceScaleFactor: 1,
			mobile: false,
		});
		await page.eval(`new Promise((resolve) => {
			document.documentElement.innerHTML = '<body style="margin:0;display:flex;background:#c8c4bd"><img src="https://shots.test/${name}-page.png" width="${PAGE}" height="${HEIGHT}"><div style="width:1px"></div><img src="https://shots.test/${name}-panel.png" width="${PANEL}" height="${HEIGHT}"></body>';
			Promise.all([...document.images].map((i) => i.decode())).then(resolve);
		})`);
		const { data } = (await page.send("Page.captureScreenshot", {
			format: "png",
		})) as { data: string };
		await Bun.write(join(OUT, `${name}.png`), Buffer.from(data, "base64"));
		console.log(`wrote assets/store/${name}.png`);
	}
}

const chrome = findChromeForTesting();
if (chrome === undefined)
	throw new Error("Chrome for Testing is needed: set CHROME_PATH");

const port = 20_000 + Math.floor(Math.random() * 20_000);
const relay = startTestRelay({ port, publicUrl: PUBLIC_RELAY });
const local = `http://127.0.0.1:${port}`;
const dir = mkdtempSync(join(tmpdir(), "tab-mcp-shots-"));
let browser: Browser | undefined;
let client: Client | undefined;
try {
	const outdir = join(dir, "dist");
	await build({ outdir, store: true });
	browser = await Browser.launch(chrome, {
		extension: outdir,
		args: ["--enable-features=WebMCP"],
		serve,
	});
	const panelUrl = `chrome-extension://${browser.extensionId}/sidepanel/index.html`;
	const tab = await browser.newPage(`${SHOP}/`);
	await browser.clickIcon(tab);
	const panel = await browser.attach(
		(await browser.waitForTarget((t) => t.url === panelUrl)).targetId,
	);
	// The questions' buttons take clicks only in a focused panel.
	await panel.send("Emulation.setFocusEmulationEnabled", { enabled: true });
	await panel.waitFor(`document.getElementById("relay").value !== ""`);
	await panel.eval(`(() => {
		document.getElementById("relay").value = ${JSON.stringify(local)};
		document.getElementById("relay-form").requestSubmit();
		document.getElementById("relay").value = "";
	})()`);
	await panel.waitFor(
		`document.getElementById("relay").value === ${JSON.stringify(local)}`,
	);
	await panel.click("#connect");
	const address = await panel.waitFor<string>(
		`document.getElementById("code").textContent.match(/\\d/) && document.getElementById("address").textContent`,
		15_000,
	);
	// The line under the heading names the relay in the settings, this
	// process's: the hosted relay's name, as the store build shows by default.
	await panel.eval(`(() => {
		const intro = document.getElementById("intro");
		intro.textContent = intro.textContent.replace(${JSON.stringify(new URL(local).host)}, ${JSON.stringify(new URL(PUBLIC_RELAY).host)});
	})()`);
	await take("2-pairing", tab, panel);

	const token = await tokenFor(relay.store, address, {
		clientId: "https://claude.ai/oauth/claude-code-client-metadata",
		clientName: "Claude Code",
	});
	// The relay lists an address's grants when the extension connects: off
	// and on again, the panel lists the AI app paired through the store.
	const state = (s: string) =>
		`document.getElementById("state").dataset.state === ${JSON.stringify(s)}`;
	await panel.click("#ai-switch");
	await panel.waitFor(state("off"));
	await panel.click("#ai-switch");
	await panel.waitFor(state("on"), 15_000);
	client = new Client(
		{ name: "claude-code", version: "1.0.0" },
		{ versionNegotiation: { mode: { pin: "2026-07-28" } } },
	);
	await client.connect(
		new StreamableHTTPClientTransport(
			new URL(address.replace(PUBLIC_RELAY, local)),
			{ requestInit: { headers: { authorization: `Bearer ${token}` } } },
		),
	);
	await client.callTool({
		name: "page_search_products",
		arguments: { query: "bread" },
	});
	await panel.waitFor(
		`document.querySelectorAll("#tools li").length === 4 && document.getElementById("pairing").hidden`,
	);
	await take("1-tools", tab, panel);

	const asked = client.callTool({
		name: "page_add_to_cart",
		arguments: { product: "Sourdough loaf", quantity: 2 },
	});
	const ready = `document.querySelector('[data-question] button[data-answer="allow"]')?.hasAttribute("aria-disabled") === false`;
	await panel.waitFor(ready);
	await take("3-question", tab, panel);
	await panel.eval(
		`document.querySelector('[data-question] button[data-answer="deny"]').click()`,
	);
	await asked;
	await panel.waitFor(`!document.querySelector("[data-question]")`);

	const navigating = client.callTool({
		name: "navigate",
		arguments: { url: `${OTHER}/` },
	});
	await panel.waitFor(ready);
	await take("4-navigation", tab, panel);
	await panel.eval(
		`document.querySelector('[data-question] button[data-answer="deny"]').click()`,
	);
	await navigating;

	await compose(browser, [
		"1-tools",
		"2-pairing",
		"3-question",
		"4-navigation",
	]);
} finally {
	await client?.close();
	await browser?.close();
	await relay.stop();
	rmSync(dir, { recursive: true, force: true });
}
