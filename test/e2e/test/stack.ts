/**
 * The whole chain for the end-to-end tests: a relay (development mode, memory
 * store, only the page's origin allowed, CIMD fetches from a local HTTPS
 * fixture), the calculator test page (`server.ts`),
 * headless Chrome over CDP (DEC-025), and an OAuth client like an AI app's
 * (the MCP SDK's) whose browser step is done in Chrome: the test reads the
 * pairing code from the page's dialog and types it on `/authorize`.
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
import { MemoryTokenStore, type Relay } from "@ractive-ch/tab-mcp";
import { createTestRelay } from "../../../packages/tab-mcp/src/relay.ts";
import {
	type CimdServer,
	quietLogger,
	startCimdServer,
} from "../../../packages/tab-mcp/test/oauth-helpers.ts";
import {
	Browser,
	findChrome,
	type Page,
} from "../../../packages/tab-mcp-client/test/cdp.ts";
import { serveExample } from "../server.ts";

export { findChrome, type Page };

export const CLIENT_NAME = "E2E test client";

/** An AI app's OAuth client state, with the browser step left to the test. */
export class TestProvider implements OAuthClientProvider {
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
		return "e2e-state";
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

/** An SDK client pinned to 2026-07-28. */
export function sdkClient(): Client {
	return new Client(
		{ name: "calculator-e2e", version: "1.0.0" },
		{ versionNegotiation: { mode: { pin: "2026-07-28" } } },
	);
}

/**
 * Wait in the page until `condition` (a JavaScript expression) is truthy and
 * return its value. Checked on every DOM change and every 50 ms.
 */
export function waitFor<T = unknown>(
	page: Page,
	condition: string,
	timeoutMs = 10_000,
): Promise<T> {
	return page.eval<T>(`new Promise((resolve, reject) => {
		const check = () => { try { return (${condition}); } catch { return undefined; } };
		const first = check();
		if (first) return resolve(first);
		const done = (value) => { observer.disconnect(); clearInterval(poll); clearTimeout(timer); resolve(value); };
		const observer = new MutationObserver(() => { const v = check(); if (v) done(v); });
		observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
		const poll = setInterval(() => { const v = check(); if (v) done(v); }, 50);
		const timer = setTimeout(() => { observer.disconnect(); clearInterval(poll); reject(new Error(${JSON.stringify(`timed out waiting for ${condition}`)})); }, ${timeoutMs});
	})`);
}

/**
 * Click a button by its exact text inside `scope` (a CSS selector). With
 * `until`, wait for that condition and click again while it does not hold.
 */
export async function clickButton(
	page: Page,
	scope: string,
	text: string,
	until?: string,
): Promise<void> {
	const mark = async (): Promise<string | undefined> => {
		const id = `e2e-${crypto.randomUUID()}`;
		const found = await page.eval<boolean>(`(() => {
			const b = [...document.querySelectorAll(${JSON.stringify(`${scope} button`)})].find((b) => b.textContent.trim() === ${JSON.stringify(text)});
			if (!b) return false;
			b.id = ${JSON.stringify(id)};
			return true;
		})()`);
		return found ? id : undefined;
	};
	const first = await mark();
	if (first === undefined) throw new Error(`no button "${text}" in ${scope}`);
	await page.click(`#${first}`);
	if (until === undefined) return;
	// A click lands where the button was when its box was read; if the layout
	// moved in between (the dialog resizing as its content changes), it
	// misses. Click again while the button is still there.
	for (let attempt = 1; ; attempt++) {
		try {
			await waitFor(page, until, 2_000);
			return;
		} catch (error) {
			if (attempt === 5) throw error;
		}
		const again = await mark();
		if (again !== undefined) await page.click(`#${again}`);
	}
}

export interface Stack {
	relay: Relay;
	cimd: CimdServer;
	browser: Browser;
	/** The calculator page's URL. */
	pageUrl: string;
	/** The redirect URI of the test AI app (a local server that collects callbacks). */
	redirectUri: string;
	/** The next callback's query parameters. */
	nextCallback(): Promise<URLSearchParams>;
	/** Serve a client metadata document for the test AI app; returns its client id. */
	clientId(path?: string): string;
	stop(): Promise<void>;
}

export async function startStack(chrome: string): Promise<Stack> {
	const cimd = await startCimdServer();
	const waiting: ((params: URLSearchParams) => void)[] = [];
	const callbacks = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		fetch: (req) => {
			const url = new URL(req.url);
			if (url.pathname !== "/callback")
				return new Response("Not found", { status: 404 });
			waiting.shift()?.(url.searchParams);
			return new Response("You can close this window.", {
				headers: { "content-type": "text/plain" },
			});
		},
	});
	let relayUrl = "";
	const page = serveExample({ relay: () => relayUrl, port: 0 });
	const pageOrigin = `http://127.0.0.1:${page.port}`;
	const relay = createTestRelay(
		{
			development: true,
			port: 0,
			host: "127.0.0.1",
			allowedOrigins: [pageOrigin],
			store: new MemoryTokenStore(),
			logger: quietLogger,
		},
		{ cimd: { ca: cimd.ca } },
	);
	relayUrl = relay.url;
	let browser: Browser;
	try {
		browser = await Browser.launch(chrome);
	} catch (error) {
		await relay.stop();
		await page.stop(true);
		await callbacks.stop(true);
		await cimd.stop();
		throw error;
	}
	const redirectUri = `http://127.0.0.1:${callbacks.port}/callback`;
	return {
		relay,
		cimd,
		browser,
		pageUrl: `${pageOrigin}/`,
		redirectUri,
		nextCallback: () =>
			new Promise((resolve) => {
				waiting.push(resolve);
			}),
		clientId: (path = "/e2e-client.json") =>
			cimd.serve(
				path,
				cimd.document(`${cimd.origin}${path}`, {
					client_name: CLIENT_NAME,
					// Loopback redirects match with any port (RFC 8252 §7.3).
					redirect_uris: ["http://127.0.0.1/callback"],
				}),
			),
		stop: async () => {
			await browser.close();
			await relay.stop();
			await page.stop(true);
			await callbacks.stop(true);
			await cimd.stop();
		},
	};
}

