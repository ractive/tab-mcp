/**
 * Integration: the relay as its own process (`bun packages/tab-mcp/src/main.ts`)
 * with a SQLite store, this library in Bun as the tab, and the MCP SDK client
 * as the AI app. The token is written into the same SQLite file (the binary
 * has no test switch for a loopback CIMD fixture; OAuth: oauth-e2e.test.ts),
 * for the page's secret: `tokenFor` asks a relay in this process which page
 * is connected, and this one is not.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addressIdFromSecret, SqliteTokenStore } from "@ractive-ch/tab-mcp";
import type { Subprocess } from "bun";
import { issueAccessToken } from "../../tab-mcp/src/test-token.ts";
import { connectClient, MemoryStorage, newTab, nextEnd } from "./helpers.ts";

const dir = mkdtempSync(join(tmpdir(), "tab-mcp-client-int-"));
const dbPath = join(dir, "tab-mcp.db");
const main = join(import.meta.dir, "../../tab-mcp/src/main.ts");
let proc: Subprocess<"ignore", "pipe", "pipe">;
let port = 0;
const lines: string[] = [];

beforeAll(async () => {
	const probe = Bun.serve({ port: 0, fetch: () => new Response() });
	port = probe.port ?? 0;
	await probe.stop(true);
	proc = Bun.spawn(["bun", main], {
		env: {
			...process.env,
			NODE_ENV: "development",
			TAB_MCP_PUBLIC_URL: `http://127.0.0.1:${port}`,
			TAB_MCP_PORT: String(port),
			TAB_MCP_HOST: "127.0.0.1",
			TAB_MCP_ALLOWED_ORIGINS: "*", // Bun's WebSocket sends no Origin
			TAB_MCP_STORE: "sqlite",
			TAB_MCP_SQLITE_PATH: dbPath,
			TAB_MCP_LOG_LEVEL: "debug",
		},
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	await new Promise<void>((resolve, reject) => {
		const timer = setTimeout(
			() => reject(new Error("relay did not start")),
			10_000,
		);
		void (async () => {
			const decoder = new TextDecoder();
			let buffer = "";
			for await (const chunk of proc.stdout) {
				buffer += decoder.decode(chunk, { stream: true });
				for (let i = buffer.indexOf("\n"); i >= 0; i = buffer.indexOf("\n")) {
					const line = buffer.slice(0, i);
					buffer = buffer.slice(i + 1);
					lines.push(line);
					if (line.includes('"relay.start"')) {
						clearTimeout(timer);
						resolve();
					}
				}
			}
		})();
	});
});

afterAll(async () => {
	if (proc.exitCode === null) {
		proc.kill("SIGKILL");
		await proc.exited;
	}
	rmSync(dir, { recursive: true, force: true });
});

test("SDK client → relay process → TabMcp in Bun", async () => {
	const storage = new MemoryStorage();
	const tab = newTab(`http://127.0.0.1:${port}`, {
		appName: "integration",
		storage,
	});
	await tab.registerTool({
		name: "multiply",
		title: "Multiply",
		description: "Multiply two numbers",
		inputSchema: {
			type: "object",
			properties: { a: { type: "number" }, b: { type: "number" } },
			required: ["a", "b"],
		},
		execute: ({ a, b }) => `${Number(a) * Number(b)} SECRET-RESULT-4711`,
	});
	const session = await tab.connect();
	expect(session.address).toBe(`http://127.0.0.1:${port}/s/test-page/mcp`);
	const secret = [...storage.items.values()][0] as string;
	const addressId = addressIdFromSecret(secret, "test-page");

	const store = new SqliteTokenStore(dbPath);
	const { token } = await issueAccessToken(
		store,
		{
			addressId,
			app: "test-page",
			clientId: "https://client.example/cimd.json",
			clientName: "Test client",
		},
		{ ttlMs: 3_600_000 },
	);
	await store.close();

	const client = await connectClient(session.address, token);
	expect((await client.listTools()).tools.map((t) => t.name)).toEqual([
		"multiply",
	]);
	const result = await client.callTool({
		name: "multiply",
		arguments: { a: 6, b: 7 },
	});
	expect(result.content).toEqual([
		{ type: "text", text: "42 SECRET-RESULT-4711" },
	]);
	await client.close();

	// The relay logs no results, tokens or secrets: not the page's secret
	// either, and its address id only shortened (the URL no longer has it).
	const log = lines.join("\n");
	expect(log).toContain('"event":"mcp.request"');
	expect(log).toContain('"app":"test-page"');
	expect(log).toContain("@ractive-ch/tab-mcp-client@");
	for (const hidden of [
		"SECRET-RESULT-4711",
		token,
		'"multiply"',
		secret,
		addressId,
	])
		expect(log).not.toContain(hidden);

	// SIGTERM: the tab hears "shutdown".
	const gone = nextEnd(tab);
	proc.kill("SIGTERM");
	expect(await gone).toEqual({ state: "reconnecting", reason: "shutdown" });
	tab.disconnect();
	expect(await proc.exited).toBe(0);
}, 20_000);
