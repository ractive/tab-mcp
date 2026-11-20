/**
 * One fixed address per app (iteration 45, DEC-196 to DEC-199): the address
 * `/s/<app>/mcp` names an app, the typed code alone finds the tab, and the
 * pairing page is shown before the relay knows which page is meant. The code
 * itself is pinned in pairing.test.ts, the OAuth rules in oauth.test.ts, the
 * limits per network in oauth-hardening.test.ts.
 */
import {
	afterAll,
	afterEach,
	beforeAll,
	describe,
	expect,
	test,
} from "bun:test";
import { shortAddress } from "../src/address.ts";
import { identityKey } from "../src/identity.ts";
import { NO_PAGE_TEXT } from "../src/oauth/oidc.ts";
import { normalizeCode } from "../src/oauth/pairing.ts";
import type { CreateRelayOptions, RelayTestHooks } from "../src/relay.ts";
import {
	APP,
	mcpPost,
	ORIGIN,
	rpc,
	ScriptedTab,
	sdkRequestHandler,
	type TabOptions,
	waitFor,
} from "./helpers.ts";
import {
	type AuthorizePage,
	authorizeUrl,
	type CimdServer,
	type OAuthTestRelay,
	pkce,
	postForm,
	startCimdServer,
	startOAuthRelay,
	TestBrowser,
} from "./oauth-helpers.ts";
import { type OidcProvider, startOidcProvider } from "./oidc-fixture.ts";

let cimd: CimdServer;
let clientId: string;
let provider: OidcProvider;
const relays: OAuthTestRelay[] = [];
const tabs: ScriptedTab[] = [];
const REDIRECT = "http://127.0.0.1:4567/callback";

beforeAll(async () => {
	cimd = await startCimdServer();
	clientId = cimd.serve(
		"/client.json",
		cimd.document(`${cimd.origin}/client.json`),
	);
	provider = await startOidcProvider();
});
afterAll(async () => {
	await cimd.stop();
	await provider.stop();
});
afterEach(async () => {
	for (const t of tabs.splice(0)) if (t.ws.readyState <= 1) t.close();
	for (const r of relays.splice(0)) await r.stop();
	provider.signedInAs = undefined;
});

function relay(
	options: CreateRelayOptions = {},
	hooks: RelayTestHooks = {},
): OAuthTestRelay {
	const r = startOAuthRelay(cimd, options, hooks);
	relays.push(r);
	return r;
}

function tab(r: OAuthTestRelay, options: TabOptions = {}): ScriptedTab {
	const t = new ScriptedTab(r.wsUrl, options);
	tabs.push(t);
	return t;
}

/** A tab that notes in `seen` each request that reaches it. */
function namedTab(
	r: OAuthTestRelay,
	seen: string[],
	name: string,
	options: TabOptions = {},
): ScriptedTab {
	return tab(r, {
		...options,
		onRequest: (msg, t) => {
			seen.push(name);
			return sdkRequestHandler(msg, t);
		},
	});
}

type Page = AuthorizePage & { location?: string };

function open(
	r: OAuthTestRelay,
	address: string,
	browser: TestBrowser,
	params: Record<string, string> = {},
): Promise<Page> {
	return browser.open(
		authorizeUrl(r.url, {
			client_id: clientId,
			redirect_uri: REDIRECT,
			code_challenge: pkce().challenge,
			resource: address,
			...params,
		}),
	);
}

interface Tokens {
	access_token: string;
	refresh_token: string;
}

/** Exchange the code of a redirect back to the client. */
async function tokensFrom(
	r: OAuthTestRelay,
	location: string | undefined,
	verifier: string,
	address: string,
): Promise<Tokens> {
	const res = await postForm(`${r.url}/token`, {
		grant_type: "authorization_code",
		code: new URL(location ?? "").searchParams.get("code") ?? "",
		redirect_uri: REDIRECT,
		code_verifier: verifier,
		client_id: clientId,
		resource: address,
	});
	expect(res.status).toBe(200);
	return (await res.json()) as Tokens;
}

/** The whole flow at `address` with a pairing code. */
async function pairByCode(
	r: OAuthTestRelay,
	address: string,
	code: string,
	browser = new TestBrowser(r.url),
): Promise<Tokens> {
	const { verifier, challenge } = pkce();
	const page = await open(r, address, browser, { code_challenge: challenge });
	expect(page.status).toBe(200);
	const done = await browser.submit(page, { action: "connect", code });
	expect(done.status).toBe(303);
	return tokensFrom(r, done.location, verifier, address);
}

const add = () =>
	rpc(1, "tools/call", { name: "add", arguments: { a: 1, b: 2 } });

/** Call the `add` tool; whether a page answered it. */
async function callAdd(address: string, token: string): Promise<boolean> {
	const res = await mcpPost(address, add(), { token });
	expect(res.status).toBe(200);
	return (await res.text()).includes('"text":"3"');
}

