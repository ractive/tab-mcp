/**
 * The headers every response of the relay carries (owner, 2026-11-22):
 * `nosniff` on each kind of answer, set in one place (`src/headers.ts`).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { withCommonHeaders } from "../src/headers.ts";
import { APP, mcpPost, rpc, ScriptedTab, tokenFor } from "./helpers.ts";
import {
	authorizeUrl,
	type CimdServer,
	type OAuthTestRelay,
	pkce,
	startCimdServer,
	startOAuthRelay,
	TestBrowser,
} from "./oauth-helpers.ts";

let cimd: CimdServer;
let relay: OAuthTestRelay;
let tab: ScriptedTab;
let clientId: string;

beforeAll(async () => {
	cimd = await startCimdServer();
	clientId = cimd.serve(
		"/client.json",
		cimd.document(`${cimd.origin}/client.json`),
	);
	relay = startOAuthRelay(cimd);
	tab = new ScriptedTab(relay.wsUrl);
	await tab.connect();
	await tab.startPairing();
});

afterAll(async () => {
	tab.close();
	await relay.stop();
	await cimd.stop();
});

/** One answer of each kind the relay gives, by a name for the failure message. */
/** What the test reads of an answer (a `Response`, or a page the test browser read). */
interface Answer {
	status: number;
	headers: Headers;
}

async function answers(): Promise<[string, Answer][]> {
	const url = relay.url;
	const address = tab.session?.address ?? "";
	const get = (path: string, init?: RequestInit) =>
		fetch(`${url}${path}`, { redirect: "manual", ...init });
	const token = await tokenFor(relay.store, tab.addressId);
	const authorize = authorizeUrl(url, {
		client_id: clientId,
		redirect_uri: "https://app.example/cb",
		code_challenge: pkce().challenge,
		resource: address,
	});
	const browser = new TestBrowser(url);
	const page = await browser.open(authorize);
	const cancelled = await browser.submit(page, { action: "cancel" });
	const form = (fields: Record<string, string>) => ({
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams(fields),
	});
	return [
		["home page", await get("/")],
		["stylesheet", await get("/authorize.css")],
		["favicon.ico", await get("/favicon.ico")],
		["favicon.svg", await get("/favicon.svg")],
		["apple-touch-icon.png", await get("/apple-touch-icon.png")],
		["/healthz", await get("/healthz")],
		[
			"authorization server metadata",
			await get("/.well-known/oauth-authorization-server"),
		],
		[
			"its preflight",
			await get("/.well-known/oauth-authorization-server", {
				method: "OPTIONS",
			}),
		],
		[
			"protected resource metadata",
			await get(`/.well-known/oauth-protected-resource/s/${APP}/mcp`),
		],
		["/authorize without a request (error page)", await get("/authorize")],
		[
			"/authorize with a valid request (the sign-in page)",
			await fetch(authorize),
		],
		["/authorize posted without a form", await get("/authorize", form({}))],
		["/authorize cancelled (a redirect)", cancelled],
		["/authorize/callback without a sign-in", await get("/authorize/callback")],
		["/token posted wrong", await get("/token", form({}))],
		["/token with GET (405)", await get("/token")],
		["/token preflight", await get("/token", { method: "OPTIONS" })],
		["/revoke posted wrong", await get("/revoke", form({}))],
		["/register (no such route)", await get("/register", form({}))],
		["MCP GET (405)", await get(`/s/${APP}/mcp`)],
		[
			"MCP POST without a token (401)",
			await mcpPost(address, rpc(1, "tools/list")),
		],
		[
			"MCP POST passed to the tab and back",
			await mcpPost(address, rpc(2, "tools/list"), { token }),
		],
		["MCP preflight", await get(`/s/${APP}/mcp`, { method: "OPTIONS" })],
		[
			"MCP address of a malformed app",
			await get("/s/Not_An_App!/mcp", { method: "POST" }),
		],
		["/tab without an upgrade", await get("/tab")],
		["an unknown path", await get("/nope")],
	];
}

describe("every response", () => {
	test("has x-content-type-options: nosniff, whatever its kind", async () => {
		const all = await answers();
		const missing = all
			.filter(
				([, res]) => res.headers.get("x-content-type-options") !== "nosniff",
			)
			.map(([name, res]) => `${name} (${res.status})`);
		expect(missing).toEqual([]);
		// The list covers what it says: errors, a redirect, a 405, the tab's answer.
		const status = Object.fromEntries(all.map(([n, r]) => [n, r.status]));
		expect(status["/authorize cancelled (a redirect)"]).toBe(303);
		expect(status["/token with GET (405)"]).toBe(405);
		expect(status["MCP GET (405)"]).toBe(405);
		expect(status["MCP POST passed to the tab and back"]).toBe(200);
		expect(status["MCP POST without a token (401)"]).toBe(401);
		expect(status["an unknown path"]).toBe(404);
	});

	test("the WebSocket upgrade still works", async () => {
		const other = new ScriptedTab(relay.wsUrl);
		expect((await other.connect()).type).toBe("session");
		other.close();
	});
});

describe("withCommonHeaders", () => {
	test("adds the header, also to a response whose headers cannot change, and leaves an upgrade alone", () => {
		expect(
			withCommonHeaders(new Response("x")).headers.get(
				"x-content-type-options",
			),
		).toBe("nosniff");
		const redirect = Response.redirect("https://example.com/", 302);
		const done = withCommonHeaders(redirect);
		expect(done.status).toBe(302);
		expect(done.headers.get("location")).toBe("https://example.com/");
		expect(done.headers.get("x-content-type-options")).toBe("nosniff");
		expect(withCommonHeaders(undefined)).toBeUndefined();
	});
});
