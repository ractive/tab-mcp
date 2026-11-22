/**
 * `@ractive-ch/tab-mcp/testing`: helpers for `bun test`. The `TokenStore`
 * conformance suite (DEC-041), and an in-process relay with a token helper
 * for end-to-end tests of a page's tools without pairing by hand.
 */

import { addressIdFromSecret } from "./address.ts";
import { createLogger } from "./log.ts";
import { type CreateRelayOptions, createRelay, type Relay } from "./relay.ts";
import { MemoryTokenStore } from "./store/memory.ts";
import type { TokenStore } from "./store/types.ts";
import { issueAccessToken } from "./test-token.ts";

export { tokenStoreConformance } from "./store/conformance.ts";

/** A relay started by `startTestRelay`. */
export interface TestRelay {
	relay: Relay;
	/** The relay's token store. */
	store: TokenStore;
	/** The relay's URL, for the page's `relay` option: `http://127.0.0.1:<port>`. */
	url: string;
	stop(): Promise<void>;
}

/**
 * Start a relay in this process on a free port of 127.0.0.1, in development
 * mode, open to every page origin, with a memory store and no log output
 * (unless `logger` or `logLevel` is given). `options` override any of that.
 * For tests only: it accepts any origin.
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
		...(options.logger === undefined && options.logLevel === undefined
			? { logger: createLogger("error", () => {}) }
			: {}),
		...options,
		store,
	});
	return { relay, store, url: relay.url, stop: () => relay.stop() };
}

/** What `tokenFor` takes besides the relay and the address. */
export interface TokenForOptions {
	/** The address secret of the page the token is for. */
	secret?: string;
	clientId?: string;
	clientName?: string;
	ttlMs?: number;
}

/**
 * An access token for the page connected at an app's MCP address, written
 * straight into the relay's token store, as if an AI app had paired. Use it
 * as `Authorization: Bearer <token>` with an MCP client. It lasts an hour
 * unless `ttlMs` says otherwise.
 *
 * The address names the app, not the page (`/s/<app>/mcp`): the token is for
 * the one page of that app that is connected now. With several connected,
 * or none yet, pass the page's address `secret`. For a relay in another
 * process, pass its token store in place of the relay, and the `secret`.
 */
export function tokenFor(
	relay: TestRelay,
	address: string,
	options?: TokenForOptions,
): Promise<string>;
export function tokenFor(
	store: TokenStore,
	address: string,
	options: TokenForOptions & { secret: string },
): Promise<string>;
export async function tokenFor(
	relay: TestRelay | TokenStore,
	address: string,
	options: TokenForOptions = {},
): Promise<string> {
	const app = /\/s\/([a-z0-9-]{1,32})\/mcp$/.exec(address)?.[1];
	if (app === undefined) throw new TypeError(`not an MCP address: ${address}`);
	let addressId: string;
	if (options.secret !== undefined) {
		addressId = addressIdFromSecret(options.secret, app);
	} else if (!("relay" in relay)) {
		throw new TypeError("with a token store, tokenFor needs the page's secret");
	} else {
		const pages = relay.relay.pagesOf(app);
		const [only] = pages;
		if (only === undefined || pages.length !== 1) {
			throw new Error(
				`${pages.length} pages of "${app}" are connected: connect one, or pass its secret`,
			);
		}
		addressId = only;
	}
	const { token } = await issueAccessToken(
		"relay" in relay ? relay.store : relay,
		{
			addressId,
			app,
			clientId: options.clientId ?? "https://client.example/cimd.json",
			clientName: options.clientName ?? "Test client",
		},
		{ ttlMs: options.ttlMs ?? 3_600_000 },
	);
	return token;
}
