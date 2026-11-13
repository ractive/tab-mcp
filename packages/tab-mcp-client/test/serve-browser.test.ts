/**
 * `serve` in a browser (iteration 28): a page without a relay hands a port to
 * a chat in a frame on another origin, after checking the frame's origin, and
 * the chat calls the page's tools through `createTunnelFetch`. Pages are
 * served through the DevTools Protocol, as in `webmcp-browser.test.ts`. Runs
 * with any Chrome for Testing (`CHROME_PATH`, or Puppeteer's or Playwright's
 * cache); the WebMCP part needs 156 or newer. Required in CI, skipped
 * elsewhere without a browser.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { join } from "node:path";
import {
	Browser,
	chromeMajor,
	findChromeForTesting,
	type Page,
	type Served,
} from "../../../test/webmcp-spike/browser.ts";

const WEBMCP_MAJOR = 156;
const chrome = findChromeForTesting();
const major = chrome === undefined ? 0 : chromeMajor(chrome);
if (process.env["CI"] && major < WEBMCP_MAJOR)
	throw new Error(
		`Chrome for Testing ${WEBMCP_MAJOR} or newer is needed for the serve browser test in CI`,
	);

const SITE = "https://site.test";
const CHAT = "https://chat.test";
const EVIL = "https://evil.test";

/**
 * The page: the library without a relay, two tools, and the handshake a page
 * writes itself: a port only for the chat's frame on the chat's origin.
 */
const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Serve</title></head><body>
<script type="module">
const q = new URLSearchParams(location.search);
const { TabMcp } = await import("/lib/index.js");
window.calls = [];
window.reports = [];
window.refused = [];
const mcp = new TabMcp({ server: { name: "serve-test", version: "1.0.0" }, alwaysAllow: true, webmcp: q.has("webmcp") });
mcp.addEventListener("toolcallend", (e) => calls.push({ tool: e.detail.tool, outcome: e.detail.outcome, client: e.detail.client }));
await mcp.registerTool({
	name: "add", description: "Adds two numbers",
	inputSchema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a", "b"] },
	annotations: { readOnlyHint: true },
	execute: ({ a, b }, { client }) => ({ sum: a + b, caller: client.kind }),
});
await mcp.registerTool({ name: "wipe", description: "Wipes the memory", annotations: { consequentialHint: true }, execute: () => "wiped" });
const frame = (id, src) => {
	const node = document.createElement("iframe");
	node.id = id;
	node.src = src;
	document.body.append(node);
	return node;
};
const chat = frame("chat", "${CHAT}/chat.html");
frame("evil", "${EVIL}/chat.html");
addEventListener("message", async (event) => {
	if (event.data?.report) { reports.push(event.data.report); return; }
	if (event.data?.type !== "chat-ready") return;
	if (event.origin !== "${CHAT}" || event.source !== chat.contentWindow) { refused.push(event.origin); return; }
	const { port1, port2 } = new MessageChannel();
	window.served = await mcp.serve(port1, { client: { id: "chat", name: "Example assistant" } });
	event.source.postMessage({ type: "chat-port" }, "${CHAT}", [port2]);
});
window.mcp = mcp;
window.native = Object.getOwnPropertyDescriptor(Document.prototype, "modelContext")?.get?.call(document);
window.ready = true;
</script>
</body></html>`;

/** The chat's frame: asks for a port, then lists and calls the page's tools. */
const FRAME = `<!doctype html><html><head><meta charset="utf-8"></head><body><script type="module">
const { createTunnelFetch } = await import("${SITE}/lib/tunnel.js");
const report = (r) => parent.postMessage({ report: { origin: location.origin, ...r } }, "*");
addEventListener("message", async (event) => {
	if (event.data?.type !== "chat-port") return;
	const port = event.ports[0];
	const tunnel = createTunnelFetch({ send: (m) => port.postMessage(m) });
	port.onmessage = (e) => tunnel.receive(e.data);
	const post = async (id, method, params) => {
		const response = await tunnel.fetch("https://tab.invalid/mcp", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				accept: "application/json, text/event-stream",
				"mcp-protocol-version": "2026-07-28",
				"mcp-method": method,
				...(params.name ? { "mcp-name": params.name } : {}),
			},
			body: JSON.stringify({ jsonrpc: "2.0", id, method, params: { ...params, _meta: {
				"io.modelcontextprotocol/protocolVersion": "2026-07-28",
				"io.modelcontextprotocol/clientCapabilities": {},
				"io.modelcontextprotocol/clientInfo": { name: "chat", version: "1" },
			} } }),
		});
		const text = await response.text();
		if (!(response.headers.get("content-type") ?? "").startsWith("text/event-stream")) return JSON.parse(text);
		return text.split("\\n").filter((l) => l.startsWith("data: ")).map((l) => JSON.parse(l.slice(6))).find((m) => "result" in m || "error" in m);
	};
	const list = await post(1, "tools/list", {});
	report({ step: "list", tools: list.result.tools.map((t) => t.name) });
	const add = await post(2, "tools/call", { name: "add", arguments: { a: 2, b: 3 } });
	report({ step: "add", result: add.result.structuredContent });
	const wipe = await post(3, "tools/call", { name: "wipe", arguments: {} });
	report({ step: "wipe", text: wipe.result.content[0].text, isError: wipe.result.isError === true });
});
parent.postMessage({ type: "chat-ready" }, "*");
setTimeout(() => report({ step: "waited" }), 500);
</script></body></html>`;

let browser: Browser | undefined;
const lib = new Map<string, string>();

function serve(url: string): Served {
	const { origin, pathname } = new URL(url);
	const code = origin === SITE ? lib.get(pathname) : undefined;
	if (code !== undefined)
		return {
			status: 200,
			headers: {
				"content-type": "text/javascript",
				"access-control-allow-origin": "*",
			},
			body: code,
		};
	if ((origin === CHAT || origin === EVIL) && pathname === "/chat.html")
		return {
			status: 200,
			headers: { "content-type": "text/html; charset=utf-8" },
			body: FRAME,
		};
	if (origin !== SITE || pathname !== "/")
		return { status: 404, body: "not found" };
	return {
		status: 200,
		headers: { "content-type": "text/html; charset=utf-8" },
		body: PAGE,
	};
}

beforeAll(async () => {
	if (chrome === undefined) return;
	const build = await Bun.build({
		entrypoints: [
			join(import.meta.dir, "../src/index.ts"),
			join(import.meta.dir, "../src/tunnel.ts"),
		],
		target: "browser",
		format: "esm",
		splitting: true,
		naming: { entry: "[name].js", chunk: "[name]-[hash].js" },
	});
	if (!build.success) throw new Error(build.logs.join("\n"));
	for (const o of build.outputs)
		lib.set(`/lib/${o.path.replace(/^.*\//, "")}`, await o.text());
	browser = await Browser.launch(chrome, {
		args: [
			...(major >= WEBMCP_MAJOR ? ["--enable-features=WebMCP"] : []),
			// A port's `close` event (CC 1); Chrome does not fire it by default.
			"--enable-blink-features=MessagePortCloseEvent",
		],
		serve,
	});
}, 30_000);