/** A well-formed code that none of `codes` is. */
function wrongFor(...codes: string[]): string {
	const live = new Set(codes.map((c) => normalizeCode(c)));
	for (const candidate of ["BBBB-BBBB", "CCCC-CCCC", "DDDD-DDDD"]) {
		if (!live.has(normalizeCode(candidate))) return candidate;
	}
	return "FFFF-FFFF";
}

const WRONG_TEXT = "That code is not right, or it has expired.";

/** The elements of a page with their attributes as written (not decoded). */
function elements(
	html: string,
	selector: string,
): { tag: string; attributes: Record<string, string> }[] {
	const out: { tag: string; attributes: Record<string, string> }[] = [];
	new HTMLRewriter()
		.on(selector, {
			element(el) {
				out.push({
					tag: el.tagName,
					attributes: Object.fromEntries(el.attributes),
				});
			},
		})
		.transform(html);
	return out;
}

/** A page without what differs between any two requests. */
function stable(page: Page): string {
	return page.html
		.replace(/name="request_id" value="[^"]+"/, 'name="request_id" value=""')
		.replace(/name="csrf" value="[^"]+"/, 'name="csrf" value=""');
}

describe("the code alone finds the tab (DEC-196)", () => {
	test("two tabs of one app share its address; each code pairs its own tab, and each token reaches only that tab", async () => {
		const r = relay();
		const seen: string[] = [];
		const a = namedTab(r, seen, "a");
		const b = namedTab(r, seen, "b");
		const address = (await a.connect()).address;
		expect((await b.connect()).address).toBe(address);
		expect(address).toBe(r.relay.addressFor(APP));
		expect(address).toBe(`${r.url}/s/${APP}/mcp`);
		expect(r.relay.pagesOf(APP).sort()).toEqual(
			[a.addressId, b.addressId].sort(),
		);
		const codeA = await a.startPairing();
		const codeB = await b.startPairing();
		expect(codeA).not.toBe(codeB);

		// The second tab's code, typed at the address both have.
		const forB = await pairByCode(r, address, codeB);
		const addedB = (await b.next("grant.added")) as {
			grant: { grantId: string };
		};
		expect(((await b.next("pairing.code")) as { reason: string }).reason).toBe(
			"used",
		);
		// The other tab heard nothing: no grant, and its code is still its code.
		await Bun.sleep(30);
		expect(a.received.filter((m) => m.type !== "ping")).toEqual([]);
		expect(a.pairingCode).toBe(codeA);

		const forA = await pairByCode(r, address, codeA);
		const addedA = (await a.next("grant.added")) as {
			grant: { grantId: string };
		};
		expect(addedA.grant.grantId).not.toBe(addedB.grant.grantId);
		await Bun.sleep(30);
		expect(b.received.some((m) => m.type === "grant.added")).toBe(false);

		const grantsOf = async (t: ScriptedTab) =>
			(await r.store.listGrants(t.addressId, Date.now())).map((g) => g.grantId);
		expect(await grantsOf(a)).toEqual([addedA.grant.grantId]);
		expect(await grantsOf(b)).toEqual([addedB.grant.grantId]);

		expect(await callAdd(address, forB.access_token)).toBe(true);
		expect(seen).toEqual(["b"]);
		expect(await callAdd(address, forA.access_token)).toBe(true);
		expect(seen).toEqual(["b", "a"]);
		for (let i = 0; i < 3; i++) await callAdd(address, forB.access_token);
		expect(seen).toEqual(["b", "a", "b", "b", "b"]);

		// A refresh keeps the tab.
		const refreshed = await postForm(`${r.url}/token`, {
			grant_type: "refresh_token",
			refresh_token: forA.refresh_token,
			client_id: clientId,
			resource: address,
		});
		expect(refreshed.status).toBe(200);
		const again = (await refreshed.json()) as Tokens;
		expect(await callAdd(address, again.access_token)).toBe(true);
		expect(seen.at(-1)).toBe("a");

		expect(r.logs.events("oauth.paired").map((e) => e["address"])).toEqual([
			shortAddress(b.addressId),
			shortAddress(a.addressId),
		]);
	});

	test("when a tab closes, its token does not fall to another tab of the app", async () => {
		const r = relay({ pageWaitMs: 0 });
		const seen: string[] = [];
		const a = namedTab(r, seen, "a");
		const b = namedTab(r, seen, "b");
		const address = (await a.connect()).address;
		await b.connect();
		const forB = await pairByCode(r, address, await b.startPairing());
		const forA = await pairByCode(r, address, await a.startPairing());
		b.close();
		await waitFor(() => r.relay.sessionCount === 1, "the tab to close");
		expect(r.relay.pagesOf(APP)).toEqual([a.addressId]);
		// The stand-in answer of a page that is not open, not the other tab's.
		expect(await callAdd(address, forB.access_token)).toBe(false);
		expect(seen).toEqual([]);
		expect(await callAdd(address, forA.access_token)).toBe(true);
		expect(seen).toEqual(["a"]);
	});

	test("the code of a tab of app A typed at app B's address is wrong, and is not used up: it still pairs at A's address", async () => {
		const r = relay();
		const a = tab(r, { appId: "alpha" });
		const b = tab(r, { appId: "beta" });
		const alpha = (await a.connect()).address;
		const beta = (await b.connect()).address;
		expect(alpha).toBe(`${r.url}/s/alpha/mcp`);
		expect(beta).toBe(`${r.url}/s/beta/mcp`);
		const codeA = await a.startPairing();
		const codeB = await b.startPairing();

		const browser = new TestBrowser(r.url);
		for (const address of [beta, r.relay.addressFor("nobody")]) {
			const page = await open(r, address, browser);
			const res = await browser.submit(page, {
				action: "connect",
				code: codeA,
			});
			expect(res.status).toBe(400);
			expect(res.html).toContain(WRONG_TEXT);
		}
		expect(
			r.logs.events("oauth.pairing_failed").map((e) => [e["app"], e["reason"]]),
		).toEqual([
			["beta", "wrong"],
			["nobody", "wrong"],
		]);
		expect(r.logs.events("oauth.paired")).toHaveLength(0);
		// Neither tab heard of it; both still show their codes.
		await Bun.sleep(30);
		expect(a.received.filter((m) => m.type !== "ping")).toEqual([]);
		expect(b.received.filter((m) => m.type !== "ping")).toEqual([]);
		expect(a.pairingCode).toBe(codeA);
		expect(b.pairingCode).toBe(codeB);

		const tokens = await pairByCode(r, alpha, codeA);
		await a.next("grant.added");
		expect(await callAdd(alpha, tokens.access_token)).toBe(true);
		expect(b.received.some((m) => m.type === "grant.added")).toBe(false);
	});

	test("one code typed in two browsers at once pairs one of them", async () => {
		const r = relay();
		const t = tab(r);
		const address = (await t.connect()).address;
		const code = await t.startPairing();
		const browsers = [new TestBrowser(r.url), new TestBrowser(r.url)];
		const pages = await Promise.all(browsers.map((b) => open(r, address, b)));
		const results = await Promise.all(
			browsers.map((b, i) =>
				b.submit(pages[i] as Page, { action: "connect", code }),
			),
		);
		expect(results.map((res) => res.status).sort()).toEqual([303, 400]);
		expect(r.logs.events("oauth.paired")).toHaveLength(1);
		expect(
			r.logs.events("oauth.pairing_failed").map((e) => e["reason"]),
		).toEqual(["wrong"]);
	});
});

