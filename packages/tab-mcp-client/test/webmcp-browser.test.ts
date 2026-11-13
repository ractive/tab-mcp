/**
 * The WebMCP mirror (iteration 25) in Chrome for Testing with
 * `--enable-features=WebMCP`: the library, built as for a page, on pages
 * served through the DevTools Protocol on https://webmcp.test (as in
 * `test/webmcp-spike/`: no server, no network but the polyfill's download).
 * An agent's calls go through the native `executeTool()`. Needs Chrome for
 * Testing 156 or newer (`CHROME_PATH`, or Puppeteer's or Playwright's
 * cache): required in CI, skipped elsewhere without it.
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

const MIN_MAJOR = 156;
const found = findChromeForTesting();
const chrome =
	found !== undefined && chromeMajor(found) >= MIN_MAJOR ? found : undefined;
if (chrome === undefined && process.env["CI"])
	throw new Error(
		`Chrome for Testing ${MIN_MAJOR} or newer is needed for the WebMCP browser test in CI`,
	);

const SITE = "https://webmcp.test";
const OTHER = "https://other.test";
const POLYFILL = "https://unpkg.com/@mcp-b/global@6.0.3/dist/index.iife.js";
const POLYFILL_SRI =
	"sha384-MjmUqfRCVKBDYdxv/Rlj1fc1tRkKQdtCI04fbUUMgSL8uJf1ydjQep7E4G43bnQn";

/**
 * The test page: the library with `webmcp: true` (`?off`: without), its
 * tools, and what the harness reads. `?native=<name>` registers a tool of
 * that name natively before the library does; `?poly` loads `@mcp-b/global`
 * first; `?dialog` asks with the library's own confirmation. `agent()`
 * calls a tool as an agent does, through the native `executeTool()`, which
 * hands back the result as JSON text.
 */
