import { afterEach, expect, test } from "bun:test";
import { newSecret } from "../src/address.ts";
import { resolveConfig, siteFor } from "../src/config.ts";
import { TabSession } from "../src/session.ts";
import { MemoryTokenStore } from "../src/store/memory.ts";
import { LogCapture } from "./helpers.ts";

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

async function readySession(socket: FakeSocket, logs = new LogCapture()) {
	const config = resolveConfig({ development: true, allowedOrigins: "*" });
	const site = siteFor(config, "https://page.example");
	if (site === undefined) throw new Error("no site");
	const session = new TabSession(
		socket,
		"127.0.0.1",
		"https://page.example",
		site,
		{
			config,
			logger: logs.logger,
			store: new MemoryTokenStore(),
			publicUrl: () => "http://relay.test",
			claimAddress: () => undefined,
			released: () => {},
			revokeGrant: async () => false,
			revokeAll: async () => {},
		},
	);
	sessions.push(session);
	session.handleFrame(
		JSON.stringify({
			type: "hello",
			library: { name: "t", version: "1" },
			page: { title: "" },
			secret: newSecret(),
		}),
	);
	while (!session.ready) await Bun.sleep(1);
	return { session, logs };
}

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