describe("the pairing page is shown before any page is known (DEC-196)", () => {
	test("an app with no page connected still gets the form; a code typed then is wrong; a page that comes later pairs on the same form", async () => {
		const r = relay();
		const address = r.relay.addressFor(APP);
		expect(r.relay.pagesOf(APP)).toEqual([]);
		const browser = new TestBrowser(r.url);
		const { verifier, challenge } = pkce();
		const page = await open(r, address, browser, {
			code_challenge: challenge,
		});
		expect(page.status).toBe(200);
		expect(page.requestId).toBeDefined();
		expect(page.html).toContain(`<strong>${APP}</strong>`);
		expect(page.html).not.toContain("Open the page first");
		expect(page.html).not.toContain("Try again");
		expect(page.html).not.toMatch(/not (open|connected|connecting)/);

		const wrong = await browser.submit(page, {
			action: "connect",
			code: "BCDF-GHJK",
		});
		expect(wrong.status).toBe(400);
		expect(wrong.html).toContain(WRONG_TEXT);
		expect(r.logs.events("oauth.pairing_failed").at(-1)).toMatchObject({
			app: APP,
			reason: "wrong",
		});

		const t = tab(r);
		await t.connect();
		const code = await t.startPairing();
		const done = await browser.submit(wrong, { action: "connect", code });
		expect(done.status).toBe(303);
		const tokens = await tokensFrom(r, done.location, verifier, address);
		expect(await callAdd(address, tokens.access_token)).toBe(true);
	});

	test("the page is the same with no page of the app, with one whose dialog is closed, and with one that shows a code", async () => {
		const r = relay();
		const address = r.relay.addressFor(APP);
		const browser = new TestBrowser(r.url);
		const none = await open(r, address, browser);
		const t = tab(r);
		await t.connect();
		const closed = await open(r, address, browser);
		await t.startPairing();
		const pairing = await open(r, address, browser);
		for (const page of [none, closed, pairing]) {
			expect(page.status).toBe(200);
			expect(page.requestId).toBeDefined();
			expect(page.headers.get("content-security-policy")).toBe(
				none.headers.get("content-security-policy"),
			);
		}
		expect(stable(closed)).toBe(stable(none));
		expect(stable(pairing)).toBe(stable(none));
		// And the same for an app nobody serves.
		// An app id that occurs nowhere else in the page.
		const other = await open(r, r.relay.addressFor("nobodys-app"), browser);
		expect(stable(other).replaceAll("nobodys-app", APP)).toBe(stable(none));
	});

	test("the form's hooks for an extension (DEC-199): the form, the code field and the Connect button, also after a wrong code", async () => {
		const r = relay();
		const t = tab(r);
		const address = (await t.connect()).address;
		const code = await t.startPairing();
		const browser = new TestBrowser(r.url);
		const first = await open(r, address, browser);
		const wrong = await browser.submit(first, {
			action: "connect",
			code: wrongFor(code),
		});
		expect(wrong.status).toBe(400);
		for (const page of [first, wrong]) {
			expect(elements(page.html, "form")).toEqual([
				{
					tag: "form",
					attributes: {
						method: "post",
						// No address in the URL (was `?a=`): the request id is in the form.
						action: "/authorize",
						"data-tab-mcp-pairing": "1",
						"data-app": APP,
						"data-client-name": "Test AI",
						"data-client-host": new URL(clientId).host,
					},
				},
			]);
			const fields = elements(
				page.html,
				'form[data-tab-mcp-pairing="1"] [data-tab-mcp-field]',
			);
			expect(fields).toHaveLength(1);
			expect(fields[0]?.tag).toBe("input");
			expect(fields[0]?.attributes).toMatchObject({
				"data-tab-mcp-field": "code",
				name: "code",
				type: "text",
				// Nothing for a password manager to fill or to offer.
				autocomplete: "off",
				"data-1p-ignore": "",
				"data-lpignore": "true",
				"data-bwignore": "",
				"data-form-type": "other",
				// `XXXX-XXXX` fits, also with spaces around the dash.
				maxlength: "12",
			});
			// The field never comes filled in.
			expect(fields[0]?.attributes).not.toHaveProperty("value");
			expect(
				elements(
					page.html,
					'form[data-tab-mcp-pairing="1"] [data-tab-mcp-action]',
				),
			).toEqual([
				{
					tag: "button",
					attributes: {
						type: "submit",
						class: "primary",
						name: "action",
						value: "connect",
						"data-tab-mcp-action": "connect",
					},
				},
			]);
			// What a filled-in form posts is what the hooks name.
			expect(
				elements(page.html, "form input[type=hidden]").map(
					(e) => e.attributes["name"],
				),
			).toEqual(["request_id", "csrf"]);
		}
		// Filled in as the hooks say, the form pairs.
		const done = await browser.submit(wrong, { action: "connect", code });
		expect(done.status).toBe(303);
	});

	test("the page never contains a pairing code: not a live one, not the one just typed", async () => {
		const r = relay();
		const a = tab(r);
		const b = tab(r);
		const address = (await a.connect()).address;
		await b.connect();
		const live = [await a.startPairing(), await b.startPairing()];
		const browser = new TestBrowser(r.url);
		const first = await open(r, address, browser);
		const typed = wrongFor(...live);
		const wrong = await browser.submit(first, {
			action: "connect",
			code: typed,
		});
		const malformed = await browser.submit(wrong, {
			action: "connect",
			code: "<b>12ab</b>",
		});
		expect(malformed.status).toBe(400);
		for (const page of [first, wrong, malformed]) {
			const upper = page.html.toUpperCase();
			for (const code of [...live, typed]) {
				expect(upper).not.toContain(code);
				expect(upper).not.toContain(code.replace("-", ""));
			}
			expect(page.html).not.toContain("12ab");
			for (const header of page.headers.values()) {
				for (const code of live)
					expect(header.toUpperCase()).not.toContain(code);
			}
		}
	});

	test("an action the page does not offer shows the form again and judges nothing", async () => {
		const r = relay();
		const t = tab(r);
		const address = (await t.connect()).address;
		const code = await t.startPairing();
		const browser = new TestBrowser(r.url);
		let page = await open(r, address, browser);
		// `signin` is only for an app that can pair by sign-in.
		for (const action of ["signin", "retry", ""]) {
			page = await browser.submit(page, { action, code });
			expect(page.status).toBe(200);
			expect(page.location).toBeUndefined();
			expect(page.html).not.toContain('role="alert"');
		}
		expect(r.logs.events("oauth.pairing_failed")).toHaveLength(0);
		expect(r.logs.events("oauth.pairing_redirect")).toHaveLength(0);
		expect(t.pairingCode).toBe(code);
		const done = await browser.submit(page, { action: "connect", code });
		expect(done.status).toBe(303);
	});

	test("where every origin lists its apps, an address of another app is no resource (invalid_target)", async () => {
		const r = relay({
			allowedOrigins: [],
			sites: [{ origin: ORIGIN, apps: ["mine"] }],
		});
		const browser = new TestBrowser(r.url);
		const other = await open(r, r.relay.addressFor("other"), browser);
		expect(other.status).toBe(400);
		expect(other.requestId).toBeUndefined();
		expect(other.html).toContain("this relay has no pages of that app");
		expect(other.html).toContain("invalid_target");
		const mine = await open(r, r.relay.addressFor("mine"), browser);
		expect(mine.status).toBe(200);
		expect(mine.requestId).toBeDefined();
	});
});