const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>WebMCP mirror</title>
POLYFILL_TAG
</head><body>
<script type="module">
const q = new URLSearchParams(location.search);
window.warnings = [];
const warn = console.warn;
console.warn = (...args) => { warnings.push(args.map(String).join(" ")); warn(...args); };
const native = Object.getOwnPropertyDescriptor(Document.prototype, "modelContext")?.get?.call(document);
if (q.has("native")) await native.registerTool({ name: q.get("native"), description: "The page's own", execute: () => "page" });
const { TabMcp } = await import("/lib/index.js");
window.calls = [];
window.asked = [];
window.answer = false;
const mcp = new TabMcp({
	relay: "https://relay.test",
	server: { name: "webmcp-test", version: "1.0.0" },
	storage: null,
	alwaysAllow: true,
	webmcp: !q.has("off"),
	...(q.has("dialog") ? {} : { onConfirm: (r) => { asked.push(r.client); return answer; } }),
});
mcp.addEventListener("toolcall", (e) => calls.push({ start: e.detail.tool, client: e.detail.client }));
mcp.addEventListener("toolcallend", (e) => calls.push({ end: e.detail.tool, outcome: e.detail.outcome, client: e.detail.client }));
const add = {
	name: "add", title: "Add", description: "Adds two numbers",
	inputSchema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a", "b"] },
	annotations: { readOnlyHint: true, destructiveHint: false },
	execute: ({ a, b }, { client }) => ({ sum: a + b, caller: client.kind }),
};
window.addControl = new AbortController();
await mcp.registerTool(add, { signal: addControl.signal });
await mcp.registerTool({ name: "wipe", description: "Wipes the memory", annotations: { consequentialHint: true }, execute: () => "wiped" });
await mcp.registerTool({ name: "wipe_named", description: "Wipes, offered in WebMCP", annotations: { consequentialHint: true }, execute: () => "wiped" }, { webmcp: true });
await mcp.registerTool({ name: "hidden", description: "Never in WebMCP", annotations: { readOnlyHint: true }, execute: () => 1 }, { webmcp: false });
await mcp.registerTool({
	name: "refused", description: "A schema only the validator refuses",
	inputSchema: { type: "object", properties: { a: { $id: "https://y.example/t", $ref: "#/$defs/s" } }, $defs: { s: { type: "string" } } },
	execute: () => "ran",
});
window.mcp = mcp;
window.native = native;
window.nativeNames = async () => (await native.getTools()).map((t) => t.name).sort();
window.agent = async (name, input, cancelAfterMs) => {
	const tool = (await native.getTools()).find((t) => t.name === name);
	if (tool === undefined) return { ok: false, error: "not listed" };
	const controller = new AbortController();
	if (cancelAfterMs !== undefined) setTimeout(() => controller.abort(), cancelAfterMs);
	try {
		return { ok: true, value: await native.executeTool(tool, input, { signal: controller.signal }) };
	} catch (e) {
		return { ok: false, error: e.name };
	}
};
window.ready = true;
</script>
FRAMES
</body></html>`;

/** A cross-origin frame with the library, with or without `allow="tools"`. */
const FRAME = `<!doctype html><html><head><meta charset="utf-8"></head><body><script type="module">
const warnings = [];
console.warn = (...args) => warnings.push(args.map(String).join(" "));
const { TabMcp } = await import("${SITE}/lib/index.js");
const mcp = new TabMcp({ relay: "https://relay.test", server: { name: "frame", version: "1.0.0" }, storage: null, webmcp: true });
await mcp.registerTool({ name: "frame_" + location.search.slice(1), description: "d", annotations: { readOnlyHint: true }, execute: () => 1 });
const nativeNames = async () => { try { return (await document.modelContext.getTools()).map((t) => t.name); } catch { return null; } };
setTimeout(async () => parent.postMessage({ frame: location.search.slice(1), tools: mcp.tools, warnings, native: await nativeNames() }, "*"), 200);
</script></body></html>`;

let browser: Browser | undefined;
const lib = new Map<string, string>();
let polyfill: Uint8Array | undefined;

async function serve(url: string): Promise<Served> {
	const { origin, pathname, searchParams } = new URL(url);
	if (url === POLYFILL) {
		polyfill ??= new Uint8Array(await (await fetch(POLYFILL)).arrayBuffer());
		return {
			status: 200,
			headers: {
				"content-type": "text/javascript",
				"access-control-allow-origin": "*",
			},
			body: polyfill,
		};
	}
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
	if (pathname === "/frame.html")
		return {
			status: 200,
			headers: { "content-type": "text/html; charset=utf-8" },
			body: FRAME,
		};
	if (origin !== SITE || pathname !== "/")
		return { status: 404, body: "not found" };
	const html = PAGE.replace(
		"POLYFILL_TAG",
		searchParams.has("poly")
			? `<script src="${POLYFILL}" integrity="${POLYFILL_SRI}" crossorigin="anonymous"></script>`
			: "",
	).replace(
		"FRAMES",
		searchParams.has("frames")
			? `<script>window.frames_ = []; addEventListener("message", (e) => { if (e.data?.frame) frames_.push(e.data); });</script>
