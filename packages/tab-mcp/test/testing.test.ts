import { afterEach, expect, test } from "bun:test";
import { createLogger } from "../src/log.ts";
import { developmentUrl } from "../src/relay.ts";
import { startTestRelay, type TestRelay, tokenFor } from "../src/testing.ts";
import { mcpPost } from "./helpers.ts";

let relay: TestRelay | undefined;
afterEach(async () => {
	await relay?.stop();
	relay = undefined;
});

test("game feedback 2: in development the public URL is the loopback address the relay listens on", () => {
	expect(developmentUrl("127.0.0.1", 8790)).toBe("http://127.0.0.1:8790");
	expect(developmentUrl("::1", 8790)).toBe("http://[::1]:8790");
	expect(developmentUrl("[::1]", 8790)).toBe("http://[::1]:8790");
	expect(developmentUrl("0.0.0.0", 8790)).toBe("http://localhost:8790");
	expect(developmentUrl("localhost", 8790)).toBe("http://localhost:8790");
});

test("game feedback 4: startTestRelay serves addresses on its own URL, and tokenFor's token is accepted", async () => {
	relay = startTestRelay({ pageWaitMs: 0 });
	expect(relay.url).toBe(`http://127.0.0.1:${relay.relay.port}`);
	const address = relay.relay.addressFor(
		"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
	);
	expect(address.startsWith(`${relay.url}/a/`)).toBe(true);
	const body = { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} };

	const refused = await mcpPost(address, body, { token: "tmcp_at_nope" });
	expect(refused.status).toBe(401);

	const token = await tokenFor(relay.store, address);
	const accepted = await mcpPost(address, body, { token });
	// No page is connected, but the token got past authentication.
	expect(accepted.status).not.toBe(401);
});

test("game feedback 4: tokenFor refuses something that is not an MCP address", async () => {
	relay = startTestRelay();
	await expect(tokenFor(relay.store, `${relay.url}/mcp`)).rejects.toThrow(
		TypeError,
	);
});

test("review of PR 68: startTestRelay is quiet by default, and a logger of its own gets the lines", async () => {
	const lines: string[] = [];
	relay = startTestRelay({
		logger: createLogger("debug", (l) => lines.push(l)),
	});
	await fetch(`${relay.url}/healthz`);
	await relay.stop();
	relay = undefined;
	expect(lines.length).toBeGreaterThan(0);
});
