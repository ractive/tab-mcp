/**
 * The whole pairing flow end to end (iteration 3 acceptance criteria): the MCP SDK
 * client hits a page's address, gets 401 with `resource_metadata`, discovers
 * the relay, registers through a Client ID Metadata Document served over
 * HTTPS by a local fixture, and opens `/authorize`. The page (this library,
 * with its default dialog in happy-dom) shows the code; the test types it like
 * a user. The client gets tokens, calls a tool, refreshes; reusing the old
 * refresh token revokes the grant, and the dialog follows along.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import {
	auth,
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
import type { Relay } from "../../tab-mcp/src/relay.ts";
import { createTestRelay } from "../../tab-mcp/src/relay.ts";
import { MemoryTokenStore } from "../../tab-mcp/src/store/memory.ts";
import {
	type CimdServer,
	postForm,
	quietLogger,
	startCimdServer,
	TestBrowser,
} from "../../tab-mcp/test/oauth-helpers.ts";
import type { Grant } from "../src/types.ts";
import { MemoryStorage, mcpPost, newTab, rpc } from "./helpers.ts";

const REDIRECT = "http://127.0.0.1:33418/callback";

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

let cimd: CimdServer;
let relay: Relay;
let window: Window;

beforeAll(async () => {
	cimd = await startCimdServer();
	relay = createTestRelay(
		{
			development: true,
			port: 0,
			host: "127.0.0.1",
			allowedOrigins: "*", // Bun's WebSocket sends no Origin
			store: new MemoryTokenStore(),
			logger: quietLogger,
		},
		{ cimd: { ca: cimd.ca } },
	);
	window = new Window({ url: "https://page.example/" });
});
afterAll(async () => {
	await relay.stop();
	await cimd.stop();
	await window.happyDOM.close();
});

function sdkClient(): Client {
	return new Client(
		{ name: "sdk-oauth-e2e", version: "1.0.0" },
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

test("SDK client pairs with a tab through the code shown in its dialog, calls a tool, refreshes; refresh reuse revokes", async () => {
	const clientId = cimd.serve(
		"/sdk-client.json",
		cimd.document(`${cimd.origin}/sdk-client.json`, {
			client_name: "SDK test client",
			redirect_uris: ["http://127.0.0.1/callback"],
		}),
	);

	// The page: one tool, the default connect dialog in a DOM.
	const doc = window.document as unknown as Document;
	const tab = newTab(`http://127.0.0.1:${relay.port}`, {
		appName: "calculator",
		storage: new MemoryStorage(),
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
	const dialogClosed = tab.showConnectDialog({ document: doc });
	const dialog = () => doc.querySelector(".tab-mcp-connect");
	await until(() => tab.address !== undefined, "the session");
	const address = tab.address ?? "";
	const shownCode = () =>
		dialog()?.querySelector(".tab-mcp-code-value")?.textContent ?? "";
	await until(() => /^\d{6}$/.test(shownCode()), "a code in the dialog");
	expect(
		(
			dialog()?.querySelector(
				".tab-mcp-address-input",
			) as HTMLInputElement | null
		)?.value,
	).toBe(address);

	// The AI app: no token yet → 401 → discovery → CIMD → redirect.
	const provider = new TestProvider(clientId);
	const first = sdkClient();
	const firstTransport = new StreamableHTTPClientTransport(new URL(address), {
		authProvider: provider,
	});
	await expect(first.connect(firstTransport)).rejects.toBeInstanceOf(
		UnauthorizedError,
	);
	const authorizationUrl = provider.authorizationUrl;
	if (authorizationUrl === undefined) throw new Error("no redirect");
	expect(authorizationUrl.origin).toBe(relay.url);
	expect(authorizationUrl.searchParams.get("client_id")).toBe(clientId);
	expect(authorizationUrl.searchParams.get("code_challenge_method")).toBe(
		"S256",
	);
	expect(authorizationUrl.searchParams.get("resource")).toBe(address);
	expect(authorizationUrl.searchParams.get("scope")).toBe("tools");

	// The user: the page names the AI app and the page, the code is typed.
	const browser = new TestBrowser(relay.url);
	const page = await browser.open(authorizationUrl.href);
	expect(page.html).toContain("<strong>SDK test client</strong>");
	expect(page.html).toContain("<strong>calculator</strong>");
	const done = await browser.submit(page, {
		action: "connect",
		code: shownCode(),
	});
	expect(done.status).toBe(303);
	const callback = new URL(done.location ?? "");
	expect(callback.searchParams.get("iss")).toBe(relay.url);
	expect(callback.searchParams.get("state")).toBe("sdk-state");

	// The AI app finishes: code + PKCE → tokens (the SDK checks iss).
	await firstTransport.finishAuth(callback.searchParams);
	const tokens1 = provider.tokens();
	expect(tokens1?.refresh_token).toBeDefined();

	// The page shows "<client> connected".
	await until(() => tab.grants.length === 1, "grant.added");
	const grant = tab.grants[0] as Grant;
	expect(grant.client.name).toBe("SDK test client");
	expect(grant.client.host).toBe(new URL(clientId).host);
	const status = dialog()?.querySelector(".tab-mcp-status")?.textContent ?? "";
	expect(status).toBe(
		`SDK test client (${new URL(clientId).host}) is connected.`,
	);
	expect(dialog()?.querySelector(".tab-mcp-apps")?.textContent).toContain(
		"SDK test client",
	);

	// Tool calls with the token.
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

	// Refresh: new access and refresh tokens; tools work with them.
	expect(await auth(provider, { serverUrl: address })).toBe("AUTHORIZED");
	const tokens2 = provider.tokens();
	expect(tokens2?.refresh_token).not.toBe(tokens1?.refresh_token);
	expect(tokens2?.access_token).not.toBe(tokens1?.access_token);
	const again = sdkClient();
	await again.connect(
		new StreamableHTTPClientTransport(new URL(address), {
			authProvider: provider,
		}),
	);
	expect((await again.listTools()).tools.map((t) => t.name)).toEqual(["add"]);
	await again.close();

	// Someone replays the old refresh token: refused, the grant is revoked,
	// the current tokens die and the page drops the app.
	const replay = await postForm(`${relay.url}/token`, {
		grant_type: "refresh_token",
		refresh_token: tokens1?.refresh_token ?? "",
		client_id: clientId,
	});
	expect(replay.status).toBe(400);
	expect(((await replay.json()) as { error: string }).error).toBe(
		"invalid_grant",
	);
	await until(() => tab.grants.length === 0, "grant.removed");
	expect(
		(
			await mcpPost(address, rpc(1, "tools/list"), {
				token: tokens2?.access_token ?? "",
			})
		).status,
	).toBe(401);
	const refused = await postForm(`${relay.url}/token`, {
		grant_type: "refresh_token",
		refresh_token: tokens2?.refresh_token ?? "",
		client_id: clientId,
	});
	expect(refused.status).toBe(400);

	(dialog() as HTMLDialogElement | null)?.close();
	await dialogClosed;
	tab.disconnect();
}, 30_000);

test("Disconnect in the dialog revokes the app's tokens at once", async () => {
	const clientId = cimd.serve(
		"/sdk-client-2.json",
		cimd.document(`${cimd.origin}/sdk-client-2.json`, {
			client_name: "Second client",
			redirect_uris: ["http://127.0.0.1/callback"],
		}),
	);
	const doc = window.document as unknown as Document;
	const tab = newTab(`http://127.0.0.1:${relay.port}`, {
		storage: new MemoryStorage(),
	});
	const dialogClosed = tab.showConnectDialog({ document: doc });
	const dialog = () => doc.querySelector(".tab-mcp-connect");
	await until(() => tab.pairingCode !== undefined, "a code");
	const address = tab.address ?? "";

	const provider = new TestProvider(clientId);
	const transport = new StreamableHTTPClientTransport(new URL(address), {
		authProvider: provider,
	});
	await expect(sdkClient().connect(transport)).rejects.toBeInstanceOf(
		UnauthorizedError,
	);
	const browser = new TestBrowser(relay.url);
	const page = await browser.open(provider.authorizationUrl?.href ?? "");
	// Bun's WebSocket sends no Origin; a browser always does.
	expect(page.html).toContain(
		"to tools from a page that did not say where it runs",
	);
	const done = await browser.submit(page, {
		action: "connect",
		code: tab.pairingCode?.code ?? "",
	});
	await transport.finishAuth(new URL(done.location ?? "").searchParams);
	const token = provider.tokens()?.access_token ?? "";
	expect((await mcpPost(address, rpc(1, "tools/list"), { token })).status).toBe(
		200,
	);

	await until(() => tab.grants.length === 1, "grant.added");
	const disconnect = [...(dialog()?.querySelectorAll("button") ?? [])].find(
		(b) => b.textContent === "Disconnect",
	) as HTMLButtonElement | undefined;
	disconnect?.click();
	await until(() => tab.grants.length === 0, "grant.removed");
	expect((await mcpPost(address, rpc(2, "tools/list"), { token })).status).toBe(
		401,
	);

	(dialog() as HTMLDialogElement | null)?.close();
	await dialogClosed;
	tab.disconnect();
}, 30_000);
