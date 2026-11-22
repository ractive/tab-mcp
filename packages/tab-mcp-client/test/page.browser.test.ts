/**
 * Browser smoke test (DEC-025): headless Chrome over CDP loads a page with the
 * library, a real click connects to a local relay (real `WebSocket`, origin
 * check, dynamic import, `<dialog>`), and the MCP SDK client calls a tool and
 * a consequential tool that the page confirms in its default dialog.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { join } from "node:path";
import type { Client } from "@modelcontextprotocol/client";
import { browserTests } from "../../../test/browser-gate.ts";
import { step } from "../../../test/step.ts";
import { Browser, findChrome, type Page } from "./cdp.ts";
import {
	connectClient,
	mcpPost,
	rpc,
	startRelay,
	type TestRelay,
	tokenFor,
} from "./helpers.ts";

const chrome = browserTests ? findChrome() : undefined;
if (browserTests && chrome === undefined && process.env["CI"])
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

/**
 * A page with its own colours for elements, a classless framework's buttons,
 * and `body { pointer-events: none }` as Radix sets it while one of its modal
 * layers is open (iteration 31, CU 3 and CU 8).
 */
const DARK_STYLE = `<style>
body { pointer-events: none; background: #111; }
h2 { color: rgb(255, 0, 0); }
p { color: rgb(0, 255, 0); }
pre { color: rgb(0, 0, 255); }
button { width: 100%; text-transform: uppercase; letter-spacing: 3px; }
</style>`;

let relay: TestRelay;
let server: ReturnType<typeof Bun.serve>;
let browser: Browser | undefined;
let page: Page;

