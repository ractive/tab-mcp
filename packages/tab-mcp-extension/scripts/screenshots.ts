/**
 * The Chrome Web Store screenshots (1280×800, light): the store build in
 * Chrome for Testing (`CHROME_PATH`, as for the end-to-end tests), the diagram
 * editor example on ractive.ch (live, through the DevTools Protocol), a relay
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
import { holdBrowserLock } from "../../../test/browser-lock.ts";
import { Browser, findChromeForTesting, type Page } from "../test/browser.ts";
import { build } from "./build.ts";

// One browser run per machine (test/browser-lock.ts).
await holdBrowserLock({ filter: "screenshots.ts" });

const ROOT = join(import.meta.dir, "..");
const OUT = join(ROOT, "assets/store");
/**
 * The page: tab-mcp's diagram editor example on ractive.ch, a real page whose
 * tools are registered with WebMCP too. Its requests (and its CDN's) go to the
 * network, so the shots show the live page.
 */
const SITE = "https://ractive.ch";
const PAGE_URL = `${SITE}/tab-mcp/examples/diagram/`;
const LIVE = new Set([SITE, "https://ractive.b-cdn.net"]);
/** Another site, for the question before the tab goes there; never opened. */
const OTHER = "https://github.com/ractive/tab-mcp";
/** What the panel shows as the AI app's address: the hosted relay's form. */
const PUBLIC_RELAY = "https://tab-mcp.ractive.ch";
const WIDTH = 1280;
const HEIGHT = 800;
const PANEL = 400;
const PAGE = WIDTH - PANEL - 1;
const shots = new Map<string, Uint8Array>();

/** An expression: `selector` is there and takes clicks (as in the e2e tests). */
const takesClicks = (selector: string) =>
	`(() => { const e = document.querySelector(${JSON.stringify(selector)}); return e !== null && e.getAttribute("aria-disabled") !== "true" && !document.body.hasAttribute("data-quiet"); })()`;

async function serve(url: string) {
	const { origin, pathname } = new URL(url);
	if (LIVE.has(origin)) {
		const response = await fetch(url);
		// Its headers as sent (the CDN's CORS header for the page's module
		// chunks), less those of the encoding `fetch` already undid.
		const headers: Record<string, string> = {};
		for (const [name, value] of response.headers)
			if (
				!["content-encoding", "content-length", "transfer-encoding"].includes(
					name,
				)
			)
				headers[name] = value;
		return {
			status: response.status,
			headers,
			body: new Uint8Array(await response.arrayBuffer()),
		};
	}
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
	await page.send("Emulation.setScrollbarsHidden", { hidden: true });
	await page.send("Emulation.setEmulatedMedia", {
		features: [{ name: "prefers-color-scheme", value: "light" }],
	});
	await Bun.sleep(400);
	const { data } = (await page.send("Page.captureScreenshot", {
		format: "png",
	})) as { data: string };
	return Buffer.from(data, "base64");
}

/** The page and the panel as they are now, under `name`. */
async function take(name: string, tab: Page, panel: Page): Promise<void> {
	// The page from its heading, so the editor and the whole diagram show.
	await tab.eval(
		`window.scrollTo(0, document.querySelector("h1").getBoundingClientRect().top + window.scrollY - 24)`,
	);
	shots.set(`${name}-page.png`, await capture(tab, PAGE));
	shots.set(`${name}-panel.png`, await capture(panel, PANEL));
}

