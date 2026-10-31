/**
 * `@ractive-ch/tab-mcp/testing`: helpers for `bun test`. The `TokenStore`
 * conformance suite (DEC-041), and an in-process relay with a token helper
 * for end-to-end tests of a page's tools without pairing by hand.
 */

import { createLogger } from "./log.ts";
import { type CreateRelayOptions, createRelay, type Relay } from "./relay.ts";
import { MemoryTokenStore } from "./store/memory.ts";
import type { TokenStore } from "./store/types.ts";
import { issueAccessToken } from "./tokens.ts";

export { tokenStoreConformance } from "./store/conformance.ts";

/** A relay started by `startTestRelay`. */
export interface TestRelay {
	relay: Relay;
	/** The relay's token store, for `tokenFor`. */
	store: TokenStore;
	/** The relay's URL, for the page's `relay` option: `http://127.0.0.1:<port>`. */
	url: string;
	stop(): Promise<void>;
}

/**
 * Start a relay in this process on a free port of 127.0.0.1, in development
 * mode, open to every page origin, with a memory store and no log output.
 * `options` override any of that. For tests only: it accepts any origin.
 */
export function startTestRelay(
	options: Omit<CreateRelayOptions, "store"> & { store?: TokenStore } = {},
): TestRelay {
	const store = options.store ?? new MemoryTokenStore();
	const relay = createRelay({
		development: true,
		port: 0,
		host: "127.0.0.1",
		allowedOrigins: "*",
		logger: createLogger("error", () => {}),
		...options,
		store,
	});
	return { relay, store, url: relay.url, stop: () => relay.stop() };
}

/**
 * An access token for a page's MCP address, written straight into the relay's
 * token store, as if an AI app had paired. Use it as `Authorization: Bearer
 * <token>` with an MCP client. It lasts an hour unless `ttlMs` says otherwise.
 */
export async function tokenFor(
	store: TokenStore,
	address: string,
	options: { clientId?: string; clientName?: string; ttlMs?: number } = {},
): Promise<string> {
	const addressId = /\/a\/([a-z2-7]{52})\/mcp$/.exec(address)?.[1];
	if (addressId === undefined)
		throw new TypeError(`not an MCP address: ${address}`);
	const { token } = await issueAccessToken(
		store,
		{
			addressId,
			clientId: options.clientId ?? "https://client.example/cimd.json",
			clientName: options.clientName ?? "Test client",
		},
		{ ttlMs: options.ttlMs ?? 3_600_000 },
	);
	return token;
}
