/**
 * Browser smoke test (DEC-025): headless Chrome over CDP loads a page with the
 * library, a real click connects to a local relay (real `WebSocket`, origin
 * check, dynamic import, `<dialog>`), and the MCP SDK client calls a tool and
 * a consequential tool that the page confirms in its default dialog.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { join } from "node:path";
import type { Client } from "@modelcontextprotocol/client";
import { Browser, findChrome, type Page } from "./cdp.ts";
import {
	connectClient,
	startRelay,
	type TestRelay,
	tokenFor,
} from "./helpers.ts";

const chrome = findChrome();
if (chrome === undefined && process.env["CI"])
	throw new Error("Chrome is needed for the browser test in CI");

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>tab-mcp browser test</title></head>
<body>
<button id="connect">Connect your AI app</button>
<script type="module">
import { TabMcp } from "/lib/index.js";
const mcp = new TabMcp({ relay: RELAY, server: { name: "browser-test", version: "1.0.0" }, appName: "browser test" });
mcp.registerTool({
	name: "add", title: "Add", description: "Add two numbers",
	inputSchema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a", "b"] },
	annotations: { readOnlyHint: true },
	execute: ({ a, b }) => a + b,
});
let memory = 7;
mcp.registerTool({
	name: "clear_memory", title: "Clear memory", description: "Clears the memory",
	annotations: { consequentialHint: true },
	execute: () => { memory = 0; return "cleared"; },
});
window.memory = () => memory;
window.mcp = mcp;
document.getElementById("connect").addEventListener("click", () => mcp.showConnectDialog());
window.ready = true;
</script>
</body></html>`;

/** A page's own rules for buttons in a state, one pseudo-class each (review of PR 34). */
const HOST_STYLE = `<style>
button:hover { background: rgb(255, 0, 0); color: rgb(0, 255, 0); }
button:focus { outline: none; }
button:disabled { opacity: 1; }
</style>`;

let relay: TestRelay;
let server: ReturnType<typeof Bun.serve>;
let browser: Browser | undefined;
let page: Page;

beforeAll(async () => {
	const build = await Bun.build({
		entrypoints: [join(import.meta.dir, "../src/index.ts")],
		target: "browser",
		format: "esm",
		splitting: true,
		naming: { entry: "[name].js", chunk: "[name]-[hash].js" },
	});
	if (!build.success) throw new Error(build.logs.join("\n"));
	const files = new Map<string, string>();
	for (const o of build.outputs)
		files.set(`/lib/${o.path.replace(/^.*\//, "")}`, await o.text());

	server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		fetch: (req) => {
			const path = new URL(req.url).pathname;
			if (path === "/" || path === "/host") {
				const page = PAGE.replace("RELAY", JSON.stringify(relay.url));
				return new Response(
					path === "/host"
						? page.replace("</head>", `${HOST_STYLE}</head>`)
						: page,
					{ headers: { "content-type": "text/html; charset=utf-8" } },
				);
			}
			const js = files.get(path);
			return js === undefined
				? new Response("not found", { status: 404 })
				: new Response(js, { headers: { "content-type": "text/javascript" } });
		},
	});
	// The relay admits exactly the test page's origin, as a real deployment would.
	relay = startRelay({ allowedOrigins: [`http://127.0.0.1:${server.port}`] });
	if (chrome !== undefined) {
		browser = await Browser.launch(chrome);
		page = await browser.newPage();
	}
}, 30_000);

afterAll(async () => {
	await browser?.close();
	await relay?.stop();
	await server?.stop(true);
});