<iframe src="${OTHER}/frame.html?plain"></iframe><iframe allow="tools" src="${OTHER}/frame.html?allowed"></iframe>`
			: "",
	);
	return {
		status: 200,
		headers: { "content-type": "text/html; charset=utf-8" },
		body: html,
	};
}

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
	for (const o of build.outputs)
		lib.set(`/lib/${o.path.replace(/^.*\//, "")}`, await o.text());
	browser = await Browser.launch(chrome, {
		args: ["--enable-features=WebMCP"],
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
	await Bun.sleep(20); // the registrations run a microtask later
	return page;
}

const on = test.skipIf(chrome === undefined);

on(
	"getTools() lists the mirrored tools, not the consequential ones unless named",
	async () => {
		const page = await open();
		try {
			expect(await page.eval("nativeNames()")).toEqual([
				"add",
				"refused",
				"wipe_named",
			]);
			expect(
				await page.eval(
					`native.getTools().then((ts) => { const t = ts.find((x) => x.name === "add"); return { title: t.title, description: t.description, inputSchema: t.inputSchema, annotations: t.annotations }; })`,
				),
			).toEqual({
				title: "Add",
				description: "Adds two numbers",
				inputSchema: {
					type: "object",
					properties: { a: { type: "number" }, b: { type: "number" } },
					required: ["a", "b"],
				},
				annotations: {
					consequentialHint: false,
					debugging: false,
					readOnlyHint: true,
					untrustedContentHint: false,
				},
			});
			// The page is not marked: <html data-tab-mcp-webmcp> is gone.
			expect(
				await page.eval(
					`document.documentElement.hasAttribute("data-tab-mcp-webmcp")`,
				),
			).toBe(false);
			expect(await page.eval("mcp.tools")).toEqual([
				"add",
				"wipe",
				"wipe_named",
				"hidden",
				"refused",
			]);
		} finally {
			await page.close();
		}
	},
);

on(
	"a call runs; the first one loads the validator, which unmirrors the refused tool",
	async () => {
		const page = await open();
		try {
			expect(await page.eval(`agent("add", { a: 1, b: 2 })`)).toEqual({
				ok: true,
				value: '{"sum":3,"caller":"webmcp"}',
			});
			expect(await page.eval("calls")).toEqual([
				{ start: "add", client: { kind: "webmcp" } },
				{ end: "add", outcome: "ok", client: { kind: "webmcp" } },
			]);
			expect(await page.eval("nativeNames()")).toEqual(["add", "wipe_named"]);
			expect(await page.eval("mcp.tools")).not.toContain("refused");
		} finally {
			await page.close();
		}
	},
);

on(
	"a bad argument, Don't allow and a throw reach the agent as a readable error (DEC-120)",
	async () => {
		const page = await open();
		try {
			await page.eval(
				`mcp.registerTool({ name: "broken", description: "Always fails", execute: () => { throw new Error("Out of paper"); } })`,
			);
			await Bun.sleep(20);
			const bad = await page.eval<{ ok: boolean; value: string }>(
				`agent("add", { a: "one", b: 2 })`,
			);
			expect(bad.ok).toBe(true);
			expect(JSON.parse(bad.value).error).toStartWith(
				"Input validation error: Invalid arguments for tool add: ",
			);
			expect(await page.eval(`agent("wipe_named", {})`)).toEqual({
				ok: true,
				value: '{"error":"The user did not allow wipe_named to run."}',
			});
			expect(await page.eval("asked")).toEqual([{ kind: "webmcp" }]);
			expect(await page.eval(`agent("broken", {})`)).toEqual({
				ok: true,
				value: '{"error":"Out of paper"}',
			});
			expect(
				await page.eval("calls.filter((c) => c.end).map((c) => c.outcome)"),
			).toEqual(["error", "declined", "error"]);
			await page.eval("answer = true");
			expect(await page.eval(`agent("wipe_named", {})`)).toEqual({
				ok: true,
				value: "wiped",
			});
		} finally {
			await page.close();
		}
	},
);

on(
	'the default confirmation offers no "Always allow" to an agent in the browser',
	async () => {
		const page = await open("?dialog");
		try {
			const call = page.eval(`agent("wipe_named", {})`);
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
					`document.querySelector("dialog.tab-mcp-confirm").textContent.includes("An agent in this browser wants to run")`,
				),
			).toBe(true);
			await page.eval(
				`[...document.querySelectorAll("dialog.tab-mcp-confirm button")].find((b) => b.textContent === "Don't allow").click()`,
			);
			expect(await call).toEqual({
				ok: true,
				value: '{"error":"The user did not allow wipe_named to run."}',
			});
			expect(
				await page.eval("calls.filter((c) => c.end).map((c) => c.outcome)"),
			).toEqual(["declined"]);
		} finally {
			await page.close();
		}
	},
);

on(
	"a call the agent cancels aborts execute's signal and closes the dialog (review of PR 103)",
	async () => {
		const page = await open("?dialog");
		try {
			const call = page.eval(`agent("wipe_named", {}, 300)`);
			let open = false;
			for (let i = 0; i < 100 && !open; i++) {
				await Bun.sleep(20);
				open = await page.eval<boolean>(
					`document.querySelector("dialog.tab-mcp-confirm") !== null`,
				);
			}
			expect(open).toBe(true);
			expect(await call).toEqual({ ok: false, error: "AbortError" });
			await Bun.sleep(50);
			expect(
				await page.eval(
					`document.querySelector("dialog.tab-mcp-confirm") === null`,
				),
			).toBe(true);
			expect(
				await page.eval("calls.filter((c) => c.end).map((c) => c.outcome)"),
			).toEqual(["cancelled"]);
		} finally {
			await page.close();
		}
	},
);

on("aborting unmirrors; registering again mirrors again", async () => {
	const page = await open();
	try {
		await page.eval("addControl.abort()");
		expect(await page.eval("nativeNames()")).toEqual(["refused", "wipe_named"]);
		// As React's useTool does: abort and register again at once.
		await page.eval(`(async () => {
			const c = new AbortController();
			await mcp.registerTool({ name: "again", description: "d", execute: () => "one" }, { signal: c.signal });
			c.abort();
			await mcp.registerTool({ name: "again", description: "d", execute: () => "two" });
		})()`);
		await Bun.sleep(50);
		expect(await page.eval(`agent("again", {})`)).toEqual({
			ok: true,
			value: "two",
		});
		expect(await page.eval("warnings")).toEqual([]);
	} finally {
		await page.close();
	}
});

on("a native duplicate in either order keeps its owner", async () => {
	const page = await open("?native=add");
	try {
		// The page's own came first: the mirror warns, the relay still has it.
		expect(await page.eval(`agent("add", { a: 1, b: 2 })`)).toEqual({
			ok: true,
			value: "page",
		});
		expect(await page.eval("warnings.length")).toBe(1);
		expect(await page.eval("warnings[0]")).toContain(
			"add is not offered through WebMCP",
		);
		expect(await page.eval("mcp.tools")).toContain("add");
		// The mirror came first: the page's own registration fails.
		expect(
			await page.eval(
				`native.registerTool({ name: "wipe_named", description: "d", execute: () => 1 }).then(() => "ok", (e) => e.name)`,
			),
		).toBe("InvalidStateError");
	} finally {
		await page.close();
	}
});

on(
	'a frame without allow="tools" warns and keeps its tools for the relay',
	async () => {
		const page = await open("?frames");
		try {
			interface FrameReport {
				frame: string;
				tools: string[];
				warnings: string[];
				native: string[] | null;
			}
			let frames: FrameReport[] = [];
			for (let i = 0; i < 100 && frames.length < 2; i++) {
				await Bun.sleep(50);
				frames = await page.eval("frames_");
			}
			const byName = Object.fromEntries(frames.map((f) => [f.frame, f]));
			expect(byName["plain"]).toMatchObject({ tools: ["frame_plain"] });
			// Not registered natively: no tools there, or no access at all.
			expect(byName["plain"]?.native ?? []).toEqual([]);
			expect(
				(byName["plain"] as unknown as { warnings: string[] }).warnings,
			).toHaveLength(1);
			expect(byName["allowed"]).toEqual({
				frame: "allowed",
				tools: ["frame_allowed"],
				warnings: [],
				native: ["frame_allowed"],
			});
		} finally {
			await page.close();
		}
	},
);

on(
	"with @mcp-b/global over native WebMCP, the tools go to the native object",
	async () => {
		const page = await open("?poly");
		try {
			expect(
				await page.eval(
					`Object.hasOwn(document, "modelContext") && document.modelContext !== native`,
				),
			).toBe(true);
			expect(await page.eval("nativeNames()")).toEqual([
				"add",
				"refused",
				"wipe_named",
			]);
			expect(await page.eval(`agent("add", { a: 2, b: 2 })`)).toEqual({
				ok: true,
				value: '{"sum":4,"caller":"webmcp"}',
			});
		} finally {
			await page.close();
		}
	},
);

on("webmcp off registers nothing", async () => {
	const page = await open("?off");
	try {
		expect(await page.eval("nativeNames()")).toEqual([]);
		expect(
			await page.eval(
				`document.documentElement.hasAttribute("data-tab-mcp-webmcp")`,
			),
		).toBe(false);
	} finally {
		await page.close();
	}
});