afterAll(async () => {
	await browser?.close();
});

async function open(query = ""): Promise<Page> {
	const page = await (browser as Browser).newPage(`${SITE}/${query}`);
	for (let waited = 0; !(await page.eval<boolean>("window.ready === true")); ) {
		waited += 50;
		if (waited > 10_000) throw new Error(`${query} was not ready`);
		await Bun.sleep(50);
	}
	return page;
}

interface Report {
	origin: string;
	step: string;
	[key: string]: unknown;
}

/** The frames' reports, once one of the chat's has `step`. */
async function reportsUntil(page: Page, step: string): Promise<Report[]> {
	for (let i = 0; i < 200; i++) {
		const reports = await page.eval<Report[]>("reports");
		if (reports.some((r) => r.origin === CHAT && r.step === step))
			return reports;
		await Bun.sleep(50);
	}
	throw new Error(`the chat never reported ${step}`);
}

test.skipIf(chrome === undefined)(
	"a chat in a frame on another origin lists and calls the page's tools over a port",
	async () => {
		const page = await open();
		try {
			await reportsUntil(page, "add");
			// The consequential tool asks in the page, naming the page's assistant,
			// without "Always allow" (the page has alwaysAllow on).
			let buttons: string[] = [];
			for (let i = 0; i < 100 && buttons.length === 0; i++) {
				await Bun.sleep(50);
				buttons = await page.eval<string[]>(
					`[...document.querySelectorAll("dialog.tab-mcp-confirm button")].map((b) => b.textContent)`,
				);
			}
			expect(buttons).toEqual(["Don't allow", "Allow"]);
			expect(
				await page.eval(
					`document.querySelector("dialog.tab-mcp-confirm p").textContent`,
				),
			).toBe("Example assistant (this site's assistant) wants to run wipe.");
			await page.eval(
				`[...document.querySelectorAll("dialog.tab-mcp-confirm button")].find((b) => b.textContent === "Don't allow").click()`,
			);
			const reports = await reportsUntil(page, "wipe");
			const local = {
				kind: "local",
				id: "chat",
				name: "Example assistant",
			};
			expect(
				reports.filter((r) => r.origin === CHAT && r.step !== "waited"),
			).toEqual([
				{ origin: CHAT, step: "list", tools: ["add", "wipe"] },
				{ origin: CHAT, step: "add", result: { sum: 5, caller: "local" } },
				{
					origin: CHAT,
					step: "wipe",
					text: "The user declined",
					isError: true,
				},
			]);
			expect(await page.eval("calls")).toEqual([
				{ tool: "add", outcome: "ok", client: local },
				{ tool: "wipe", outcome: "declined", client: local },
			]);
			// The frame on the other origin asked too, and got no port.
			expect(await page.eval("refused")).toEqual([EVIL]);
			for (let i = 0; i < 40; i++) {
				const waited = await page.eval<Report[]>("reports");
				if (waited.some((r) => r.origin === EVIL)) break;
				await Bun.sleep(50);
			}
			expect(
				(await page.eval<Report[]>("reports")).filter((r) => r.origin === EVIL),
			).toEqual([{ origin: EVIL, step: "waited" }]);
			// No relay: nothing was stored, and connecting is refused.
			expect(await page.eval("localStorage.length")).toBe(0);
			expect(await page.eval("mcp.connect().catch((e) => e.message)")).toBe(
				"TabMcp: this TabMcp has no relay",
			);
		} finally {
			await page.close();
		}
	},
	30_000,
);