test.skipIf(chrome === undefined)(
	"a page connects with a click and serves tool calls through the relay",
	async () => {
		await page.goto(`http://127.0.0.1:${server.port}/`);
		await page.eval(
			"new Promise((r) => { const w = () => (window.ready ? r(true) : setTimeout(w, 10)); w(); })",
		);

		// Before the click only the core is loaded.
		const before = await page.eval<string[]>(
			"performance.getEntriesByType('resource').map((e) => e.name)",
		);
		expect(before.some((n) => n.includes("/lib/index.js"))).toBe(true);
		expect(before.some((n) => n.includes("/lib/connection-"))).toBe(false);

		// Without a user action, connect() is refused.
		expect(
			await page.eval("mcp.connect().then(() => 'connected', (e) => e.name)"),
		).toBe("NotAllowedError");

		const connected = page.eval<string>(
			"new Promise((r) => mcp.addEventListener('connected', (e) => r(e.detail.address), { once: true }))",
		);
		await page.click("#connect");
		const address = await connected;
		expect(address).toMatch(/\/a\/[a-z2-7]{52}\/mcp$/);
		const after = await page.eval<string[]>(
			"performance.getEntriesByType('resource').map((e) => e.name)",
		);
		expect(after.some((n) => n.includes("/lib/connection-"))).toBe(true);

		// The default dialog shows the address; pairing is on while it is open.
		const dialog = await page.eval<{
			open: boolean;
			address: string;
			pairing: boolean;
			status: string;
		}>(
			// `connected` fires before the dialog is built (its chunk loads after
			// connect()), so wait for it to be open instead of reading it at once.
			"new Promise((r) => { const w = () => { const d = document.querySelector('dialog.tab-mcp-connect'); if (d === null || !d.open) return setTimeout(w, 10); r({ open: d.open, address: d.querySelector('input').value, pairing: mcp.pairing, status: d.querySelector('.tab-mcp-status').textContent }); }; w(); })",
		);
		expect(dialog).toEqual({
			open: true,
			address,
			pairing: true,
			status: "browser test is ready for your AI app.",
		});
		await page.press("Escape");
		expect(
			await page.eval(
				"new Promise((r) => { const w = () => (document.querySelector('dialog') ? setTimeout(w, 10) : r(mcp.pairing)); w(); })",
			),
		).toBe(false);

		let client: Client | undefined;
		const token = await tokenFor(relay.store, address);
		try {
			client = await connectClient(address, token);
			expect((await client.listTools()).tools.map((t) => t.name)).toEqual([
				"add",
				"clear_memory",
			]);
			expect(
				(await client.callTool({ name: "add", arguments: { a: 40, b: 2 } }))
					.content,
			).toEqual([{ type: "text", text: "42" }]);

			// A consequential tool waits for "Allow" in the page's dialog.
			const call = client.callTool({ name: "clear_memory", arguments: {} });
			const question = await page.eval<string>(
				"new Promise((r) => { const w = () => { const d = document.querySelector('dialog.tab-mcp-confirm'); d ? r(d.textContent) : setTimeout(w, 10); }; w(); })",
			);
			expect(question).toContain("Allow Clear memory?");
			expect(question).toContain("client.example wants to run Clear memory.");
			expect(await page.eval("memory()")).toBe(7);
			// "Allow" starts disabled (a click meant for the page cannot approve).
			expect(
				await page.eval(
					`new Promise((resolve) => {
					const allow = [...document.querySelectorAll('dialog.tab-mcp-confirm button')].find((b) => b.textContent === 'Allow');
					const wasDisabled = allow.disabled;
					const click = () => { allow.click(); resolve(wasDisabled); };
					if (!allow.disabled) return click();
					new MutationObserver((_, o) => { if (!allow.disabled) { o.disconnect(); click(); } }).observe(allow, { attributes: true });
				})`,
				),
			).toBe(true);
			expect((await call).content).toEqual([{ type: "text", text: "cleared" }]);
			expect(await page.eval("memory()")).toBe(0);
		} finally {
			await client?.close();
		}

		// New address in the dialog: it asks, revokes the app and connects again.
		await page.eval("mcp.disconnect()");
		const reconnected = page.eval<string>(
			"new Promise((r) => mcp.addEventListener('connected', (e) => r(e.detail.address), { once: true }))",
		);
		await page.click("#connect");
		expect(await reconnected).toBe(address);
		await page.eval(
			"new Promise((r) => { const w = () => (document.querySelector('dialog.tab-mcp-connect .tab-mcp-apps li') ? r(true) : setTimeout(w, 10)); w(); })",
		);
		await page.click("dialog.tab-mcp-connect .tab-mcp-new-address");
		expect(
			await page.eval<string>(
				"document.querySelector('.tab-mcp-new-address-question p').textContent",
			),
		).toBe(
			"A new address disconnects Test client (client.example). To use this page again, add the new address to it.",
		);
		const renewed = page.eval<string>(
			"new Promise((r) => mcp.addEventListener('connected', (e) => r(e.detail.address), { once: true }))",
		);
		// A real click: the reconnect needs the user action.
		await page.click("dialog.tab-mcp-connect .tab-mcp-new-address-confirm");
		const newAddress = await renewed;
		expect(newAddress).toMatch(/\/a\/[a-z2-7]{52}\/mcp$/);
		expect(newAddress).not.toBe(address);
		expect(
			await page.eval(
				"document.querySelector('dialog.tab-mcp-connect input').value",
			),
		).toBe(newAddress);
		expect(await page.eval("mcp.grants.length")).toBe(0);
		// The relay revoked the old address's grant.
		const oldId = /\/a\/([a-z2-7]{52})\/mcp$/.exec(address)?.[1] ?? "";
		expect(await relay.store.listGrants(oldId, Date.now())).toEqual([]);
		await page.press("Escape");

		await page.eval("mcp.disconnect()");
		expect(await page.eval("mcp.state")).toBe("disconnected");
	},
	60_000,
);

