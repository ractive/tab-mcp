import { afterEach, expect, test } from "bun:test";
import { newSecret } from "../src/address.ts";
import { createLogger } from "../src/log.ts";
import { developmentUrl } from "../src/relay.ts";
import { startTestRelay, type TestRelay, tokenFor } from "../src/testing.ts";
import { APP, mcpPost, ScriptedTab } from "./helpers.ts";

let relay: TestRelay | undefined;
const tabs: ScriptedTab[] = [];
afterEach(async () => {
	for (const t of tabs.splice(0)) {
		if (t.ws.readyState <= 1) t.close();
	}
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

const ORIGIN = "https://page.example";
const body = { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} };

/** A connected page of `relay` that counts the requests it gets. */
async function page(appId = APP, secret?: string) {
	if (relay === undefined) throw new Error("no relay");
	const seen = { requests: 0 };
	const tab = new ScriptedTab(`${relay.url.replace("http", "ws")}/tab`, {
		origin: ORIGIN,
		appId,
		...(secret === undefined ? {} : { secret }),
		onRequest: (msg, t) => {
			seen.requests++;
			t.send({
				type: "http.response",
				id: msg.id,
				status: 200,
				headers: { "content-type": "application/json" },
				body: "{}",
			});
		},
	});
	tabs.push(tab);
	const session = await tab.connect();
	return { tab, seen, address: session.address };
}

test("game feedback 4: startTestRelay serves addresses on its own URL, and tokenFor's token reaches the one connected page", async () => {
	relay = startTestRelay({ pageWaitMs: 0 });
	expect(relay.url).toBe(`http://127.0.0.1:${relay.relay.port}`);
	const address = relay.relay.addressFor(APP);
	expect(address).toBe(`${relay.url}/s/${APP}/mcp`);
	const { seen, address: told } = await page();
	expect(told).toBe(address);

	const refused = await mcpPost(address, body, { token: "tmcp_at_nope" });
	expect(refused.status).toBe(401);

	const token = await tokenFor(relay, address);
	const accepted = await mcpPost(address, body, { token });
	expect(accepted.status).toBe(200);
	expect(seen.requests).toBe(1);
});

test("tokenFor without a secret needs exactly one connected page of the app, and says how many there are", async () => {
	relay = startTestRelay({ pageWaitMs: 0 });
	const address = relay.relay.addressFor(APP);
	// A page of another app does not count.
	await page("other-app");
	await expect(tokenFor(relay, address)).rejects.toThrow(
		`0 pages of "${APP}" are connected`,
	);
	const first = await page();
	const second = await page();
	await expect(tokenFor(relay, address)).rejects.toThrow(
		`2 pages of "${APP}" are connected`,
	);
	// Nothing was written for a refusal: no page lists a grant.
	for (const p of [first, second]) {
		expect(await relay.store.listGrants(p.tab.addressId, Date.now())).toEqual(
			[],
		);
	}
});

test("tokenFor with a secret picks that page among several, and works before the page connects", async () => {
	relay = startTestRelay({ pageWaitMs: 0 });
	const address = relay.relay.addressFor(APP);
	const first = await page();
	const second = await page();
	const token = await tokenFor(relay, address, { secret: second.tab.secret });
	expect((await mcpPost(address, body, { token })).status).toBe(200);
	expect(second.seen.requests).toBe(1);
	expect(first.seen.requests).toBe(0);

	// For a page that is not connected yet: the token waits for it.
	const secret = newSecret();
	const early = await tokenFor(relay, address, { secret });
	const notOpen = await mcpPost(address, body, { token: early });
	expect(notOpen.status).toBe(200);
	expect(await notOpen.text()).toContain("-31001");
	const late = await page(APP, secret);
	expect((await mcpPost(address, body, { token: early })).status).toBe(200);
	expect(late.seen.requests).toBe(1);
	expect(first.seen.requests).toBe(0);
});

test("tokenFor's token is for the address's app only", async () => {
	relay = startTestRelay({ pageWaitMs: 0 });
	const { seen, address } = await page();
	const token = await tokenFor(relay, address);
	const elsewhere = await mcpPost(relay.relay.addressFor("other-app"), body, {
		token,
	});
	expect(elsewhere.status).toBe(401);
	expect(seen.requests).toBe(0);
});

test("game feedback 4: tokenFor refuses something that is not an MCP address", async () => {
	relay = startTestRelay();
	const r = relay;
	for (const address of [
		`${r.url}/mcp`,
		`${r.url}/s/${APP}`,
		`${r.url}/s/Bad_App/mcp`,
		// The address of before DEC-196.
		`${r.url}/a/${"a".repeat(52)}/mcp`,
	]) {
		await expect(tokenFor(r, address)).rejects.toThrow(TypeError);
	}
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
