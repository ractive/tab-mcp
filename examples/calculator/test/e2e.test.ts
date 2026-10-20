/**
 * End to end (iteration 4): the calculator page in headless Chrome, a real
 * relay, and the MCP SDK client as the AI app doing the whole OAuth flow with
 * the pairing code typed on `/authorize` in Chrome. Needs Chrome
 * (`CHROME_PATH` or a usual location): required in CI, skipped elsewhere
 * without it.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Client } from "@modelcontextprotocol/client";
import {
	CLIENT_NAME,
	clickButton,
	connectTools,
	findChrome,
	openCalculator,
	type Page,
	type Pairing,
	pair,
	type Stack,
	startStack,
	waitFor,
} from "./stack.ts";

const chrome = findChrome();
if (chrome === undefined && process.env["CI"])
	throw new Error("Chrome is needed for the calculator e2e test in CI");

let stack: Stack | undefined;

beforeAll(async () => {
	if (chrome !== undefined) stack = await startStack(chrome);
}, 30_000);

afterAll(async () => {
	await stack?.stop();
});

const display = (page: Page) =>
	page.eval<string>("document.querySelector('#display-value').textContent");

/** The text of an MCP tool result's first content block. */
function text(result: Awaited<ReturnType<Client["callTool"]>>): string {
	const first = (result.content as { type: string; text?: string }[])[0];
	return first?.text ?? "";
}

/** Raw MCP POST with a bearer token; the body is read, so the response is done. */
async function rawCall(address: string, token: string): Promise<number> {
	const response = await fetch(address, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			accept: "application/json, text/event-stream",
			"mcp-protocol-version": "2026-07-28",
			"mcp-method": "tools/list",
			authorization: `Bearer ${token}`,
		},
		body: JSON.stringify({
			jsonrpc: "2.0",
			id: 1,
			method: "tools/list",
			params: {
				_meta: {
					"io.modelcontextprotocol/protocolVersion": "2026-07-28",
					"io.modelcontextprotocol/clientCapabilities": {},
					"io.modelcontextprotocol/clientInfo": { name: "raw", version: "1" },
				},
			},
		}),
	});
	await response.text();
	return response.status;
}

test.skipIf(chrome === undefined)(
	"an AI app pairs with the calculator page, uses its tools, and is disconnected in the page",
	async () => {
		if (stack === undefined) throw new Error("no stack");
		const page = await openCalculator(stack);
		expect(
			await page.eval("document.querySelector('#ai-status').textContent"),
		).toBe("Off. No AI app can use this page.");

		// Pairing: the dialog's address and code, the code typed on /authorize.
		const pairing: Pairing = await pair(stack, page, stack.clientId());
		expect(pairing.address).toMatch(
			new RegExp(`^${stack.relay.url}/a/[a-z2-7]{52}/mcp$`),
		);
		expect(pairing.authorizeText).toContain(
			`Connect ${CLIENT_NAME} from localhost:`,
		);
		expect(pairing.authorizeText).toContain(
			`to Calculator on ${new URL(stack.pageUrl).origin}`,
		);
		const host = new URL(stack.cimd.origin).host;
		expect(
			await page.eval(
				"document.querySelector('dialog.tab-mcp-connect .tab-mcp-apps').textContent",
			),
		).toContain(`${CLIENT_NAME} (${host}) connected`);
		await clickButton(
			page,
			"dialog.tab-mcp-connect",
			"Close",
			"!document.querySelector('dialog[open]')",
		);
		expect(
			await page.eval("document.querySelector('#app-list').textContent"),
		).toContain(`${CLIENT_NAME} (${host})`);
		expect(
			await page.eval("document.querySelector('#ai-status').textContent"),
		).toBe("On. 1 app is connected.");

		const client = await connectTools(pairing);
		try {
			const { tools } = await client.listTools();
			expect(tools.map((t) => t.name)).toEqual([
				"press_keys",
				"read_display",
				"clear",
				"clear_memory",
			]);
			const byName = new Map(tools.map((t) => [t.name, t]));
			expect(byName.get("read_display")?.annotations?.readOnlyHint).toBe(true);
			expect(byName.get("clear_memory")?.annotations?.destructiveHint).toBe(
				true,
			);

			// The AI app calculates; the page shows what it pressed.
			const sum = await client.callTool({
				name: "press_keys",
				arguments: { keys: "12+30=" },
			});
			expect(text(sum)).toBe("42");
			expect(await display(page)).toBe("42");
			const read = await client.callTool({ name: "read_display" });
			expect(read.structuredContent).toEqual({ display: "42", memory: 0 });

			// Keys that are not on the keypad fail validation; nothing is pressed.
			const bad = await client.callTool({
				name: "press_keys",
				arguments: { keys: "2^3" },
			});
			expect(bad.isError).toBe(true);
			expect(await display(page)).toBe("42");

			// The user stores 42 in memory with a real click.
			await page.click('[data-memory="add"]');
			await waitFor(page, "!document.querySelector('#memory-flag').hidden");

			// clear_memory asks in the page; "Don't allow" declines.
			const declined = client.callTool({ name: "clear_memory" });
			const question = await waitFor<string>(
				page,
				"document.querySelector('dialog.tab-mcp-confirm[open]')?.textContent",
			);
			expect(question).toContain("Allow Clear memory?");
			expect(question).toContain(
				`${CLIENT_NAME} (${host}) wants to run Clear memory.`,
			);
			await clickButton(page, "dialog.tab-mcp-confirm", "Don't allow");
			const no = await declined;
			expect(no.isError).toBe(true);
			expect(text(no)).toBe("The user declined");
			expect(
				(await client.callTool({ name: "read_display" })).structuredContent,
			).toEqual({ display: "42", memory: 42 });

			// The call waits for the user; "Allow" (enabled after a delay) runs it.
			const allowed = client.callTool({ name: "clear_memory" });
			await waitFor(
				page,
				"document.querySelector('dialog.tab-mcp-confirm[open]')",
			);
			let settled = false;
			void allowed.then(() => {
				settled = true;
			});
			await waitFor(
				page,
				"[...document.querySelectorAll('dialog.tab-mcp-confirm button')].find((b) => b.textContent === 'Allow' && !b.disabled)",
			);
			expect(settled).toBe(false);
			expect(
				await page.eval("!document.querySelector('#memory-flag').hidden"),
			).toBe(true);
			await clickButton(page, "dialog.tab-mcp-confirm", "Allow");
			expect(text(await allowed)).toBe("Memory cleared.");
			await waitFor(page, "document.querySelector('#memory-flag').hidden");

			const cleared = await client.callTool({ name: "clear" });
			expect(text(cleared)).toBe("0");
			expect(await display(page)).toBe("0");
		} finally {
			await client.close();
		}

		// Disconnect in the page: the app's tokens stop working at once.
		const token = pairing.provider.tokens()?.access_token ?? "";
		expect(await rawCall(pairing.address, token)).toBe(200);
		await clickButton(page, "#app-list", "Disconnect");
		await waitFor(page, "document.querySelector('#apps').hidden");
		expect(await rawCall(pairing.address, token)).toBe(401);

		// Turning AI access off ends the page's session.
		await page.click("#stop");
		await waitFor(
			page,
			"document.querySelector('#ai-status').textContent === 'Off. No AI app can use this page.'",
		);
		await page.close();
	},
	60_000,
);