/** Open the calculator in a new tab and wait until it can connect. */
export async function openCalculator(stack: Stack): Promise<Page> {
	const page = await stack.browser.newPage();
	await page.goto(stack.pageUrl);
	await waitFor(page, "!document.querySelector('#connect').disabled");
	return page;
}

export interface Pairing {
	address: string;
	provider: TestProvider;
	/** The `/authorize` page's text, as the user saw it. */
	authorizeText: string;
	/** The dialog's visible closing buttons while the code was shown, then once paired. */
	buttonsBefore: string[];
	buttonsAfter: string[];
}

/** The texts of the visible buttons in the connect dialog's bottom row. */
export function dialogButtons(page: Page): Promise<string[]> {
	return page.eval<string[]>(
		"[...document.querySelectorAll('dialog.tab-mcp-connect[open] > .tab-mcp-actions button')].filter((b) => !b.hidden).map((b) => b.textContent)",
	);
}

/**
 * Click "Connect your AI app", let the AI app run into 401 and discover the
 * relay, then do the user's part in a second tab: open `/authorize`, type the
 * code shown in the page's dialog, click Connect. Returns once the AI app has
 * its tokens and the page lists it as connected.
 */
export async function pair(
	stack: Stack,
	calculator: Page,
	clientId: string,
): Promise<Pairing> {
	await calculator.click("#connect");
	const dialog = "dialog.tab-mcp-connect[open]";
	const address = await waitFor<string>(
		calculator,
		`document.querySelector('${dialog} .tab-mcp-address-input')?.value`,
	);
	const code = await waitFor<string>(
		calculator,
		`(document.querySelector('${dialog} .tab-mcp-code-value')?.textContent ?? '').match(/^\\d{6}$/)?.[0]`,
	);
	const buttonsBefore = await dialogButtons(calculator);

	const provider = new TestProvider(clientId, stack.redirectUri);
	const transport = new StreamableHTTPClientTransport(new URL(address), {
		authProvider: provider,
	});
	const first = await sdkClient()
		.connect(transport)
		.then(
			() => undefined,
			(error: unknown) => error,
		);
	if (!(first instanceof UnauthorizedError) || !provider.authorizationUrl) {
		throw new Error(`expected a redirect to /authorize, got ${String(first)}`);
	}

	const authorize = await stack.browser.newPage();
	await authorize.goto(provider.authorizationUrl.href);
	const authorizeText = await authorize.eval<string>("document.body.innerText");
	await authorize.eval("document.querySelector('#code').focus()");
	await authorize.send("Input.insertText", { text: code });
	const callback = stack.nextCallback();
	await authorize.click('button[value="connect"]');
	const params = await callback;
	await transport.finishAuth(params);
	await authorize.close();

	await waitFor(
		calculator,
		`document.querySelector('${dialog} .tab-mcp-status')?.textContent.endsWith('is connected.')`,
	);
	const buttonsAfter = await dialogButtons(calculator);
	return { address, provider, authorizeText, buttonsBefore, buttonsAfter };
}

/** A connected SDK client using the pairing's tokens. */
export async function connectTools(pairing: Pairing): Promise<Client> {
	const client = sdkClient();
	await client.connect(
		new StreamableHTTPClientTransport(new URL(pairing.address), {
			authProvider: pairing.provider,
		}),
	);
	return client;
}