describe("RFC 8707: a token belongs to one app's address (DEC-196)", () => {
	test("the token of a flow at /s/alpha/mcp is 401 at /s/beta/mcp, also when a page is connected there", async () => {
		const r = relay();
		const seen: string[] = [];
		const a = namedTab(r, seen, "alpha", { appId: "alpha" });
		const b = namedTab(r, seen, "beta", { appId: "beta" });
		const alpha = (await a.connect()).address;
		const beta = (await b.connect()).address;
		const tokens = await pairByCode(r, alpha, await a.startPairing());
		const atBeta = await mcpPost(beta, add(), { token: tokens.access_token });
		expect(atBeta.status).toBe(401);
		expect(atBeta.headers.get("www-authenticate")).toBe(
			`Bearer resource_metadata="${r.url}/.well-known/oauth-protected-resource/s/beta/mcp", scope="tools", error="invalid_token"`,
		);
		expect(seen).toEqual([]);
		// The refusal names no page: the log line has the app asked for only.
		const line = r.logs.events("mcp.request").at(-1);
		expect(line).toMatchObject({ app: "beta", status: 401 });
		expect(line).not.toHaveProperty("address");
		expect(await callAdd(alpha, tokens.access_token)).toBe(true);
		expect(seen).toEqual(["alpha"]);
		expect(r.logs.events("mcp.request").at(-1)).toMatchObject({
			app: "alpha",
			address: shortAddress(a.addressId),
			status: 200,
		});
	});

	test("a refresh with the resource of another app is invalid_target and keeps the token; with its own app's, or none, it works", async () => {
		const r = relay();
		const a = tab(r, { appId: "alpha" });
		const b = tab(r, { appId: "beta" });
		const alpha = (await a.connect()).address;
		const beta = (await b.connect()).address;
		let tokens = await pairByCode(r, alpha, await a.startPairing());
		const refresh = (resource: string | undefined) =>
			postForm(`${r.url}/token`, {
				grant_type: "refresh_token",
				refresh_token: tokens.refresh_token,
				client_id: clientId,
				resource,
			});
		for (const resource of [
			beta,
			r.relay.addressFor("nobody"),
			`${r.url}/s/alpha`,
			`${alpha}/`,
			r.url,
		]) {
			const res = await refresh(resource);
			expect(res.status).toBe(400);
			expect(((await res.json()) as { error: string }).error).toBe(
				"invalid_target",
			);
		}
		// None of the refusals used the refresh token up.
		for (const resource of [alpha, undefined]) {
			const res = await refresh(resource);
			expect(res.status).toBe(200);
			tokens = (await res.json()) as Tokens;
			// The new token is alpha's still, whatever the request left out.
			expect(
				(await mcpPost(beta, add(), { token: tokens.access_token })).status,
			).toBe(401);
			expect(await callAdd(alpha, tokens.access_token)).toBe(true);
		}
	});

	test("the code of a flow at one app's address is not exchanged with another app's as resource", async () => {
		const r = relay();
		const a = tab(r, { appId: "alpha" });
		const alpha = (await a.connect()).address;
		const browser = new TestBrowser(r.url);
		const { verifier, challenge } = pkce();
		const page = await open(r, alpha, browser, { code_challenge: challenge });
		const done = await browser.submit(page, {
			action: "connect",
			code: await a.startPairing(),
		});
		const res = await postForm(`${r.url}/token`, {
			grant_type: "authorization_code",
			code: new URL(done.location ?? "").searchParams.get("code") ?? "",
			redirect_uri: REDIRECT,
			code_verifier: verifier,
			client_id: clientId,
			resource: r.relay.addressFor("beta"),
		});
		expect(res.status).toBe(400);
		expect(((await res.json()) as { error: string }).error).toBe(
			"invalid_target",
		);
		expect(await r.store.listGrants(a.addressId, Date.now())).toEqual([]);
	});

	// The address id is of the app and the secret together, so the same
	// secret under another app is another page: an origin that may not serve
	// `alpha` cannot, with a copied secret, end alpha's session or get its
	// calls by naming an app it may serve (DEC-197).
	test("a token made for one app does not reach a session that names another app", async () => {
		const other = "https://other.example";
		const r = relay({
			pageWaitMs: 0,
			allowedOrigins: [other],
			sites: [{ origin: ORIGIN, apps: ["alpha"] }],
		});
		const seen: string[] = [];
		const a = namedTab(r, seen, "alpha", { appId: "alpha" });
		const alpha = (await a.connect()).address;
		const tokens = await pairByCode(r, alpha, await a.startPairing());
		expect(await callAdd(alpha, tokens.access_token)).toBe(true);
		// The same address id, now a page of an origin that may serve only
		// unreserved apps.
		const b = namedTab(r, seen, "beta", {
			appId: "beta",
			origin: other,
			secret: a.secret,
		});
		const beta = await b.connect();
		// Another page: alpha's session stays, and beta lists none of its grants.
		expect(b.addressId).not.toBe(a.addressId);
		expect(beta.grants).toEqual([]);
		expect(r.relay.pagesOf("alpha")).toEqual([a.addressId]);
		expect(await callAdd(alpha, tokens.access_token)).toBe(true);
		expect(seen).toEqual(["alpha", "alpha"]);
		// With alpha's page gone, its token still does not fall to beta.
		a.close();
		await a.closed;
		expect(await callAdd(alpha, tokens.access_token)).toBe(false);
		expect(seen).toEqual(["alpha", "alpha"]);
	});
});

