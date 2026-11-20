import { afterEach, expect, setSystemTime, test } from "bun:test";
import { newSecret } from "../src/address.ts";
import { type PairingKind, resolveConfig, siteFor } from "../src/config.ts";
import { CodeIndex, PAIRING_WINDOW_MS } from "../src/oauth/pairing.ts";
import { TabSession } from "../src/session.ts";
import { MemoryTokenStore } from "../src/store/memory.ts";
import { APP, LogCapture } from "./helpers.ts";

/** A socket whose sends can be made to fail like Bun's under backpressure. */
class FakeSocket {
	sent: Record<string, unknown>[] = [];
	closedWith: number | undefined;
	dropFrom = Number.POSITIVE_INFINITY;
	send(data: string): number {
		if (this.sent.length >= this.dropFrom) return 0;
		this.sent.push(JSON.parse(data) as Record<string, unknown>);
		return data.length;
	}
	close(code?: number): void {
		this.closedWith = code;
	}
}

const sessions: TabSession[] = [];
afterEach(() => {
	for (const s of sessions.splice(0)) s.end(1000, "test over");
});

async function readySession(
	socket: FakeSocket,
	logs = new LogCapture(),
	pairing: PairingKind = "code",
) {
	const config = resolveConfig({ development: true, allowedOrigins: "*" });
	const site = siteFor(config, "https://page.example");
	if (site === undefined) throw new Error("no site");
	const session = new TabSession(
		socket,
		"127.0.0.1",
		"https://page.example",
		{ ...site, pairing },
		{
			config,
			logger: logs.logger,
			store: new MemoryTokenStore(),
			publicUrl: () => "http://relay.test",
			codes: new CodeIndex<TabSession>(),
			claimAddress: () => undefined,
			released: () => {},
			ready: () => {},
			revokeGrant: async () => false,
			revokeAll: async () => {},
			bindIdentity: async () => {},
			signOut: async () => {},
		},
	);
	sessions.push(session);
	session.handleFrame(
		JSON.stringify({
			type: "hello",
			library: { name: "t", version: "1" },
			app: { id: APP },
			secret: newSecret(),
		}),
	);
	while (!session.ready) await Bun.sleep(1);
	return { session, logs };
}

test("the session message gives the app's address, built from the host's URL", async () => {
	const socket = new FakeSocket();
	const { session } = await readySession(socket);
	expect(session.app).toBe(APP);
	expect(socket.sent.find((m) => m["type"] === "session")?.["address"]).toBe(
		`http://relay.test/s/${APP}/mcp`,
	);
});

const forwardInput = {
	method: "POST",
	headers: {},
	body: "{}",
	rpcId: 1,
	isListen: false,
	grant: { grantId: "g", clientId: "c", scopes: ["tools"] },
	extraHeaders: {},
	onDone: () => {},
};

test("a dropped http.request send fails the request with 503 (DEC-021)", async () => {
	const socket = new FakeSocket();
	const { session, logs } = await readySession(socket);
	socket.dropFrom = socket.sent.length; // everything from now on is dropped
	const exchange = session.forward(forwardInput);
	const response = await exchange.response;
	expect(response.status).toBe(503);
	expect(
		((await response.json()) as { error: { code: number } }).error.code,
	).toBe(-31005);
	expect(session.pending.size).toBe(0);
	expect(logs.events("tab.send_dropped")).toHaveLength(1);
});

test("a send that is only queued (-1) counts as sent", async () => {
	const socket = new FakeSocket();
	const { session } = await readySession(socket);
	socket.send = (data: string) => {
		socket.sent.push(JSON.parse(data) as Record<string, unknown>);
		return -1;
	};
	const exchange = session.forward(forwardInput);
	expect(socket.sent.at(-1)?.["type"]).toBe("http.request");
	expect(exchange.done).toBe(false);
	exchange.clientClosed();
});

/** Hand the session a frame and wait until it was handled. */
async function handled(
	session: TabSession,
	socket: FakeSocket,
	message: Record<string, unknown>,
): Promise<Record<string, unknown>[]> {
	const before = socket.sent.length;
	session.handleFrame(JSON.stringify(message));
	await Bun.sleep(5);
	return socket.sent.slice(before);
}

test("DEC-202: an oidc page can be paired for ten minutes after each pairing.start, not a millisecond longer", async () => {
	const socket = new FakeSocket();
	const { session } = await readySession(socket, undefined, "oidc");
	// Forward only: the control budget refills with the time that passed.
	const t0 = Date.now() + 60_000;
	try {
		setSystemTime(t0);
		expect(session.pairingOpen).toBe(false);
		const opened = await handled(session, socket, { type: "pairing.start" });
		expect(opened).toEqual([
			{
				type: "pairing.open",
				expiresAt: new Date(t0 + PAIRING_WINDOW_MS).toISOString(),
			},
		]);
		expect(PAIRING_WINDOW_MS).toBe(600_000);
		setSystemTime(t0 + PAIRING_WINDOW_MS - 1);
		expect(session.pairingOpen).toBe(true);
		setSystemTime(t0 + PAIRING_WINDOW_MS);
		expect(session.pairingOpen).toBe(false);
		// Nothing renews it by itself: still closed much later.
		setSystemTime(t0 + 2 * PAIRING_WINDOW_MS);
		expect(session.pairingOpen).toBe(false);

		// Continue: another start counts from now.
		const t1 = t0 + 3 * PAIRING_WINDOW_MS;
		setSystemTime(t1);
		const again = await handled(session, socket, { type: "pairing.start" });
		expect(again).toEqual([
			{
				type: "pairing.open",
				expiresAt: new Date(t1 + PAIRING_WINDOW_MS).toISOString(),
			},
		]);
		expect(session.pairingOpen).toBe(true);
		// A start within the window moves the end, it does not add to it.
		setSystemTime(t1 + 1000);
		await handled(session, socket, { type: "pairing.start" });
		setSystemTime(t1 + PAIRING_WINDOW_MS + 999);
		expect(session.pairingOpen).toBe(true);
		setSystemTime(t1 + PAIRING_WINDOW_MS + 1000);
		expect(session.pairingOpen).toBe(false);

		// Closing the dialog ends it at once.
		setSystemTime(t1 + 4 * PAIRING_WINDOW_MS);
		await handled(session, socket, { type: "pairing.start" });
		expect(session.pairingOpen).toBe(true);
		expect(await handled(session, socket, { type: "pairing.stop" })).toEqual(
			[],
		);
		expect(session.pairingOpen).toBe(false);
	} finally {
		setSystemTime();
	}
});

test("DEC-202: a code page gets codes, no pairing.open, and is open while it shows one", async () => {
	const socket = new FakeSocket();
	const { session } = await readySession(socket);
	const sent = await handled(session, socket, { type: "pairing.start" });
	expect(sent.map((m) => m["type"])).toEqual(["pairing.code"]);
	expect(session.pairingOpen).toBe(true);
	await handled(session, socket, { type: "pairing.stop" });
	expect(session.pairingOpen).toBe(false);
});

test("DEC-202: a session that ends closes its window", async () => {
	const socket = new FakeSocket();
	const { session } = await readySession(socket, undefined, "oidc");
	await handled(session, socket, { type: "pairing.start" });
	expect(session.pairingOpen).toBe(true);
	session.end(1000, "test over");
	expect(session.pairingOpen).toBe(false);
});
