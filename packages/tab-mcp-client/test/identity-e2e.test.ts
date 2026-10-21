/**
 * Identity binding end to end (iteration 7 acceptance criteria): the page
 * (this library in happy-dom) proves its user with a tab assertion from the
 * `identityAssertion` hook; the MCP SDK client hits the address, gets 401,
 * registers by CIMD and opens `/authorize`; the user signs in at a local
 * OpenID Connect provider as the same person and the app connects without a
 * code. Someone else gets the mismatch error; `signOut()` cuts the
 * connection at once.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import {
	Client,
	type OAuthClientInformationMixed,
	type OAuthClientMetadata,
	type OAuthClientProvider,
	type OAuthDiscoveryState,
	type OAuthTokens,
	StreamableHTTPClientTransport,
	UnauthorizedError,
} from "@modelcontextprotocol/client";
import { Window } from "happy-dom";
import { MISMATCH_TEXT } from "../../tab-mcp/src/identity.ts";
import type { Relay } from "../../tab-mcp/src/relay.ts";
import { createTestRelay } from "../../tab-mcp/src/relay.ts";
import { MemoryTokenStore } from "../../tab-mcp/src/store/memory.ts";
import {
	type CimdServer,
	quietLogger,
	startCimdServer,
	TestBrowser,
} from "../../tab-mcp/test/oauth-helpers.ts";
import {
	type OidcProvider,
	startOidcProvider,
} from "../../tab-mcp/test/oidc-fixture.ts";
import type { TabMcp } from "../src/tab-mcp.ts";
import { MemoryStorage, mcpPost, newTab, rpc } from "./helpers.ts";

const REDIRECT = "http://127.0.0.1:33419/callback";
const PAGE_ORIGIN = "https://page.example";

/** An OAuth client provider like an AI app's, with the browser step left to the test. */
class TestProvider implements OAuthClientProvider {
	readonly clientMetadataUrl: string;
	readonly redirectUrl = REDIRECT;
	authorizationUrl: URL | undefined;
	#client: OAuthClientInformationMixed | undefined;
	#tokens: OAuthTokens | undefined;
	#verifier = "";
	#discovery: OAuthDiscoveryState | undefined;

	constructor(clientMetadataUrl: string) {
		this.clientMetadataUrl = clientMetadataUrl;
	}
	get clientMetadata(): OAuthClientMetadata {
		return {
			client_name: "SDK test client",
			redirect_uris: [REDIRECT],
			grant_types: ["authorization_code", "refresh_token"],
			response_types: ["code"],
			token_endpoint_auth_method: "none",
		};
	}
	state(): string {
		return "sdk-state";
	}
	clientInformation() {
		return this.#client;
	}
	saveClientInformation(info: OAuthClientInformationMixed): void {
		this.#client = info;
	}
	tokens() {
		return this.#tokens;
	}
	saveTokens(tokens: OAuthTokens): void {
		this.#tokens = tokens;
	}
	redirectToAuthorization(url: URL): void {
		this.authorizationUrl = url;
	}
	saveCodeVerifier(verifier: string): void {
		this.#verifier = verifier;
	}
	codeVerifier(): string {
		return this.#verifier;
	}
	saveDiscoveryState(state: OAuthDiscoveryState): void {
		this.#discovery = state;
	}
	discoveryState() {
		return this.#discovery;
	}
}

/** Bun's WebSocket sends no Origin; a browser does. */
const BunWebSocket = globalThis.WebSocket;
class OriginWebSocket extends BunWebSocket {
	constructor(url: string | URL, protocols?: string | string[]) {
		super(url, {
			headers: { Origin: PAGE_ORIGIN },
			protocols: protocols === undefined ? [] : [protocols].flat(),
		} as unknown as string[]);
	}
}

let cimd: CimdServer;
let oidc: OidcProvider;
let relay: Relay;
let window: Window;
let clientId: string;

beforeAll(async () => {
	cimd = await startCimdServer();
	oidc = await startOidcProvider();
	relay = createTestRelay(
		{
			development: true,
			port: 0,
			host: "127.0.0.1",
			allowedOrigins: [PAGE_ORIGIN],
			identity: "oidc",
			oidc: oidc.relayConfig(),
			store: new MemoryTokenStore(),
			logger: quietLogger,
		},
		{ cimd: { ca: cimd.ca } },
	);
	window = new Window({ url: `${PAGE_ORIGIN}/` });
	clientId = cimd.serve(
		"/sdk-client.json",
		cimd.document(`${cimd.origin}/sdk-client.json`, {
			client_name: "SDK test client",
			redirect_uris: [REDIRECT],
		}),
	);
	globalThis.WebSocket = OriginWebSocket as typeof WebSocket;
});
afterAll(async () => {
	globalThis.WebSocket = BunWebSocket;
	await relay.stop();
	await cimd.stop();
	await oidc.stop();
	await window.happyDOM.close();
});

function sdkClient(): Client {
	return new Client(
		{ name: "sdk-identity-e2e", version: "1.0.0" },
		{ versionNegotiation: { mode: { pin: "2026-07-28" } } },
	);
}

async function until(condition: () => boolean, what: string): Promise<void> {
	const deadline = Date.now() + 5000;
	while (!condition()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await Bun.sleep(5);
	}
}