beforeAll(async () => {
	if (chrome === undefined) return;
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
			if (path === "/" || path === "/host" || path === "/dark") {
				const page = PAGE.replace("RELAY", JSON.stringify(relay.url));
				const style =
					path === "/host" ? HOST_STYLE : path === "/dark" ? DARK_STYLE : "";
				return new Response(page.replace("</head>", `${style}</head>`), {
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
	"a page connects with a click and serves tool calls through the relay; its secret is in the browser's localStorage, kept over a reload, and a second tab takes over",
	async () => {
		await step(
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
					await page.eval(
						"mcp.connect().then(() => 'connected', (e) => e.name)",
					),
				).toBe("NotAllowedError");

				const connected = page.eval<string>(
					"new Promise((r) => mcp.addEventListener('statechange', function f(e) { if (e.detail.state !== 'connected') return; mcp.removeEventListener('statechange', f); r(mcp.session.address); }))",
				);
				await page.send("Network.enable");
				const socket = (browser as Browser).event(
					"Network.webSocketCreated",
					page.sessionId,
				);
				await page.click("#connect");
				const address = await connected;
				// The app's address: the server name as an app id (DEC-196).
				expect(address).toBe(`${relay.url}/s/browser-test/mcp`);
				// The socket Chrome opened: /tab and nothing else, no query (DEC-196).
				expect((await socket)["url"]).toBe(
					`${relay.url.replace("http", "ws")}/tab`,
				);
				const [oldId] = relay.relay.pagesOf("browser-test");
				expect(oldId).toMatch(/^[a-z2-7]{52}$/);
				const after = await page.eval<string[]>(
					"performance.getEntriesByType('resource').map((e) => e.name)",
				);
				expect(after.some((n) => n.includes("/lib/connection-"))).toBe(true);

				// The default dialog shows the address; closing it ends the code.
				const dialog = await page.eval<{
					open: boolean;
					address: string;
					status: string;
				}>(
					// The page is connected before the dialog is built (its chunk loads after
					// connect()), so wait for it to be open instead of reading it at once.
					"new Promise((r) => { const w = () => { const d = document.querySelector('dialog.tab-mcp-connect'); if (d === null || !d.open) return setTimeout(w, 10); r({ open: d.open, address: d.querySelector('input').value, status: d.querySelector('.tab-mcp-status').textContent }); }; w(); })",
				);
				expect(dialog).toEqual({
					open: true,
					address,
					status: "browser test is ready for your AI app.",
				});
				await page.press("Escape");
				expect(
					await page.eval(
						"new Promise((r) => { const w = () => (document.querySelector('dialog') ? setTimeout(w, 10) : r(mcp.pairingCode === undefined)); w(); })",
					),
				).toBe(true);

				let client: Client | undefined;
				const token = await tokenFor(relay, address);
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

					// A consequential tool waits for "Allow once" in the page's dialog.
					const call = client.callTool({ name: "clear_memory", arguments: {} });
					const question = await page.eval<string>(
						"new Promise((r) => { const w = () => { const d = document.querySelector('dialog.tab-mcp-confirm'); d ? r(d.textContent) : setTimeout(w, 10); }; w(); })",
					);
					expect(question).toContain("Allow Clear memory?");
					expect(question).toContain(
						"client.example wants to run Clear memory.",
					);
					expect(await page.eval("memory()")).toBe(7);
					// "Allow once" starts disabled (a click meant for the page cannot approve).
					expect(
						await page.eval(
							`new Promise((resolve) => {
						const allow = [...document.querySelectorAll('dialog.tab-mcp-confirm button')].find((b) => b.textContent === 'Allow once');
						const wasDisabled = allow.disabled;
						const click = () => { allow.click(); resolve(wasDisabled); };
						if (!allow.disabled) return click();
						new MutationObserver((_, o) => { if (!allow.disabled) { o.disconnect(); click(); } }).observe(allow, { attributes: true });
					})`,
						),
					).toBe(true);
					expect((await call).content).toEqual([
						{ type: "text", text: "cleared" },
					]);
					expect(await page.eval("memory()")).toBe(0);
				} finally {
					await client?.close();
				}

				// "Disconnect all apps" in the dialog: it asks, revokes the app and connects again.
				await page.eval("mcp.disconnect()");
				const reconnected = page.eval<string>(
					"new Promise((r) => mcp.addEventListener('statechange', function f(e) { if (e.detail.state !== 'connected') return; mcp.removeEventListener('statechange', f); r(mcp.session.address); }))",
				);
				await page.click("#connect");
				expect(await reconnected).toBe(address);
				await page.eval(
					"new Promise((r) => { const w = () => (document.querySelector('dialog.tab-mcp-connect .tab-mcp-apps li') ? r(true) : setTimeout(w, 10)); w(); })",
				);
				// An app is connected: "Disconnect all apps" is behind "Connect another AI app".
				expect(
					await page.eval(
						"document.querySelector('dialog.tab-mcp-connect .tab-mcp-disconnect-all').checkVisibility()",
					),
				).toBe(false);
				await page.click("dialog.tab-mcp-connect .tab-mcp-setup-toggle");
				await page.click("dialog.tab-mcp-connect .tab-mcp-disconnect-all");
				expect(
					await page.eval<string>(
						"document.querySelector('.tab-mcp-disconnect-all-question p').textContent",
					),
				).toBe(
					"This disconnects Test client (client.example). To use this page with it again, connect it again.",
				);
				const renewed = page.eval<string>(
					"new Promise((r) => mcp.addEventListener('statechange', function f(e) { if (e.detail.state !== 'connected') return; mcp.removeEventListener('statechange', f); r(mcp.session.address); }))",
				);
				// A real click: the reconnect needs the user action.
				await page.click(
					"dialog.tab-mcp-connect .tab-mcp-disconnect-all-confirm",
				);
				// The address names the app and stays; the page's secret is new.
				expect(await renewed).toBe(address);
				expect(
					await page.eval(
						"document.querySelector('dialog.tab-mcp-connect input').value",
					),
				).toBe(address);
				expect(
					await page.eval(
						"document.querySelector('dialog.tab-mcp-connect .tab-mcp-status').textContent",
					),
				).toBe("Every AI app is disconnected. Connect yours again.");
				expect(await page.eval("mcp.grants.length")).toBe(0);
				const [newId] = relay.relay.pagesOf("browser-test");
				expect(newId).toMatch(/^[a-z2-7]{52}$/);
				expect(newId).not.toBe(oldId);
				// The relay revoked the old secret's grant: its token is refused.
				expect(
					await relay.store.listGrants(oldId as string, Date.now()),
				).toEqual([]);
				expect(
					(await mcpPost(address, rpc(1, "tools/list"), { token })).status,
				).toBe(401);
				await page.press("Escape");

				await page.eval("mcp.disconnect()");
				expect(await page.eval("mcp.state")).toBe("disconnected");
			},
			60_000,
		);
		// The library's default storage, the only place a real one is used
		// (every unit test passes a MemoryStorage): a fallback to memory or
		// sessionStorage would cost the user the page's address on each reload.
		await step(
			"with the defaults the secret is in localStorage: the page's other tabs read it, and a reload keeps it",
			async () => {
				const b = browser as Browser;
				const ready =
					"new Promise((r) => { const w = () => (window.ready ? r(true) : setTimeout(w, 10)); w(); })";
				const key = `tab-mcp:secret:${new URL(relay.url).origin}:browser-test`;
				const stored = (p: Page) =>
					p.eval<{ local: string | null; session: string | null }>(
						`({ local: localStorage.getItem(${JSON.stringify(key)}), session: sessionStorage.getItem(${JSON.stringify(key)}) })`,
					);
				await page.goto(`http://127.0.0.1:${server.port}/`);
				await page.eval(ready);
				await page.eval("mcp.connect({ resume: true }).then(() => true)");
				const first = await stored(page);
				expect(first.local).toMatch(/\S{16,}/);
				expect(first.session).toBeNull();
				const address = await page.eval<string>("mcp.session.address");
				await page.eval("mcp.disconnect()");
				const second = await b.newPage();
				try {
					await second.goto(`http://127.0.0.1:${server.port}/`);
					await second.eval(ready);
					expect(await stored(second)).toEqual(first);
				} finally {
					await second.close();
				}
				await page.goto(`http://127.0.0.1:${server.port}/`);
				await page.eval(ready);
				expect(await stored(page)).toEqual(first);
				// Resumed with that secret: the same address, nothing new stored.
				await page.eval("mcp.connect({ resume: true }).then(() => true)");
				expect(await page.eval("mcp.session.address")).toBe(address);
				expect(await stored(page)).toEqual(first);
				await page.eval("mcp.disconnect()");
			},
			30_000,
		);
		await step(
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
	},
	160_000,
);

/**
 * What sticks out of the connect dialog's content box sideways (into its
 * padding or beyond), at the window's width; the code box's own padding too.
 */
const OVERFLOW = `(() => {
	const d = document.querySelector('dialog.tab-mcp-connect');
	const right = (e) => e.getBoundingClientRect().right - parseFloat(getComputedStyle(e).paddingRight);
	const edge = right(d) + 1;
	const code = d.querySelector('.tab-mcp-code');
	const out = [...d.querySelectorAll('*')].filter((e) => e.checkVisibility() && e.getBoundingClientRect().right > (code.contains(e) && e !== code ? right(code) + 1 : edge)).map((e) => e.className || e.localName);
	return { scrolls: d.scrollWidth > d.clientWidth, out, codeShown: d.querySelector('.tab-mcp-code-value').checkVisibility() };
})()`;

test.skipIf(chrome === undefined)(
	"the connect dialog with its code fits 320 and 360 px, also with 18 px text (CU 15)",
	async () => {
		try {
			for (const [width, font] of [
				[320, 16],
				[360, 16],
				[360, 18],
			] as const) {
				await page.send("Emulation.setDeviceMetricsOverride", {
					width,
					height: 640,
					deviceScaleFactor: 1,
					mobile: false,
				});
				await page.goto(`http://127.0.0.1:${server.port}/`);
				await page.eval(
					"new Promise((r) => { const w = () => (window.ready ? r(true) : setTimeout(w, 10)); w(); })",
				);
				await page.eval(
					`document.documentElement.style.fontSize = "${font}px"`,
				);
				await page.click("#connect");
				await page.eval(
					"new Promise((r) => { const w = () => (document.querySelector('dialog.tab-mcp-connect .tab-mcp-code-value')?.textContent ? r(true) : setTimeout(w, 10)); w(); })",
				);
				const seen: Record<string, unknown> = {
					width,
					font,
					...(await page.eval<Record<string, unknown>>(OVERFLOW)),
				};
				expect(seen).toEqual({
					width,
					font,
					scrolls: false,
					out: [],
					codeShown: true,
				});
				await page.press("Escape");
				await page.eval("mcp.disconnect()");
			}
		} finally {
			await page.send("Emulation.clearDeviceMetricsOverride");
		}
	},
	60_000,
);

test.skipIf(chrome === undefined)(
	"a page's own styles do not change the dialogs: its rules for button states, its colours and pointer-events; and confirmations one at a time (review of PR 34, iteration 31)",
	async () => {
		await step(
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
		);
		await step(
			"confirmations one at a time, Allow after the arguments were seen, no stray Enter, page colours and pointer-events kept out (iteration 31)",
			async () => {
				await page.goto(`http://127.0.0.1:${server.port}/dark`);
				await page.eval(
					"new Promise((r) => { const w = () => (window.ready ? r(true) : setTimeout(w, 10)); w(); })",
				);
				await page.send("Target.activateTarget", { targetId: page.targetId });
				// A long argument list, with what matters last; then a second call.
				await page.eval(`(() => {
				const ask = (args) => mcp.confirmInPage({
					tool: { name: "send_mail", description: "Sends a mail" },
					arguments: args,
					client: { kind: "relay", grantId: "g_1", id: "https://client.example/c.json", host: "client.example" },
					signal: new AbortController().signal,
				});
				const rows = Object.fromEntries(Array.from({ length: 60 }, (_, i) => ["row" + i, i]));
				window.answers = [];
				window.ask = ask;
				ask({ subject: "Hi", ...rows, bcc: "someone@example.com" }).then((a) => answers.push(a));
			})()`);
				const waitFor = (condition: string) =>
					page.eval(
						`new Promise((r) => { const w = () => ((${condition}) ? r(true) : setTimeout(w, 10)); w(); })`,
					);
				await waitFor("document.querySelector('dialog.tab-mcp-confirm')");
				// Asked once the first is shown: the dialogs' chunk loads with the
				// first call, and two calls before it has loaded may arrive in
				// either order.
				await page.eval(
					"(() => { ask({ subject: 'Second' }).then((a) => answers.push(a)); })()",
				);
				await waitFor(
					"document.querySelector('.tab-mcp-waiting').checkVisibility()",
				);
				const enter = async () => {
					for (const type of ["keyDown", "keyUp"])
						await page.send("Input.dispatchKeyEvent", {
							type,
							key: "Enter",
							code: "Enter",
							windowsVirtualKeyCode: 13,
							...(type === "keyDown" ? { text: "\r" } : {}),
						});
				};
				// Enter on the focused "Don't allow" right away does not answer.
				await enter();
				expect(
					await page.eval(
						"[document.querySelectorAll('dialog.tab-mcp-confirm').length, document.querySelector('dialog.tab-mcp-confirm').open, answers.length]",
					),
				).toEqual([1, true, 0]);
				// The page's element colours, button width, case and spacing stay out.
				const looks = await page.eval<Record<string, string>>(`(() => {
				const d = document.querySelector('dialog.tab-mcp-confirm');
				const c = (s) => getComputedStyle(d.querySelector(s)).color;
				const b = getComputedStyle(d.querySelector('.tab-mcp-allow'));
				return { dialog: getComputedStyle(d).color, h2: c('h2'), p: c('p'), pre: c('pre'), events: getComputedStyle(d).pointerEvents,
					transform: b.textTransform, spacing: b.letterSpacing, narrow: String(d.querySelector('.tab-mcp-allow').getBoundingClientRect().width < d.getBoundingClientRect().width / 2) };
			})()`);
				expect(looks).toEqual({
					dialog: looks["dialog"] as string,
					h2: looks["dialog"] as string,
					p: looks["dialog"] as string,
					pre: looks["dialog"] as string,
					events: "auto",
					transform: "none",
					spacing: "normal",
					narrow: "true",
				});
				expect(looks["dialog"]).not.toBe("rgb(0, 255, 0)");
				// Well past the delay, Allow still waits: the arguments overflow.
				await Bun.sleep(1200);
				expect(
					await page.eval(
						"[document.querySelector('.tab-mcp-allow').disabled, document.querySelector('.tab-mcp-scroll-note').checkVisibility()]",
					),
				).toEqual([true, true]);
				await page.eval(
					"(() => { const pre = document.querySelector('.tab-mcp-arguments'); pre.scrollTop = pre.scrollHeight; })()",
				);
				await waitFor("!document.querySelector('.tab-mcp-allow').disabled");
				// A real click, with pointer-events: none on body.
				await page.click(".tab-mcp-allow");
				await waitFor("answers.length === 1");
				// The second dialog is shown now, Allow disabled again from zero.
				await waitFor(
					"document.querySelector('dialog.tab-mcp-confirm pre')?.textContent.includes('Second')",
				);
				expect(
					await page.eval("document.querySelector('.tab-mcp-allow').disabled"),
				).toBe(true);
				await waitFor("!document.querySelector('.tab-mcp-allow').disabled");
				// After the delay, Enter on "Don't allow" answers.
				await enter();
				await waitFor("answers.length === 2");
				expect(await page.eval("answers")).toEqual([true, false]);
			},
		);
	},
	70_000,
);