test.skipIf(chrome === undefined)(
	"a confirmation opened in a background tab waits until the tab is in front again (iteration 13)",
	async () => {
		const b = browser as Browser;
		await page.goto(`http://127.0.0.1:${server.port}/`);
		await page.eval(
			"new Promise((r) => { const w = () => (window.ready ? r(true) : setTimeout(w, 10)); w(); })",
		);
		// Another tab in front: the AI app's, say.
		const other = await b.newPage();
		try {
			expect(await page.eval("document.visibilityState")).toBe("hidden");
			await page.eval(`(() => {
				window.answer = mcp.confirmInPage({
					tool: { name: "clear_memory", description: "Clears the memory" },
					arguments: {},
					client: { grantId: "g_1", id: "https://client.example/c.json", host: "client.example" },
					signal: new AbortController().signal,
				});
			})()`);
			// Well past the 750 ms, still disabled while the tab is in the background.
			const stillDisabled = await page.eval<boolean[]>(
				`new Promise((r) => { const w = () => { const d = document.querySelector('dialog.tab-mcp-confirm'); d ? setTimeout(() => r([...d.querySelectorAll('button')].filter((x) => x.textContent !== "Don't allow").map((x) => x.disabled)), 1500) : setTimeout(w, 10); }; w(); })`,
			);
			// Allow only: Always allow is opt-in (DEC-096).
			expect(stillDisabled).toEqual([true]);
			// Back in front: the full delay from then on.
			const timing = page.eval<{ visible: boolean; waited: number }>(
				`new Promise((resolve) => {
					const allow = [...document.querySelectorAll('dialog.tab-mcp-confirm button')].find((b) => b.textContent === 'Allow');
					let shownAt;
					document.addEventListener('visibilitychange', () => { shownAt ??= performance.now(); });
					new MutationObserver((_, o) => {
						if (allow.disabled) return;
						o.disconnect();
						const waited = performance.now() - shownAt;
						allow.click();
						resolve({ visible: document.visibilityState === 'visible', waited });
					}).observe(allow, { attributes: true });
				})`,
			);
			await b.send("Target.activateTarget", { targetId: page.targetId });
			const { visible, waited } = await timing;
			expect(visible).toBe(true);
			expect(waited).toBeGreaterThanOrEqual(700);
			expect(await page.eval("window.answer")).toBe(true);
		} finally {
			await other.close();
		}
	},
	30_000,
);