/** A page signed in as `user`, with one tool and its dialog open. */
async function signedInPage(user: string): Promise<{
	tab: TabMcp;
	doc: Document;
	closed: Promise<void>;
}> {
	const doc = window.document as unknown as Document;
	const tab = newTab(`http://127.0.0.1:${relay.port}`, {
		appName: "calculator",
		storage: new MemoryStorage(),
		identityAssertion: ({ address }) => oidc.assertion(user, address),
	});
	await tab.registerTool({
		name: "add",
		description: "Add two numbers",
		inputSchema: {
			type: "object",
			properties: { a: { type: "number" }, b: { type: "number" } },
			required: ["a", "b"],
		},
		annotations: { readOnlyHint: true },
		execute: ({ a, b }) => Number(a) + Number(b),
	});
	const closed = tab.showConnectDialog({ document: doc });
	await until(
		() => tab.identity === "bound",
		"the relay to accept the page's user",
	);
	return { tab, doc, closed };
}

/** The AI app's first attempt: 401, discovery, CIMD, the authorization URL. */
async function startAuth(address: string) {
	const provider = new TestProvider(clientId);
	const client = sdkClient();
	const transport = new StreamableHTTPClientTransport(new URL(address), {
		authProvider: provider,
	});
	await expect(client.connect(transport)).rejects.toBeInstanceOf(
		UnauthorizedError,
	);
	const url = provider.authorizationUrl;
	if (url === undefined) throw new Error("no redirect");
	return { provider, transport, url };
}

/** The user's browser: Connect, sign in at the provider, back at the relay. */
async function signInAtProvider(url: URL, user: string) {
	const browser = new TestBrowser(relay.url);
	const page = await browser.open(url.href);
	expect(page.status).toBe(200);
	expect(page.html).toContain("No code is needed");
	const posted = await browser.submit(page, { action: "connect" });
	expect(posted.status).toBe(303);
	oidc.signedInAs = user;
	return browser.open(await oidc.signIn(posted.location ?? ""));
}

test("the page's user connects an SDK client without a code, calls a tool, and signOut() cuts it at once", async () => {
	const { tab, doc, closed } = await signedInPage("alice");
	const dialog = () => doc.querySelector(".tab-mcp-connect");
	expect(tab.session?.pairing).toBe("oidc");
	await until(
		() =>
			(dialog()?.querySelector(".tab-mcp-sign-in") as HTMLElement | null)
				?.hidden === false,
		"the sign-in hint",
	);
	expect(
		(dialog()?.querySelector(".tab-mcp-code") as HTMLElement | null)?.hidden,
	).toBe(true);
	const address = tab.address ?? "";

	const { provider, transport, url } = await startAuth(address);
	const done = await signInAtProvider(url, "alice");
	expect(done.status).toBe(303);
	const callback = new URL(done.location ?? "");
	expect(callback.searchParams.get("iss")).toBe(relay.url);
	await transport.finishAuth(callback.searchParams);
	await until(() => tab.grants.length === 1, "grant.added");

	const client = sdkClient();
	await client.connect(
		new StreamableHTTPClientTransport(new URL(address), {
			authProvider: provider,
		}),
	);
	const sum = await client.callTool({
		name: "add",
		arguments: { a: 40, b: 2 },
	});
	expect(sum.content).toEqual([{ type: "text", text: "42" }]);
	await client.close();

	// Logout in the web app: the relay revokes at once, the page drops the app.
	expect(tab.signOut()).toBe(true);
	expect(tab.identity).toBe("none");
	await until(() => tab.grants.length === 0, "grant.removed");
	const after = await mcpPost(address, rpc(1, "tools/list"), {
		token: provider.tokens()?.access_token ?? "",
	});
	expect(after.status).toBe(401);

	(dialog() as HTMLDialogElement | null)?.close();
	await closed;
	tab.disconnect();
}, 30_000);

test("an AI app signed in as someone else gets the mismatch error and no code", async () => {
	const { tab, doc, closed } = await signedInPage("alice");
	const { url } = await startAuth(tab.address ?? "");
	const done = await signInAtProvider(url, "bob");
	expect(done.status).toBe(403);
	expect(done.location).toBeUndefined();
	expect(done.html).toContain(MISMATCH_TEXT);
	expect(tab.grants).toEqual([]);
	(doc.querySelector(".tab-mcp-connect") as HTMLDialogElement | null)?.close();
	await closed;
	tab.disconnect();
}, 30_000);

test("a refused assertion is reported; refreshIdentity() binds after sign-in", async () => {
	let user: string | null = null;
	const tab = newTab(`http://127.0.0.1:${relay.port}`, {
		storage: new MemoryStorage(),
		identityAssertion: ({ address }) =>
			user === null
				? null
				: user === "bad"
					? oidc.assertion("alice", `${address}x`)
					: oidc.assertion(user, address),
	});
	const states: string[] = [];
	tab.addEventListener("identitychange", (e) => states.push(e.detail.state));
	await tab.connect({ resume: true });
	await until(() => states.includes("none"), "nobody signed in");
	user = "bad";
	expect(await tab.refreshIdentity()).toBe(false);
	expect(tab.identity).toBe("refused");
	user = "alice";
	expect(await tab.refreshIdentity()).toBe(true);
	expect(tab.identity).toBe("bound");
	tab.disconnect();
	expect(tab.identity).toBe("none");
});