test.skipIf(chrome === undefined)(
	"the chat's frame goes away: the port's close event ends the serve and its open confirmation (CC 1)",
	async () => {
		const page = await open();
		try {
			await reportsUntil(page, "add");
			let open = false;
			for (let i = 0; i < 100 && !open; i++) {
				await Bun.sleep(50);
				open = await page.eval<boolean>(
					`document.querySelector("dialog.tab-mcp-confirm")?.open === true`,
				);
			}
			expect(open).toBe(true);
			// Chrome 151 fires the event only with the Blink feature that
			// `beforeAll` turns on; without it, the page must close the serve.
			expect(await page.eval("'onclose' in MessagePort.prototype")).toBe(true);
			// Nobody calls close(): the frame is removed, so its port is gone.
			await page.eval(`document.getElementById("chat").remove()`);
			let calls: { tool: string; outcome: string }[] = [];
			for (let i = 0; i < 100; i++) {
				calls = await page.eval("calls");
				if (calls.some((c) => c.tool === "wipe")) break;
				await Bun.sleep(50);
			}
			expect(calls.map(({ tool, outcome }) => ({ tool, outcome }))).toEqual([
				{ tool: "add", outcome: "ok" },
				{ tool: "wipe", outcome: "cancelled" },
			]);
			// The call ends at the abort (DEC-167); the dialog goes with its
			// `close` event, a task later.
			let shown = true;
			for (let i = 0; i < 40 && shown; i++) {
				shown = await page.eval<boolean>(
					`document.querySelector("dialog.tab-mcp-confirm") !== null`,
				);
				if (shown) await Bun.sleep(25);
			}
			expect(shown).toBe(false);
		} finally {
			await page.close();
		}
	},
	30_000,
);

test.skipIf(major < WEBMCP_MAJOR)(
	"with webmcp: true, one tool reaches the chat over the port and an agent in the browser",
	async () => {
		const page = await open("?webmcp");
		try {
			await reportsUntil(page, "add");
			expect(
				await page.eval(
					`native.getTools().then(async (ts) => native.executeTool(ts.find((t) => t.name === "add"), { a: 1, b: 2 }))`,
				),
			).toBe('{"sum":3,"caller":"webmcp"}');
			expect(
				await page.eval(
					`calls.filter((c) => c.tool === "add").map((c) => c.client.kind).sort()`,
				),
			).toEqual(["local", "webmcp"]);
			await page.eval(
				`[...document.querySelectorAll("dialog.tab-mcp-confirm button")].find((b) => b.textContent === "Don't allow")?.click()`,
			);
		} finally {
			await page.close();
		}
	},
	30_000,
);