test.skipIf(chrome === undefined)(
	"a second tab of the page takes over: the first hears it on its BroadcastChannel (iteration 10)",
	async () => {
		const b = browser as Browser;
		const ready =
			"new Promise((r) => { const w = () => (window.ready ? r(true) : setTimeout(w, 10)); w(); })";
		await page.goto(`http://127.0.0.1:${server.port}/`);
		await page.eval(ready);
		await page.eval("mcp.connect({ resume: true }).then(() => true)");
		const replaced = page.eval<{ sibling: boolean }>(
			"new Promise((r) => mcp.addEventListener('replaced', (e) => r(e.detail), { once: true }))",
		);
		const second = await b.newPage();
		try {
			await second.goto(`http://127.0.0.1:${server.port}/`);
			await second.eval(ready);
			await second.eval("mcp.connect({ resume: true }).then(() => true)");
			expect(await replaced).toEqual({ sibling: true });
			await second.eval("mcp.disconnect()");
		} finally {
			await second.close();
		}
	},
	30_000,
);

test.skipIf(chrome === undefined)(
	"a page's rules for button:hover, :focus and :disabled do not change the dialogs (review of PR 34)",
	async () => {
		await page.goto(`http://127.0.0.1:${server.port}/host`);
		await page.eval(
			"new Promise((r) => { const w = () => (window.ready ? r(true) : setTimeout(w, 10)); w(); })",
		);
		await page.send("Target.activateTarget", { targetId: page.targetId });
		await page.eval(`(() => {
			window.answer = mcp.confirmInPage({
				tool: { name: "clear_memory", description: "Clears the memory" },
				arguments: {},
				client: { grantId: "g_1", id: "https://client.example/c.json", host: "client.example" },
				signal: new AbortController().signal,
			});
		})()`);
		const style = (selector: string) =>
			page.eval<{
				opacity: string;
				background: string;
				color: string;
				outline: string;
			}>(
				`(() => { const s = getComputedStyle(document.querySelector(${JSON.stringify(selector)})); return { opacity: s.opacity, background: s.backgroundColor, color: s.color, outline: s.outlineStyle }; })()`,
			);
		await page.eval(
			"new Promise((r) => { const w = () => (document.querySelector('dialog.tab-mcp-confirm') ? r(true) : setTimeout(w, 10)); w(); })",
		);
		// A disabled Allow still looks disabled.
		expect((await style(".tab-mcp-allow")).opacity).toBe("0.45");
		// The focused "Don't allow" keeps its focus ring.
		expect(
			await page.eval(
				"document.activeElement.matches('.tab-mcp-deny:focus-visible')",
			),
		).toBe(true);
		expect((await style(".tab-mcp-deny")).outline).toBe("solid");
		// Hovered, the buttons keep their own colours.
		const hover = async (selector: string) => {
			const box = await page.eval<{ x: number; y: number }>(
				`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`,
			);
			await page.send("Input.dispatchMouseEvent", {
				type: "mouseMoved",
				x: box.x,
				y: box.y,
			});
			expect(
				await page.eval(
					`document.querySelector(${JSON.stringify(selector)}).matches(":hover")`,
				),
			).toBe(true);
			return style(selector);
		};
		const primary = await hover(".tab-mcp-deny");
		expect(primary.background).not.toBe("rgb(255, 0, 0)");
		expect(primary.color).not.toBe("rgb(0, 255, 0)");
		await page.eval(
			"new Promise((r) => { const w = () => (document.querySelector('.tab-mcp-allow').disabled ? setTimeout(w, 10) : r(true)); w(); })",
		);
		const plain = await hover(".tab-mcp-allow");
		expect(plain.background).not.toBe("rgb(255, 0, 0)");
		expect(plain.color).not.toBe("rgb(0, 255, 0)");
		await page.press("Escape");
		expect(await page.eval("window.answer")).toBe(false);
	},
	30_000,
);
