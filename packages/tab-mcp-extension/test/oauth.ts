/**
 * The AI app's side for the end-to-end tests of filling in the code
 * (DEC-203), in Chrome and in Firefox: a relay in this process that knows
 * OAuth clients by their metadata documents (a local HTTPS fixture, the
 * relay's own test helpers), the AI app's callback, a look-alike of the
 * pairing page on another origin, and the MCP SDK's client whose browser
 * step the test does in the browser.
 */

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
import { MemoryTokenStore } from "@ractive-ch/tab-mcp";
import { createTestRelay, type Relay } from "../../tab-mcp/src/relay.ts";
import {
	type CimdServer,
	quietLogger,
	startCimdServer,
	testUrls,
} from "../../tab-mcp/test/oauth-helpers.ts";

export const CLIENT_NAME = "Fill test AI";

/** An AI app's OAuth state, its browser step left to the test. */
export class Provider implements OAuthClientProvider {
	readonly clientMetadataUrl: string;
	readonly redirectUrl: string;
	authorizationUrl: URL | undefined;
	#client: OAuthClientInformationMixed | undefined;
	#tokens: OAuthTokens | undefined;
	#verifier = "";
	#discovery: OAuthDiscoveryState | undefined;
	constructor(clientMetadataUrl: string, redirectUrl: string) {
		this.clientMetadataUrl = clientMetadataUrl;
		this.redirectUrl = redirectUrl;
	}
	get clientMetadata(): OAuthClientMetadata {
		return {
			client_name: CLIENT_NAME,
			redirect_uris: [this.redirectUrl],
			grant_types: ["authorization_code", "refresh_token"],
			response_types: ["code"],
			token_endpoint_auth_method: "none",
		};
	}
	state(): string {
		return "fill-state";
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

export const sdkClient = (): Client =>
	new Client(
		{ name: "fill-e2e", version: "1.0.0" },
		{ versionNegotiation: { mode: { pin: "2026-07-28" } } },
	);

/** The relay's pairing form for `app`, copied onto another origin. */
const lookAlike = (app: string) => `<!doctype html><title>Connect</title>
<form method="post" action="/authorize" data-tab-mcp-pairing="1" data-app="${app}" data-client-name="Claude" data-client-host="claude.ai">
<input id="code" name="code" type="text" data-tab-mcp-field="code" required>
<button type="submit" name="action" value="connect" data-tab-mcp-action="connect">Connect</button>
</form>`;

export interface OAuthStack {
	relay: Relay;
	cimd: CimdServer;
	/** An http page of another origin on the relay's host, to start from. */
	blank: string;
	/** The look-alike of the pairing page: the relay's host, another port. */
	lookAlike: string;
	/** The AI app's client id (its metadata document's address). */
	clientId: string;
	redirectUri: string;
	/** The next callback's query parameters. */
	nextCallback(): Promise<URLSearchParams>;
	stop(): Promise<void>;
}

/** The relay and the AI app's side; the look-alike names `app`. */
export async function startOAuth(app: string): Promise<OAuthStack> {
	const cimd = await startCimdServer();
	const relay = createTestRelay(
		{
			development: true,
			port: 0,
			host: "127.0.0.1",
			allowedOrigins: "*",
			store: new MemoryTokenStore(),
			logger: quietLogger,
		},
		{ cimdUrls: testUrls(cimd.ca) },
	);
	const waiting: ((params: URLSearchParams) => void)[] = [];
	// The AI app's callback and the look-alike, on 127.0.0.1 with another
	// port: other origins on the relay's host.
	const pages = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		fetch: (req) => {
			const url = new URL(req.url);
			if (url.pathname === "/callback") {
				waiting.shift()?.(url.searchParams);
				return new Response("You can close this window.");
			}
			return new Response(
				url.pathname === "/authorize" ? lookAlike(app) : "<!doctype html>",
				{ headers: { "content-type": "text/html; charset=utf-8" } },
			);
		},
	});
	const origin = `http://127.0.0.1:${pages.port}`;
	const path = "/fill-client.json";
	const clientId = cimd.serve(
		path,
		cimd.document(`${cimd.origin}${path}`, {
			client_name: CLIENT_NAME,
			// Loopback redirects match with any port (RFC 8252 §7.3).
			redirect_uris: ["http://127.0.0.1/callback"],
		}),
	);
	return {
		relay,
		cimd,
		blank: `${origin}/`,
		lookAlike: `${origin}/authorize?client_id=x`,
		clientId,
		redirectUri: `${origin}/callback`,
		nextCallback: () =>
			new Promise((resolve) => {
				waiting.push(resolve);
			}),
		stop: async () => {
			await relay.stop();
			await pages.stop(true);
			await cimd.stop();
		},
	};
}

/** The AI app runs into 401 at `address` and gets its `/authorize` address. */
export async function authorizeUrl(
	stack: OAuthStack,
	address: string,
): Promise<{
	url: string;
	provider: Provider;
	transport: StreamableHTTPClientTransport;
}> {
	const provider = new Provider(stack.clientId, stack.redirectUri);
	const transport = new StreamableHTTPClientTransport(new URL(address), {
		authProvider: provider,
	});
	const first = await sdkClient()
		.connect(transport)
		.then(
			() => undefined,
			(error: unknown) => error,
		);
	if (!(first instanceof UnauthorizedError) || !provider.authorizationUrl)
		throw new Error(`expected a redirect to /authorize, got ${String(first)}`);
	return { url: provider.authorizationUrl.href, provider, transport };
}

/**
 * Finish the AI app's sign-in with the callback's `params` and list its
 * tools: the AI app is paired end to end.
 */
export async function toolsAfter(
	address: string,
	provider: Provider,
	params: URLSearchParams,
): Promise<string[]> {
	const transport = new StreamableHTTPClientTransport(new URL(address), {
		authProvider: provider,
	});
	await transport.finishAuth(params);
	const client = sdkClient();
	await client.connect(transport);
	try {
		return (await client.listTools()).tools.map((t) => t.name);
	} finally {
		await client.close();
	}
}