describe("an app that pairs both ways: code and sign-in on one page (DEC-196)", () => {
	const CODE_SITE = "https://code.example";
	const OIDC_SITE = "https://oidc.example";

	/** One app served by a `code` site and an `oidc` site. */
	function mixedRelay(oidc = provider.relayConfig()): OAuthTestRelay {
		return relay({
			allowedOrigins: [],
			oidc,
			sites: [
				{ origin: CODE_SITE, pairing: "code", apps: ["mixed", "plain"] },
				{ origin: OIDC_SITE, pairing: "oidc", apps: ["mixed", "bound"] },
			],
		});
	}

	/** A page of the `oidc` site, signed in as `sub`, its dialog open. */
	async function signedInTab(
		r: OAuthTestRelay,
		seen: string[],
		sub: string,
		appId = "mixed",
	): Promise<ScriptedTab> {
		const t = namedTab(r, seen, `oidc:${sub}`, { origin: OIDC_SITE, appId });
		const session = await t.connect();
		expect(session.pairing).toBe("oidc");
		t.send({ type: "pairing.start" });
		t.send({
			type: "identity",
			assertion: await provider.assertion(sub, session.address),
		});
		// In order: the dialog is open once the identity is bound.
		await t.next("identity.bound");
		return t;
	}

	test("the page has the code field with Connect and a second button to sign in; the code field is not asked for when signing in", async () => {
		const r = mixedRelay();
		const browser = new TestBrowser(r.url);
		const page = await open(r, r.relay.addressFor("mixed"), browser);
		expect(page.status).toBe(200);
		expect(
			elements(page.html, "form [data-tab-mcp-field]").map(
				(e) => e.attributes["name"],
			),
		).toEqual(["code"]);
		expect(elements(page.html, "form button").map((e) => e.attributes)).toEqual(
			[
				{
					type: "submit",
					class: "primary",
					name: "action",
					value: "connect",
					"data-tab-mcp-action": "connect",
				},
				{
					type: "submit",
					class: "secondary",
					name: "action",
					value: "cancel",
					formnovalidate: "",
				},
				{
					type: "submit",
					class: "secondary",
					name: "action",
					value: "signin",
					formnovalidate: "",
				},
			],
		);
		expect(page.html).toContain(
			`Sign in at <strong>${new URL(provider.issuer).host}</strong>`,
		);
		// The redirect after the post goes to the provider: CSP allows it.
		expect(page.headers.get("content-security-policy")).toContain(
			provider.issuer,
		);
	});

	test("while the provider cannot be reached the page offers the code alone; an app with the sign-in only is 503", async () => {
		// Nothing listens on port 1.
		const r = mixedRelay(
			provider.relayConfig({ issuer: "http://127.0.0.1:1" }),
		);
		const codeTab = tab(r, { origin: CODE_SITE, appId: "mixed" });
		await codeTab.connect();
		const code = await codeTab.startPairing();
		const browser = new TestBrowser(r.url);
		const page = await open(r, r.relay.addressFor("mixed"), browser);
		expect(page.status).toBe(200);
		expect(
			elements(page.html, "form button").map((e) => e.attributes["value"]),
		).toEqual(["connect", "cancel"]);
		expect(page.html).not.toContain("Sign in");
		expect(r.logs.events("oidc.discovery_failed")).toHaveLength(1);
		// A sign-in posted all the same starts nothing.
		const posted = await browser.submit(page, { action: "signin" });
		expect(posted.status).toBe(200);
		expect(posted.location).toBeUndefined();
		const done = await browser.submit(posted, { action: "connect", code });
		expect(done.status).toBe(303);

		const bound = await open(r, r.relay.addressFor("bound"), browser);
		expect(bound.status).toBe(503);
		expect(bound.requestId).toBeUndefined();
		expect(bound.html).toContain(
			"The sign-in provider of this app cannot be reached right now.",
		);
	});

	test("an app of the code site alone has no sign-in; one of the oidc site alone has no code field, and Connect is the sign-in", async () => {
		const r = mixedRelay();
		const browser = new TestBrowser(r.url);
		const plain = await open(r, r.relay.addressFor("plain"), browser);
		expect(elements(plain.html, "form [data-tab-mcp-field]")).toHaveLength(1);
		expect(
			elements(plain.html, "form button").map((e) => e.attributes["value"]),
		).toEqual(["connect", "cancel"]);
		expect(plain.html).not.toContain("Sign in");
		expect(plain.headers.get("content-security-policy")).not.toContain(
			provider.issuer,
		);
		const noSignIn = await browser.submit(plain, { action: "signin" });
		expect(noSignIn.status).toBe(200);
		expect(noSignIn.location).toBeUndefined();

		const bound = await open(r, r.relay.addressFor("bound"), browser);
		expect(elements(bound.html, "form [data-tab-mcp-field]")).toEqual([]);
		expect(
			elements(bound.html, "form button").map((e) => e.attributes["value"]),
		).toEqual(["connect", "cancel"]);
		expect(bound.html).toContain("No code is needed");
		const toProvider = await browser.submit(bound, { action: "connect" });
		expect(toProvider.status).toBe(303);
		expect(toProvider.location?.startsWith(provider.issuer)).toBe(true);
	});

	test("action=signin goes to the provider and pairs the page signed in as that person; the code pairs the page that shows it", async () => {
		const r = mixedRelay();
		const address = r.relay.addressFor("mixed");
		const seen: string[] = [];
		const codeTab = namedTab(r, seen, "code", {
			origin: CODE_SITE,
			appId: "mixed",
		});
		expect((await codeTab.connect()).pairing).toBe("code");
		const code = await codeTab.startPairing();
		const oidcTab = await signedInTab(r, seen, "alice");
		expect(oidcTab.pairingCode).toBeUndefined();

		// The sign-in.
		provider.signedInAs = "alice";
		const browser = new TestBrowser(r.url);
		const { verifier, challenge } = pkce();
		const page = await open(r, address, browser, { code_challenge: challenge });
		const posted = await browser.submit(page, { action: "signin" });
		expect(posted.status).toBe(303);
		expect(posted.location?.startsWith(`${provider.issuer}/authorize?`)).toBe(
			true,
		);
		expect(r.logs.events("oauth.pairing_redirect")).toEqual([
			expect.objectContaining({
				app: "mixed",
				client: new URL(clientId).host,
				method: "oidc",
			}),
		]);
		expect(r.logs.events("oauth.pairing_redirect")[0]).not.toHaveProperty(
			"address",
		);
		const back = await provider.signIn(posted.location ?? "");
		const done = await browser.open(back);
		expect(done.status).toBe(303);
		const bySignIn = await tokensFrom(r, done.location, verifier, address);
		await oidcTab.next("grant.added");
		expect(r.logs.events("oauth.paired").at(-1)).toMatchObject({
			address: shortAddress(oidcTab.addressId),
			app: "mixed",
			method: "oidc",
		});
		const bound = await r.store.listGrants(oidcTab.addressId, Date.now());
		expect(bound.map((g) => g.subject)).toEqual([
			identityKey(provider.issuer, "alice"),
		]);

		// The code, on a page of the same kind.
		const byCode = await pairByCode(r, address, code, browser);
		await codeTab.next("grant.added");
		expect(r.logs.events("oauth.paired").at(-1)).toMatchObject({
			address: shortAddress(codeTab.addressId),
			app: "mixed",
			method: "code",
		});
		const unbound = await r.store.listGrants(codeTab.addressId, Date.now());
		expect(unbound.map((g) => g.subject)).toEqual([undefined]);

		expect(await callAdd(address, bySignIn.access_token)).toBe(true);
		expect(await callAdd(address, byCode.access_token)).toBe(true);
		expect(seen).toEqual(["oidc:alice", "code"]);
	});

	test("a sign-in never pairs a page of the code site; the page then says one text and still offers both ways", async () => {
		const r = mixedRelay();
		const address = r.relay.addressFor("mixed");
		const codeTab = tab(r, { origin: CODE_SITE, appId: "mixed" });
		await codeTab.connect();
		const code = await codeTab.startPairing();
		provider.signedInAs = "alice";
		const browser = new TestBrowser(r.url);
		const page = await open(r, address, browser);
		const posted = await browser.submit(page, { action: "signin" });
		const done = await browser.open(
			await provider.signIn(posted.location ?? ""),
		);
		expect(done.status).toBe(403);
		expect(done.location).toBeUndefined();
		expect(done.html).toContain(NO_PAGE_TEXT);
		expect(r.logs.events("oauth.pairing_failed").at(-1)).toMatchObject({
			app: "mixed",
			reason: "mismatch",
		});
		expect(r.logs.events("oauth.paired")).toHaveLength(0);
		expect(
			elements(done.html, "form button").map((e) => e.attributes["value"]),
		).toEqual(["connect", "cancel", "signin"]);
		// The next sign-in asks for the account again.
		const again = await browser.submit(done, { action: "signin" });
		expect(new URL(again.location ?? "").searchParams.get("prompt")).toBe(
			"login",
		);
		// The code still pairs on the same request.
		const byCode = await browser.submit(done, { action: "connect", code });
		expect(byCode.status).toBe(303);
	});

	test("a sign-in pairs the page of the person signed in, among several pages of the app", async () => {
		const r = mixedRelay();
		const address = r.relay.addressFor("mixed");
		const seen: string[] = [];
		const alice = await signedInTab(r, seen, "alice");
		const bob = await signedInTab(r, seen, "bob");
		provider.signedInAs = "bob";
		const browser = new TestBrowser(r.url);
		const { verifier, challenge } = pkce();
		const page = await open(r, address, browser, { code_challenge: challenge });
		const posted = await browser.submit(page, { action: "signin" });
		const done = await browser.open(
			await provider.signIn(posted.location ?? ""),
		);
		expect(done.status).toBe(303);
		const tokens = await tokensFrom(r, done.location, verifier, address);
		await bob.next("grant.added");
		expect(alice.received.some((m) => m.type === "grant.added")).toBe(false);
		expect(await callAdd(address, tokens.access_token)).toBe(true);
		expect(seen).toEqual(["oidc:bob"]);
	});

	test("of two pages of one person the sign-in pairs the one that connected last; with its dialog closed, the other", async () => {
		const r = mixedRelay();
		const address = r.relay.addressFor("mixed");
		const first = await signedInTab(r, [], "alice");
		await Bun.sleep(5);
		const second = await signedInTab(r, [], "alice");
		provider.signedInAs = "alice";
		const browser = new TestBrowser(r.url);
		const signIn = async () => {
			const page = await open(r, address, browser);
			const posted = await browser.submit(page, { action: "signin" });
			const done = await browser.open(
				await provider.signIn(posted.location ?? ""),
			);
			expect(done.status).toBe(303);
			return r.logs.events("oauth.paired").at(-1)?.["address"];
		};
		expect(await signIn()).toBe(shortAddress(second.addressId));
		second.send({ type: "pairing.stop" });
		await Bun.sleep(20);
		expect(await signIn()).toBe(shortAddress(first.addressId));
	});

	test('identity "oidc" with one code site: an app nobody lists has both ways too', async () => {
		const r = relay({
			identity: "oidc",
			oidc: provider.relayConfig(),
			allowedOrigins: [ORIGIN],
			sites: [{ origin: CODE_SITE, pairing: "code" }],
		});
		const browser = new TestBrowser(r.url);
		const page = await open(r, r.relay.addressFor(APP), browser);
		expect(page.status).toBe(200);
		expect(elements(page.html, "form [data-tab-mcp-field]")).toHaveLength(1);
		expect(
			elements(page.html, "form button").map((e) => e.attributes["value"]),
		).toEqual(["connect", "cancel", "signin"]);
		const posted = await browser.submit(page, { action: "signin" });
		expect(posted.status).toBe(303);
		expect(posted.location?.startsWith(provider.issuer)).toBe(true);
		// Connect is the code's: without one it is malformed input, no sign-in.
		const empty = await browser.submit(page, { action: "connect", code: "" });
		expect(empty.status).toBe(400);
		expect(empty.location).toBeUndefined();
	});

	// A sign-in is charged as a guess when it starts and given back when it
	// pairs (the callback): the guess limit is the network's one budget for
	// every app, and the people of one organisation behind one address
	// signing in one after another are no guesses.
	test("a sign-in that pairs costs the network no guess", async () => {
		const r = mixedRelay();
		const address = r.relay.addressFor("bound");
		const seen: string[] = [];
		await signedInTab(r, seen, "alice", "bound");
		provider.signedInAs = "alice";
		const browser = new TestBrowser(r.url);
		for (let i = 0; i < 11; i++) {
			const page = await open(r, address, browser);
			const posted = await browser.submit(page, { action: "connect" });
			expect(posted.status).toBe(303);
			const done = await browser.open(
				await provider.signIn(posted.location ?? ""),
			);
			expect(done.status).toBe(303);
		}
	});
});
