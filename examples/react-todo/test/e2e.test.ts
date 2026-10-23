/**
 * End to end (iteration 9): the React todo page in headless Chrome, a real
 * relay, and the MCP SDK client as the AI app (with a token put in the
 * relay's store; pairing itself is the calculator e2e's subject). The AI app
 * lists the tools, adds, completes and deletes a todo (with the page's
 * confirmation), and keeps working after the relay restarted. Needs Chrome:
 * required in CI, skipped elsewhere without it.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Client } from "@modelcontextprotocol/client";
import {
	Browser,
	findChrome,
	type Page,
} from "../../../packages/tab-mcp-client/test/cdp.ts";
import {
	connectClient,
	startRelay,
	type TestRelay,
	tokenFor,
} from "../../../packages/tab-mcp-client/test/helpers.ts";
import { serveExample } from "../server.ts";

const chrome = findChrome();
if (chrome === undefined && process.env["CI"])
	throw new Error("Chrome is needed for the React todo e2e test in CI");

let relay: TestRelay | undefined;
let server: ReturnType<typeof serveExample> | undefined;
let browser: Browser | undefined;
let pageOrigin = "";

beforeAll(async () => {
	if (chrome === undefined) return;
	let relayUrl = "";
	server = serveExample({ relay: () => relayUrl, port: 0 });
	pageOrigin = `http://127.0.0.1:${server.port}`;
	relay = startRelay({ allowedOrigins: [pageOrigin] });
	relayUrl = relay.url;
	browser = await Browser.launch(chrome);
}, 30_000);

afterAll(async () => {
	await browser?.close();
	await relay?.stop();
	await server?.stop(true);
});

/** Wait in the page until `condition` (a JavaScript expression) is truthy. */
function waitFor<T = unknown>(
	page: Page,
	condition: string,
	timeoutMs = 10_000,
): Promise<T> {
	return page.eval<T>(`new Promise((resolve, reject) => {
		const check = () => { try { return (${condition}); } catch { return undefined; } };
		const poll = setInterval(() => { const v = check(); if (v) { clearInterval(poll); clearTimeout(timer); resolve(v instanceof Node ? true : v); } }, 25);
		const timer = setTimeout(() => { clearInterval(poll); reject(new Error(${JSON.stringify(`timed out waiting for ${condition}`)})); }, ${timeoutMs});
	})`);
}

function json(result: Awaited<ReturnType<Client["callTool"]>>): unknown {
	const first = (result.content as { type: string; text?: string }[])[0];
	return JSON.parse(first?.text ?? "null");
}

const todoTexts = (page: Page) =>
	page.eval<string[]>(
		"[...document.querySelectorAll('.todos li')].map((li) => li.textContent.replace('×', '').trim())",
	);

test.skipIf(chrome === undefined)(
	"an AI app uses the React page's tools, also after the relay restarted",
	async () => {
		if (browser === undefined || relay === undefined) throw new Error("setup");
		const page = await browser.newPage();
		await page.goto(`${pageOrigin}/`);
		await waitFor(page, "document.querySelector('button.connect')");
		expect(
			await page.eval("document.querySelector('button.connect').textContent"),
		).toBe("Connect your AI app");

		// The user connects: the button opens the library's dialog.
		await page.click("button.connect");
		const address = await waitFor<string>(
			page,
			"document.querySelector('dialog.tab-mcp-connect[open] .tab-mcp-address-input')?.value",
		);
		await page.press("Escape");
		await waitFor(page, "!document.querySelector('dialog[open]')");

		let client = await connectClient(
			address,
			await tokenFor(relay.store, address),
		);
		// One useTool per tool: each tool once (StrictMode: react.test.tsx).
		const { tools } = await client.listTools();
		expect(tools.map((t) => t.name).sort()).toEqual([
			"add_todo",
			"complete_todo",
			"delete_todo",
			"list_todos",
		]);
		expect(
			tools.find((t) => t.name === "delete_todo")?.annotations?.destructiveHint,
		).toBe(true);

		const added = json(
			await client.callTool({
				name: "add_todo",
				arguments: { text: "Buy milk" },
			}),
		) as { id: string };
		await client.callTool({
			name: "add_todo",
			arguments: { text: "Water plants" },
		});
		await waitFor(page, "document.querySelectorAll('.todos li').length === 2");
		expect(await todoTexts(page)).toEqual(["Buy milk", "Water plants"]);

		await client.callTool({
			name: "complete_todo",
			arguments: { id: added.id },
		});
		await waitFor(
			page,
			`document.querySelector('.todos li[data-id="${added.id}"]').classList.contains('done')`,
		);

		// Deleting asks the user in the page first.
		const deleting = client.callTool({
			name: "delete_todo",
			arguments: { id: added.id },
		});
		await waitFor(
			page,
			"[...document.querySelectorAll('dialog.tab-mcp-confirm[open] button')].find((b) => b.textContent === 'Allow' && !b.disabled)",
		);
		await page.eval(
			"[...document.querySelectorAll('dialog.tab-mcp-confirm[open] button')].find((b) => b.textContent === 'Allow').id = 'allow'",
		);
		await page.click("#allow");
		await deleting;
		await waitFor(page, "document.querySelectorAll('.todos li').length === 1");
		await waitFor(
			page,
			"document.querySelector('.activity li[data-outcome=\"ok\"]')",
		);
		await client.close();

		// The relay restarts (bye shutdown): the page reconnects by itself, at
		// once when the network comes back, to the same address.
		const port = relay.relay.port;
		await relay.stop();
		await waitFor(
			page,
			"document.querySelector('button.connect').dataset.state === 'reconnecting'",
		);
		relay = startRelay({ allowedOrigins: [pageOrigin], port });
		await page.eval("window.dispatchEvent(new Event('online'))");
		await waitFor(
			page,
			"document.querySelector('button.connect').dataset.state === 'connected'",
		);
		client = await connectClient(address, await tokenFor(relay.store, address));
		const listed = json(
			await client.callTool({ name: "list_todos", arguments: {} }),
		) as { todos: { text: string }[] };
		expect(listed.todos.map((t) => t.text)).toEqual(["Water plants"]);
		await client.close();
		await page.close();
	},
	60_000,
);
