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
<button id="connect">Connect your AI tool</button>
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
			if (path === "/") {
				return new Response(PAGE.replace("RELAY", JSON.stringify(relay.url)), {
					headers: { "content-type": "text/html; charset=utf-8" },
				});
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
			"(() => { const d = document.querySelector('dialog.tab-mcp-connect'); return { open: d.open, address: d.querySelector('input').value, pairing: mcp.pairing, status: d.querySelector('.tab-mcp-status').textContent }; })()",
		);
		expect(dialog).toEqual({
			open: true,
			address,
			pairing: true,
			status: "browser test is ready for your AI tool.",
		});
		await page.press("Escape");
		expect(
			await page.eval(
				"new Promise((r) => { const w = () => (document.querySelector('dialog') ? setTimeout(w, 10) : r(mcp.pairing)); w(); })",
			),
		).toBe(false);

		let client: Client | undefined;
		try {
			client = await connectClient(
				address,
				await tokenFor(relay.store, address),
			);
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

		await page.eval("mcp.disconnect()");
		expect(await page.eval("mcp.state")).toBe("disconnected");
	},
	60_000,
);
