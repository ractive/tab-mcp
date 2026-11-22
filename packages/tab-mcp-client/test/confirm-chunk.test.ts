/**
 * Every consequential call loads the confirmation's chunk, which decides the
 * allowances (DEC-200). When that chunk does not load (a stale hash after a
 * deploy, a CSP, offline), the page's own `onConfirm` asks; without one the
 * call is refused, never allowed (review of PR 167). Built for real, with
 * the chunk deleted, and called through `serve`.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type * as Core from "../src/index.ts";
import { createTunnelFetch } from "../src/tunnel.ts";
import { readEvents, rpc } from "./helpers.ts";

const out = mkdtempSync(join(tmpdir(), "tab-mcp-client-no-confirm-"));
let core: typeof Core;

beforeAll(async () => {
	const result = await Bun.build({
		entrypoints: [join(import.meta.dir, "../src/index.ts")],
		target: "browser",
		format: "esm",
		splitting: true,
		outdir: out,
		naming: { entry: "[name].js", chunk: "[name]-[hash].js" },
	});
	expect(result.success).toBe(true);
	const confirm = readdirSync(out).filter((f) => f.startsWith("confirm-"));
	expect(confirm).toHaveLength(1);
	for (const file of confirm) rmSync(join(out, file));
	core = await import(join(out, "index.js"));
});
afterAll(() => rmSync(out, { recursive: true, force: true }));

/** Calls the consequential tool `wipe` of a page with these options through `serve`. */
async function callWipe(
	options: Partial<Core.TabMcpOptions>,
): Promise<{ text: string; ran: boolean }> {
	let ran = false;
	const mcp = new core.TabMcp({
		server: { name: "x", version: "1" },
		...options,
	});
	await mcp.registerTool({
		name: "wipe",
		description: "Wipes",
		annotations: { consequentialHint: true },
		execute: () => {
			ran = true;
			return "wiped";
		},
	});
	const { port1, port2 } = new MessageChannel();
	const tunnel = createTunnelFetch({ send: (m) => port2.postMessage(m) });
	port2.onmessage = (event: MessageEvent) => tunnel.receive(event.data);
	const served = await mcp.serve(port1, { client: { id: "chat" } });
	try {
		const body = rpc(1, "tools/call", { name: "wipe", arguments: {} });
		const response = await tunnel.fetch("https://tab.invalid/mcp", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				accept: "application/json, text/event-stream",
				"mcp-protocol-version": "2026-07-28",
				"mcp-method": "tools/call",
				"mcp-name": "wipe",
			},
			body: JSON.stringify(body),
		});
		const events = await readEvents(response, (e) => "result" in e);
		return { text: JSON.stringify(events.at(-1)), ran };
	} finally {
		served.close();
		port1.close();
		port2.close();
	}
}

test("the confirmation's chunk does not load: the page's own onConfirm asks", async () => {
	const asked: string[] = [];
	const yes = await callWipe({
		onConfirm: (request) => {
			asked.push(request.tool.name);
			return true;
		},
	});
	expect(asked).toEqual(["wipe"]);
	expect(yes.ran).toBe(true);
	expect(yes.text).toContain("wiped");
	// Only `true` runs it; "unanswered" stays what it is.
	const no = await callWipe({ onConfirm: () => "unanswered" });
	expect(no.ran).toBe(false);
	expect(no.text).toContain("did not answer");
});

test("the confirmation's chunk does not load and there is no onConfirm: refused, never allowed", async () => {
	const call = await callWipe({});
	expect(call.ran).toBe(false);
	expect(call.text).toContain("The user did not allow this call.");
});
