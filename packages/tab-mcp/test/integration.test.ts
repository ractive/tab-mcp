/**
 * Integration: the relay as a separate process (`bun src/main.ts`) with a
 * SQLite store, a scripted tab and the MCP SDK client. Tokens are issued by
 * writing into the same SQLite file: the binary has no test switch for a
 * loopback CIMD fixture, so the OAuth flow runs in-process (oauth.test.ts).
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Subprocess } from "bun";
import { SqliteTokenStore } from "../src/store/sqlite.ts";
import {
	connectClient,
	mcpPost,
	ORIGIN,
	rpc,
	ScriptedTab,
	tokenFor,
} from "./helpers.ts";

const dir = mkdtempSync(join(tmpdir(), "tab-mcp-int-"));
const dbPath = join(dir, "tab-mcp.db");
let proc: Subprocess<"ignore", "pipe", "pipe">;
let port = 0;
const lines: string[] = [];
let stdoutDone: Promise<void>;

async function freePort(): Promise<number> {
	const s = Bun.serve({ port: 0, fetch: () => new Response() });
	const p = s.port ?? 0;
	await s.stop(true);
	return p;
}

beforeAll(async () => {
	port = await freePort();
	proc = Bun.spawn(["bun", join(import.meta.dir, "../src/main.ts")], {
		env: {
			...process.env,
			NODE_ENV: "development",
			TAB_MCP_PUBLIC_URL: `http://127.0.0.1:${port}`,
			TAB_MCP_PORT: String(port),
			TAB_MCP_HOST: "127.0.0.1",
			TAB_MCP_ALLOWED_ORIGINS: ORIGIN,
			TAB_MCP_STORE: "sqlite",
			TAB_MCP_SQLITE_PATH: dbPath,
			TAB_MCP_KEEPALIVE_S: "0.1",
			TAB_MCP_LOG_LEVEL: "debug",
		},
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	let started: () => void = () => {};
	const ready = new Promise<void>((resolve) => {
		started = resolve;
	});
	stdoutDone = (async () => {
		const decoder = new TextDecoder();
		let buffer = "";
		for await (const chunk of proc.stdout) {
			buffer += decoder.decode(chunk, { stream: true });
			let i = buffer.indexOf("\n");
			while (i >= 0) {
				const line = buffer.slice(0, i);
				buffer = buffer.slice(i + 1);
				lines.push(line);
				if (line.includes('"relay.start"')) started();
				i = buffer.indexOf("\n");
			}
		}
	})();
	await Promise.race([
		ready,
		Bun.sleep(10_000).then(() => {
			throw new Error("relay did not start");
		}),
	]);
});

afterAll(async () => {
	if (proc.exitCode === null) proc.kill("SIGKILL");
	rmSync(dir, { recursive: true, force: true });
});

test("--help prints the configuration and exits 0", async () => {
	const help = Bun.spawnSync([
		"bun",
		join(import.meta.dir, "../src/main.ts"),
		"--help",
	]);
	expect(help.exitCode).toBe(0);
	expect(help.stdout.toString()).toContain("TAB_MCP_ALLOWED_ORIGINS");
});

test("a bad configuration exits 2 with a message", () => {
	const bad = Bun.spawnSync(["bun", join(import.meta.dir, "../src/main.ts")], {
		env: {
			...process.env,
			NODE_ENV: "production",
			TAB_MCP_PUBLIC_URL: "http://relay.example",
		},
	});
	expect(bad.exitCode).toBe(2);
	expect(bad.stderr.toString()).toContain("https");
});

test("SDK client → relay process → scripted tab, with a SQLite-issued token", async () => {
	const tab = new ScriptedTab(`ws://127.0.0.1:${port}/tab`);
	const session = await tab.connect();
	expect(session.address).toBe(
		`http://127.0.0.1:${port}/a/${tab.addressId}/mcp`,
	);

	const store = new SqliteTokenStore(dbPath);
	const token = await tokenFor(store, tab.addressId);
	await store.close();

	const client = await connectClient(session.address, token);
	expect((await client.listTools()).tools.map((t) => t.name).sort()).toEqual([
		"add",
		"echo",
	]);
	const sum = await client.callTool({
		name: "add",
		arguments: { a: 40, b: 2 },
	});
	expect(sum.content).toEqual([{ type: "text", text: "42" }]);
	const slow = await client.callTool({
		name: "echo",
		arguments: { text: "PRIVATE-RESULT-9931", delayMs: 400 },
	});
	expect(slow.content).toEqual([{ type: "text", text: "PRIVATE-RESULT-9931" }]);
	await client.close();

	// A streamed response arrives in chunks, keep-alives included.
	const res = await mcpPost(
		session.address,
		rpc(9, "tools/call", {
			name: "echo",
			arguments: { text: "x", delayMs: 350 },
		}),
		{ token },
	);
	const reader = res.body?.getReader();
	let chunks = 0;
	let text = "";
	for (;;) {
		const r = await reader?.read();
		if (r === undefined || r.done) break;
		chunks++;
		text += new TextDecoder().decode(r.value);
	}
	expect(chunks).toBeGreaterThan(1);
	expect(text).toContain(": keep-alive");
	expect(text).toContain('"text":"x"');

	// Logs carry no bodies, results, tokens or secrets.
	const all = lines.join("\n");
	for (const forbidden of [
		"PRIVATE-RESULT-9931",
		token,
		tab.secret,
		tab.addressId,
		'"echo"',
	]) {
		expect(all).not.toContain(forbidden);
	}
	expect(all).toContain('"event":"mcp.request"');

	// SIGTERM: the tab gets bye shutdown and 4004, the process exits 0.
	proc.kill("SIGTERM");
	expect(await tab.next("bye")).toEqual({ type: "bye", reason: "shutdown" });
	expect((await tab.closed).code).toBe(4004);
	expect(await proc.exited).toBe(0);
	await stdoutDone;
}, 20_000);