/** Put each page beside its panel, 1280×800, and write the PNGs. */
async function compose(browser: Browser, names: string[]): Promise<void> {
	const page = await browser.newPage("https://shots.test/", { window: true });
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

// A free port; `relay.url` is the public one, the bound port is the relay's.
const relay = startTestRelay({ publicUrl: PUBLIC_RELAY });
const local = `http://127.0.0.1:${relay.relay.port}`;
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
	const tab = await browser.newPage(PAGE_URL);
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
		`document.getElementById("code").textContent.match(/[A-Z]{4}-[A-Z]{4}/) && document.getElementById("address").textContent`,
		15_000,
	);
	// The line under the heading and the one under "Fill in the code for me"
	// name the relay in the settings, this process's: the hosted relay's name,
	// as the store build shows by default, in every text of the panel. The
	// panel writes its lines again on each state it gets: take the shot again
	// until no text names this process's relay after it.
	const hosted = new URL(PUBLIC_RELAY).host;
	const mine = new URL(local).host;
	for (let attempt = 0; ; attempt++) {
		await panel.eval(`(() => {
			const texts = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
			for (let node = texts.nextNode(); node; node = texts.nextNode())
				if (node.nodeValue.includes(${JSON.stringify(mine)}))
					node.nodeValue = node.nodeValue.replaceAll(${JSON.stringify(mine)}, ${JSON.stringify(hosted)});
		})()`);
		await take("2-pairing", tab, panel);
		const shown = await panel.eval<string>(`document.body.innerText`);
		if (shown.includes(hosted) && !shown.includes(mine)) break;
		if (attempt === 4)
			throw new Error(`the panel names this process's relay: ${mine}`);
	}

	const token = await tokenFor(relay, address, {
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
	// The questions' dialog opens where the last click was: the pointer off
	// it, so no button is drawn hovered.
	const pointerAway = () =>
		panel.send("Input.dispatchMouseEvent", {
			type: "mouseMoved",
			x: 1,
			y: 1,
		});
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
	// The AI app draws how the extension works; the drawing tools run without
	// asking ("Always allow" on), the others still ask.
	await panel.waitFor(`document.querySelectorAll("#tools li").length === 8`);
	for (const name of ["add_shapes", "add_connectors", "layout"]) {
		const toggle = `input.always-allow[data-tool="${name}"]`;
		await panel.waitFor(takesClicks(toggle));
		await panel.click(toggle);
		await panel.waitFor(
			`document.querySelector(${JSON.stringify(toggle)}).checked`,
		);
	}
	const draw = async (name: string, args: Record<string, unknown>) => {
		const result = await client?.callTool({ name, arguments: args });
		if (result?.isError) throw new Error(`${name}: ${JSON.stringify(result)}`);
	};
	await draw("page_get_diagram", {});
	await draw("page_add_shapes", {
		shapes: [
			{ id: "app", kind: "rounded", label: "AI app", color: "purple" },
			{ id: "relay", kind: "rounded", label: "tab-mcp relay", color: "blue" },
			{
				id: "ext",
				kind: "rounded",
				label: "tab-mcp browser extension",
				color: "green",
			},
			{
				id: "page",
				kind: "rounded",
				label: "Page tools (WebMCP)",
				color: "yellow",
			},
			{ id: "you", kind: "diamond", label: "You allow?", color: "white" },
		],
	});
	await draw("page_add_connectors", {
		connectors: [
			{ from: "app", to: "relay", label: "MCP" },
			{ from: "relay", to: "ext" },
			{ from: "ext", to: "you" },
			{ from: "you", to: "page", label: "yes" },
		],
	});
	await draw("page_layout", { direction: "down" });
	await panel.waitFor(takesClicks("#allow-tools"));
	await pointerAway();
	// The panel from its top, as it opens (the switches scrolled it).
	await panel.eval(`window.scrollTo(0, 0)`);
	await take("1-tools", tab, panel);

	const asked = client.callTool({
		name: "page_update_elements",
		arguments: {
			changes: [{ id: "you", color: "orange" }],
		},
	});
	const ready = `document.querySelector('[data-question] button[data-answer="allow"]')?.hasAttribute("aria-disabled") === false`;
	await panel.waitFor(ready);
	await pointerAway();
	await take("3-question", tab, panel);
	await panel.eval(
		`document.querySelector('[data-question] button[data-answer="deny"]').click()`,
	);
	await asked;
	await panel.waitFor(`!document.querySelector("[data-question]")`);

	const navigating = client.callTool({
		name: "navigate",
		arguments: { url: OTHER },
	});
	await panel.waitFor(ready);
	await pointerAway();
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
