/**
 * Group grants (DEC-232, iteration 53): an AI app connected to every browser
 * signed in with one account. The relay chooses the member for each request
 * (a `tab` argument's, the pin's, or the one whose window had the focus
 * last), joins `list_tabs`, and names the member in every result. The
 * members are scripted extensions that answer tunnelled requests the way
 * the tab-mcp browser extension does.
 */
import {
	afterAll,
	afterEach,
	beforeAll,
	describe,
	expect,
	test,
} from "bun:test";
import { groupAddress } from "../src/address.ts";
import type {
	GroupMessage,
	HttpRequestMessage,
	RelayMessage,
} from "../src/protocol.ts";
import {
	type CreateRelayOptions,
	createTestRelay,
	type Relay,
	type RelayTestHooks,
} from "../src/relay.ts";
import { accountKey } from "../src/signin/providers.ts";
import { ANSWERED_BY_META } from "../src/signin/route.ts";
import { MemoryTokenStore } from "../src/store/memory.ts";
import type { TokenStore } from "../src/store/types.ts";
import { issueAccessToken } from "../src/test-token.ts";
import {
	LogCapture,
	mcpPost,
	ORIGIN,
	rpc,
	ScriptedTab,
	waitFor,
} from "./helpers.ts";
import {
	authorizeUrl,
	type CimdServer,
	pkce,
	postForm,
	startCimdServer,
	TestBrowser,
	testUrls,
} from "./oauth-helpers.ts";
import { type FakeProviders, startFakeProviders } from "./signin-fixture.ts";

const CHROME_ID = "abcdefghijklmnopabcdefghijklmnop";
const CHROME = `chrome-extension://${CHROME_ID}`;
const CHROME_REDIRECT = `https://${CHROME_ID}.chromiumapp.org/`;
const APP = "tab-mcp-extension";
const REDIRECT = "http://127.0.0.1:4567/callback";

let fakes: FakeProviders;
let cimd: CimdServer;
let clientId: string;
let current: Ctx | undefined;
const open: ScriptedTab[] = [];

beforeAll(async () => {
	fakes = await startFakeProviders();
	cimd = await startCimdServer();
	clientId = cimd.serve(
		"/client.json",
		cimd.document(`${cimd.origin}/client.json`),
	);
});
afterAll(async () => {
	await fakes.stop();
	await cimd.stop();
});
afterEach(async () => {
	for (const t of open.splice(0)) if (t.ws.readyState <= 1) t.close();
	await current?.relay.stop();
	current = undefined;
	fakes.google = { sub: "g-alice", email: "alice@gmail.example" };
});

interface Ctx {
	relay: Relay;
	store: TokenStore;
	logs: LogCapture;
	wsUrl: string;
	address: string;
}

function start(
	options: CreateRelayOptions = {},
	hooks: RelayTestHooks = {},
): Ctx {
	const store = new MemoryTokenStore();
	const logs = new LogCapture();
	const relay = createTestRelay(
		{
			development: true,
			port: 0,
			host: "127.0.0.1",
			allowedOrigins: [CHROME, ORIGIN],
			store,
			logger: logs.logger,
			signIn: {
				apps: [APP],
				providers: {
					google: fakes.clients.google,
					github: fakes.clients.github,
				},
			},
			maxSessionsPerIp: 40,
			pageWaitMs: 0,
			...options,
		},
		{
			signInEndpoints: fakes.endpoints,
			cimdUrls: testUrls(cimd.ca),
			...hooks,
		},
	);
	current = {
		relay,
		store,
		logs,
		wsUrl: `ws://127.0.0.1:${relay.port}/tab`,
		address: relay.addressFor(APP),
	};
	return current;
}

/** A tab of a browser's page as `list_tabs` names it. */
interface FakeTab {
	tab: string;
	title: string;
	url: string;
	inFront?: true;
}

/** A scripted extension that answers like the tab-mcp browser extension. */
class Member {
	readonly requests: HttpRequestMessage[] = [];
	readonly tab: ScriptedTab;
	memberId = "";
	/** Hold back answers to `tools/call` of this tool until released. */
	hold: string | undefined;
	held: (() => void)[] = [];

	constructor(
		ctx: Ctx,
		readonly name: string,
		readonly tabs: FakeTab[],
		options: { secret?: string; capabilities?: unknown; sse?: boolean } = {},
	) {
		this.tab = new ScriptedTab(ctx.wsUrl, {
			origin: CHROME,
			appId: APP,
			...(options.capabilities === null
				? {}
				: { capabilities: options.capabilities ?? ["signin.v1"] }),
			...(options.secret === undefined ? {} : { secret: options.secret }),
			onRequest: (msg, tab) => this.#answer(msg, tab, options.sse ?? true),
		});
		open.push(this.tab);
	}

	/** Every tool call this member got, with its tool and arguments. */
	get calls(): { name: string; args: Record<string, unknown> }[] {
		return this.requests.flatMap((r) => {
			const body = JSON.parse(r.body) as {
				method: string;
				params?: { name?: string; arguments?: Record<string, unknown> };
			};
			return body.method === "tools/call"
				? [
						{
							name: String(body.params?.name),
							args: body.params?.arguments ?? {},
						},
					]
				: [];
		});
	}

	async #answer(
		msg: HttpRequestMessage,
		tab: ScriptedTab,
		sse: boolean,
	): Promise<void> {
		this.requests.push(msg);
		const body = JSON.parse(msg.body) as {
			id: number | string;
			method: string;
			params?: { name?: string; arguments?: Record<string, unknown> };
		};
		let result: Record<string, unknown>;
		if (body.method === "tools/list") {
			result = {
				resultType: "complete",
				tools: [{ name: "page_info", inputSchema: { type: "object" } }],
			};
		} else if (body.method === "tools/call") {
			const name = String(body.params?.name);
			const args = body.params?.arguments ?? {};
			if (this.hold === name) {
				await new Promise<void>((resolve) => this.held.push(resolve));
			}
			if (name === "list_tabs") {
				const value = { mode: "the tab in front", tabs: this.tabs, note: "x" };
				result = {
					content: [{ type: "text", text: JSON.stringify(value) }],
					structuredContent: value,
				};
			} else if (name === "use_tab" && args["tab"] === "999") {
				result = {
					content: [{ type: "text", text: "No tab 999 is open." }],
					isError: true,
				};
			} else {
				const value = { browser: this.name, tool: name, args };
				result = {
					content: [{ type: "text", text: JSON.stringify(value) }],
					structuredContent: value,
				};
			}
		} else {
			result = { resultType: "complete" };
		}
		const answer = JSON.stringify({ jsonrpc: "2.0", id: body.id, result });
		if (!sse) {
			tab.send({
				type: "http.response",
				id: msg.id,
				status: 200,
				headers: { "content-type": "application/json" },
				body: answer,
			});
			return;
		}
		tab.send({
			type: "http.response.start",
			id: msg.id,
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});
		// A notification first, split across pieces, as streams come.
		const progress = `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress", params: { progress: 1 } })}\n\n`;
		const events = `${progress}event: message\ndata: ${answer}\n\n`;
		const cut = Math.floor(events.length / 2);
		for (const data of [events.slice(0, cut), events.slice(cut)]) {
			tab.send({ type: "http.response.chunk", id: msg.id, data });
		}
		tab.send({ type: "http.response.end", id: msg.id });
	}

	/**
	 * The group's state once it matches: the latest `group` message if it
	 * does (a `group` message is the whole state), else the next one that
	 * does. Older ones are dropped.
	 */
	group(
		match: (g: GroupMessage) => boolean = () => true,
	): Promise<GroupMessage> {
		const received = this.tab.received;
		const groups = received.filter((m) => m.type === "group");
		for (const g of groups) received.splice(received.indexOf(g), 1);
		this.#latest = (groups.at(-1) as GroupMessage | undefined) ?? this.#latest;
		const latest = this.#latest;
		if (latest !== undefined && match(latest)) return Promise.resolve(latest);
		return this.tab
			.next("group", (m) => match(m as GroupMessage))
			.then((m) => {
				this.#latest = m as GroupMessage;
				return this.#latest;
			});
	}

	#latest: GroupMessage | undefined;
}

class Browser {
	readonly cookies = new Map<string, string>();
	async get(url: string) {
		const cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
		const res = await fetch(url, {
			redirect: "manual",
			headers: cookie === "" ? {} : { cookie },
		});
		for (const line of res.headers.getSetCookie()) {
			const [pair] = line.split(";");
			const [k, v] = (pair ?? "").split("=");
			if (k !== undefined && v !== undefined) this.cookies.set(k, v);
		}
		return { status: res.status, location: res.headers.get("location") ?? "" };
	}
}

/** Connect a member and sign it in with Google (the fakes' account). */
async function member(
	ctx: Ctx,
	name: string,
	tabsOf: FakeTab[] = [],
	options: { sse?: boolean } = {},
): Promise<Member> {
	const m = new Member(ctx, name, tabsOf, options);
	await m.tab.connect();
	m.tab.send({
		type: "signin.start",
		provider: "google",
		redirectUrl: CHROME_REDIRECT,
		label: name,
	});
	const { url } = (await m.tab.next("signin.url")) as { url: string };
	const browser = new Browser();
	const visit = await browser.get(url);
	const back = await browser.get(visit.location);
	const done = await browser.get(back.location);
	const code = new URL(done.location).searchParams.get("signin") ?? "";
	m.tab.send({ type: "signin.complete", code });
	const signed = (await m.tab.next("signin.done")) as { member: string };
	m.memberId = signed.member;
	await m.group((g) => g.members.some((x) => x.id === m.memberId && x.online));
	return m;
}

/** The group key of the fakes' Google account. */
async function groupOf(ctx: Ctx, m: Member): Promise<string> {
	const b = await ctx.store.getBinding?.(m.tab.addressId, Date.now());
	return b?.group ?? "";
}

async function groupToken(
	ctx: Ctx,
	group: string,
	grantId?: string,
): Promise<string> {
	const { token } = await issueAccessToken(
		ctx.store,
		{
			...(grantId === undefined ? {} : { grantId }),
			addressId: groupAddress(group),
			app: APP,
			clientId: "https://client.example/cimd.json",
			clientName: "Test client",
			group,
		},
		{ ttlMs: 3_600_000 },
	);
	return token;
}

/** The JSON-RPC answer in a response (JSON or an event stream). */
async function answer(res: Response): Promise<Record<string, unknown>> {
	const text = await res.text();
	if ((res.headers.get("content-type") ?? "").startsWith("text/event-stream")) {
		const events = text
			.split(/\n\n/)
			.flatMap((e) => e.split("\n").filter((l) => l.startsWith("data: ")))
			.map((l) => JSON.parse(l.slice(6)) as Record<string, unknown>);
		const found = events.find((e) => "result" in e || "error" in e);
		if (found === undefined) throw new Error(`no answer in ${text}`);
		return found;
	}
	return JSON.parse(text) as Record<string, unknown>;
}

interface ToolResult {
	content: { type: string; text: string }[];
	structuredContent?: Record<string, unknown>;
	isError?: boolean;
	_meta?: Record<string, unknown>;
}

async function call(
	ctx: Ctx,
	token: string,
	name: string,
	args: Record<string, unknown> = {},
	id = 1,
): Promise<ToolResult> {
	const res = await mcpPost(
		ctx.address,
		rpc(id, "tools/call", { name, arguments: args }),
		{ token },
	);
	expect(res.status).toBe(200);
	return (await answer(res))["result"] as ToolResult;
}

const lastText = (r: ToolResult) => r.content.at(-1)?.text ?? "";

describe("routing a group grant's calls", () => {
	test("a tab argument <member>:<tab> goes to that member, with the member taken off; the result names it", async () => {
		const ctx = start();
		const a = await member(ctx, "work Chrome");
		const b = await member(ctx, "Firefox");
		const token = await groupToken(ctx, await groupOf(ctx, a));
		const result = await call(ctx, token, "page_info", {
			tab: `${b.memberId}:42`,
		});
		expect(b.calls).toEqual([{ name: "page_info", args: { tab: "42" } }]);
		expect(a.calls).toEqual([]);
		// The member's own content and structuredContent are as it sent them.
		expect(result.structuredContent).toEqual({
			browser: "Firefox",
			tool: "page_info",
			args: { tab: "42" },
		});
		expect(result.content).toHaveLength(2);
		expect(lastText(result)).toBe(
			`Answered by the browser “Firefox” (its tabs are ${b.memberId}:<id> in list_tabs).`,
		);
		expect(result._meta?.[ANSWERED_BY_META]).toEqual({
			member: b.memberId,
			label: "Firefox",
		});
	});

	test("the same with a JSON answer instead of an event stream", async () => {
		const ctx = start();
		const a = await member(ctx, "work Chrome", [], { sse: false });
		const token = await groupToken(ctx, await groupOf(ctx, a));
		const result = await call(ctx, token, "reload", {
			tab: `${a.memberId}:7`,
		});
		expect(a.calls).toEqual([{ name: "reload", args: { tab: "7" } }]);
		expect(lastText(result)).toContain("Answered by the browser “work Chrome”");
	});

	test("a tab without a known member is an error result that says to call list_tabs; no member gets it", async () => {
		const ctx = start();
		const a = await member(ctx, "work Chrome");
		const token = await groupToken(ctx, await groupOf(ctx, a));
		for (const tab of ["42", "m_nobody:42", `${a.memberId}:x`, 42]) {
			const result = await call(ctx, token, "page_info", { tab });
			expect(result.isError).toBe(true);
			expect(result.content[0]?.text).toContain("Call list_tabs");
		}
		expect(a.calls).toEqual([]);
	});

	test("mode 'the tab in front': the member whose window had the focus last; the members see which", async () => {
		const ctx = start();
		const a = await member(ctx, "work Chrome");
		const b = await member(ctx, "Firefox");
		const token = await groupToken(ctx, await groupOf(ctx, a));
		b.tab.send({ type: "focus" });
		await a.group((g) => g.focus === b.memberId);
		await call(ctx, token, "page_info");
		expect(b.calls.map((c) => c.name)).toEqual(["page_info"]);
		a.tab.send({ type: "focus" });
		const shown = await b.group((g) => g.focus === a.memberId);
		expect(shown.mode).toBe("front");
		const result = await call(ctx, token, "page_info");
		expect(a.calls.map((c) => c.name)).toEqual(["page_info"]);
		expect(lastText(result)).toBe(
			`Answered by the browser “work Chrome” (its tabs are ${a.memberId}:<id> in list_tabs).`,
		);
		// tools/list goes there too, named in _meta.
		const res = await mcpPost(ctx.address, rpc(2, "tools/list"), { token });
		const list = (await answer(res))["result"] as Record<string, unknown>;
		expect(
			(list["_meta"] as Record<string, unknown>)[ANSWERED_BY_META],
		).toEqual({
			member: a.memberId,
			label: "work Chrome",
		});
		expect(a.requests).toHaveLength(2);
	});

	test("the browser used last is offline: the most recently online one answers, and the result says so", async () => {
		const ctx = start();
		const a = await member(ctx, "work Chrome");
		const b = await member(ctx, "Firefox");
		const c = await member(ctx, "Edge");
		const token = await groupToken(ctx, await groupOf(ctx, a));
		// Nobody said where the focus is: the one that came online last.
		let result = await call(ctx, token, "page_info");
		expect(c.calls).toHaveLength(1);
		expect(lastText(result)).toContain(
			"No browser of the group has said which window has the focus",
		);
		b.tab.send({ type: "focus" });
		await a.group((g) => g.focus === b.memberId);
		b.tab.close();
		await a.group((g) =>
			g.members.some((m) => m.id === b.memberId && !m.online),
		);
		result = await call(ctx, token, "page_info");
		expect(c.calls).toHaveLength(2);
		expect(lastText(result)).toContain(
			"The browser whose window had the focus last, “Firefox”, is not online",
		);
		expect(a.calls).toEqual([]);
	});

	test("no browser of the group online: the answer for a page that is not open, adapted", async () => {
		const ctx = start();
		const a = await member(ctx, "work Chrome");
		const group = await groupOf(ctx, a);
		const token = await groupToken(ctx, group);
		a.tab.close();
		await waitFor(
			() => ctx.relay.sessionCount === 0,
			"the member's session to end",
		);
		const result = await call(ctx, token, "page_info");
		expect(result.isError).toBe(true);
		expect(result.content[0]?.text).toContain(
			"No browser signed in with the user's account in the tab-mcp browser extension is online",
		);
		const res = await mcpPost(ctx.address, rpc(2, "tools/list"), { token });
		expect(res.status).toBe(200);
		expect(((await answer(res))["error"] as { code: number }).code).toBe(
			-31001,
		);
	});

	test("a member that comes online within the wait gets the call", async () => {
		const ctx = start({ pageWaitMs: 3000 });
		const a = await member(ctx, "work Chrome");
		const group = await groupOf(ctx, a);
		const token = await groupToken(ctx, group);
		a.tab.close();
		await waitFor(() => ctx.relay.sessionCount === 0, "the session to end");
		const pending = call(ctx, token, "page_info");
		await Bun.sleep(100);
		const again = new Member(ctx, "work Chrome", [], { secret: a.tab.secret });
		await again.tab.connect();
		const result = await pending;
		expect(again.calls.map((c) => c.name)).toEqual(["page_info"]);
		expect(lastText(result)).toContain("work Chrome");
	});
});

describe("list_tabs and use_tab", () => {
	test("list_tabs goes to every member online and joins the answers; no member sees another's tabs", async () => {
		const ctx = start();
		const a = await member(ctx, "work Chrome", [
			{ tab: "1", title: "Mail", url: "https://mail.example/", inFront: true },
			{ tab: "2", title: "Shop", url: "https://shop.example/" },
		]);
		const b = await member(ctx, "Firefox", [
			{ tab: "1", title: "Docs", url: "https://docs.example/" },
		]);
		const token = await groupToken(ctx, await groupOf(ctx, a));
		const result = await call(ctx, token, "list_tabs");
		const list = result.structuredContent as {
			tabs: {
				tab: string;
				browser: string;
				title: string;
				url: string;
				inFront?: true;
			}[];
			browsers: { member: string; browser: string; online: boolean }[];
			mode: string;
			note: string;
		};
		expect(list.mode).toBe("the tab in front");
		expect(list.tabs).toEqual([
			{
				tab: `${a.memberId}:1`,
				browser: "work Chrome",
				title: "Mail",
				url: "https://mail.example/",
				inFront: true,
			},
			{
				tab: `${a.memberId}:2`,
				browser: "work Chrome",
				title: "Shop",
				url: "https://shop.example/",
			},
			{
				tab: `${b.memberId}:1`,
				browser: "Firefox",
				title: "Docs",
				url: "https://docs.example/",
			},
		]);
		expect(list.browsers.map((x) => [x.browser, x.online])).toEqual([
			["work Chrome", true],
			["Firefox", true],
		]);
		expect(JSON.parse(result.content[0]?.text ?? "")).toEqual(list);
		expect(lastText(result)).toContain(
			"Answered by the browser “work Chrome”, the browser “Firefox”",
		);
		// Each member got its own list_tabs once, and nothing of the other's.
		for (const [m, other] of [
			[a, "Docs"],
			[b, "Shop"],
		] as const) {
			expect(m.calls).toEqual([{ name: "list_tabs", args: {} }]);
			expect(JSON.stringify(m.requests)).not.toContain(other);
			expect(
				m.tab.received.some((r) => JSON.stringify(r).includes(other)),
			).toBe(false);
		}
	});

	test("a member that goes away while asked, and an offline one, are listed without tabs", async () => {
		const ctx = start();
		const a = await member(ctx, "work Chrome", [
			{ tab: "1", title: "Mail", url: "https://mail.example/" },
		]);
		const b = await member(ctx, "Firefox");
		const c = await member(ctx, "Edge");
		const token = await groupToken(ctx, await groupOf(ctx, a));
		c.tab.close();
		await a.group((g) =>
			g.members.some((m) => m.id === c.memberId && !m.online),
		);
		b.hold = "list_tabs";
		const pending = call(ctx, token, "list_tabs");
		await waitFor(() => b.requests.length === 1, "b to be asked");
		b.tab.close();
		const result = await pending;
		const list = result.structuredContent as {
			tabs: unknown[];
			browsers: { browser: string; online: boolean; error?: string }[];
		};
		expect(list.tabs).toHaveLength(1);
		expect(list.browsers.find((x) => x.browser === "Firefox")).toMatchObject({
			online: true,
			error: "Its answer was not a list of tabs.",
		});
		expect(list.browsers.find((x) => x.browser === "Edge")).toMatchObject({
			online: false,
			error: "Not online.",
		});
		expect(lastText(result)).toBe(
			"Answered by the browser “work Chrome”: each lists only its own tabs.",
		);
	});

	test("use_tab pins the member's tab for the group and switches it to pinned; every member sees it; later calls go there", async () => {
		const ctx = start();
		const a = await member(ctx, "work Chrome");
		const b = await member(ctx, "Firefox");
		const group = await groupOf(ctx, a);
		const token = await groupToken(ctx, group);
		const result = await call(ctx, token, "use_tab", {
			tab: `${b.memberId}:5`,
		});
		expect(b.calls).toEqual([{ name: "use_tab", args: { tab: "5" } }]);
		expect(lastText(result)).toContain("Firefox");
		for (const m of [a, b]) {
			const g = await m.group((x) => x.mode === "pinned");
			expect(g.pin).toEqual({ member: b.memberId, tab: "5" });
			expect(g.focus).toBeUndefined();
		}
		expect(await ctx.store.getGroupMode?.(group)).toBe("pinned");
		// Focus is ignored in pinned mode; calls without tab go to the pin's member.
		a.tab.send({ type: "focus" });
		await call(ctx, token, "page_info");
		expect(b.calls.map((c) => c.name)).toEqual(["use_tab", "page_info"]);
		// The member holds the pin: the relay does not add a tab argument.
		expect(b.calls[1]?.args).toEqual({});
		expect(a.calls).toEqual([]);
	});

	test("a use_tab the member refuses pins nothing", async () => {
		const ctx = start();
		const a = await member(ctx, "work Chrome");
		const token = await groupToken(ctx, await groupOf(ctx, a));
		const result = await call(ctx, token, "use_tab", {
			tab: `${a.memberId}:999`,
		});
		expect(result.isError).toBe(true);
		const quiet = await Promise.race([
			a.group((g) => g.mode === "pinned").then(() => "pinned"),
			Bun.sleep(150).then(() => "quiet"),
		]);
		expect(quiet).toBe("quiet");
	});

	test("the pinned member offline: the call fails with that reason and the list_tabs hint, nothing goes elsewhere", async () => {
		const ctx = start();
		const a = await member(ctx, "work Chrome");
		const b = await member(ctx, "Firefox");
		const token = await groupToken(ctx, await groupOf(ctx, a));
		await call(ctx, token, "use_tab", { tab: `${b.memberId}:5` });
		await a.group((g) => g.mode === "pinned");
		b.tab.close();
		await a.group((g) =>
			g.members.some((m) => m.id === b.memberId && !m.online),
		);
		const result = await call(ctx, token, "page_info");
		expect(result.isError).toBe(true);
		expect(result.content[0]?.text).toBe(
			"The pinned tab is in the browser “Firefox”, which is not online; nothing was done in another tab. Call list_tabs for the tabs you may use, then pass tab with the call, or use_tab to pin one.",
		);
		// The same for a tab argument naming that member.
		const named = await call(ctx, token, "reload", { tab: `${b.memberId}:5` });
		expect(named.content[0]?.text).toContain("which is not online");
		expect(a.calls).toEqual([]);
	});
});

describe("the group's mode and pin from the members", () => {
	test("group.mode and group.pin from any member reach every member; front drops the pin; the mode is kept in the store", async () => {
		const ctx = start();
		const a = await member(ctx, "work Chrome");
		const b = await member(ctx, "Firefox");
		const group = await groupOf(ctx, a);
		const token = await groupToken(ctx, group);
		a.tab.send({ type: "group.mode", mode: "pinned" });
		let g = await b.group((x) => x.mode === "pinned");
		expect(g.pin).toBeUndefined();
		// Pinned without a pin: the call goes as in front mode, and the
		// member pins its tab ("Work here", or its own first call).
		b.tab.send({ type: "group.pin", tab: "8" });
		g = await a.group((x) => x.pin !== undefined);
		expect(g.pin).toEqual({ member: b.memberId, tab: "8" });
		await call(ctx, token, "page_info");
		expect(b.calls).toHaveLength(1);
		b.tab.send({ type: "group.mode", mode: "front" });
		g = await a.group((x) => x.mode === "front");
		expect(g.pin).toBeUndefined();
		expect(await ctx.store.getGroupMode?.(group)).toBe("front");
	});

	test("the mode is read from the store when the group's first member comes (a relay that restarted); the pin is not kept", async () => {
		const ctx = start();
		const key = accountKey("google", [
			fakes.endpoints.googleIssuer ?? "",
			"g-alice",
		]);
		await ctx.store.setGroupMode?.(key, "pinned");
		const a = await member(ctx, "work Chrome");
		expect(await groupOf(ctx, a)).toBe(key);
		const g = await a.group();
		expect(g.mode).toBe("pinned");
		expect(g.pin).toBeUndefined();
		expect(g.focus).toBeUndefined();
		expect(g.grants).toEqual([]);
	});

	test("malformed group messages are bad_message; a browser that is not signed in gets unknown_id", async () => {
		const ctx = start();
		const m = new Member(ctx, "x", []);
		await m.tab.connect();
		m.tab.send({ type: "group.mode", mode: "sideways" });
		expect(((await m.tab.next("error")) as { code: string }).code).toBe(
			"bad_message",
		);
		m.tab.send({ type: "group.pin", tab: "m_x:1" });
		expect(((await m.tab.next("error")) as { code: string }).code).toBe(
			"bad_message",
		);
		m.tab.send({ type: "group.mode", mode: "pinned" });
		expect(await m.tab.next("error")).toMatchObject({
			code: "unknown_id",
			for: "group.mode",
		});
		m.tab.send({ type: "group.grant.revoke", grantId: "g_x" });
		expect(await m.tab.next("error")).toMatchObject({
			code: "unknown_id",
			for: "group.grant.revoke",
			grantId: "g_x",
		});
	});

	test("focus messages never end the session, however many; past their budget they are dropped", async () => {
		const ctx = start();
		const a = await member(ctx, "work Chrome");
		for (let i = 0; i < 100; i++) a.tab.send({ type: "focus" });
		await Bun.sleep(200);
		expect(a.tab.ws.readyState).toBe(WebSocket.OPEN);
		expect(ctx.logs.events("group.focus_limited")).toHaveLength(1);
	});
});

describe("the group's grants", () => {
	test("every member sees the group's grants; any member revokes one for the whole group", async () => {
		const ctx = start();
		const a = await member(ctx, "work Chrome");
		const b = await member(ctx, "Firefox");
		const group = await groupOf(ctx, a);
		const token = await groupToken(ctx, group, "g_group");
		a.tab.send({ type: "group.mode", mode: "front" });
		for (const m of [a, b]) {
			const g = await m.group((x) => x.grants.length === 1);
			expect(g.grants[0]?.grantId).toBe("g_group");
			expect(g.grants[0]?.client.host).toBe("client.example");
		}
		// A call in flight on a when b revokes: it ends with -31009.
		a.hold = "page_info";
		a.tab.send({ type: "focus" });
		await b.group((x) => x.focus === a.memberId);
		const inFlight = mcpPost(
			ctx.address,
			rpc(9, "tools/call", { name: "page_info", arguments: {} }),
			{ token },
		);
		await waitFor(() => a.requests.length === 1, "the call to reach a");
		b.tab.send({ type: "group.grant.revoke", grantId: "g_group" });
		for (const m of [a, b]) await m.group((x) => x.grants.length === 0);
		const ended = await inFlight;
		expect(ended.status).toBe(401);
		expect(((await answer(ended))["error"] as { code: number }).code).toBe(
			-31009,
		);
		const after = await mcpPost(ctx.address, rpc(3, "tools/list"), { token });
		expect(after.status).toBe(401);
		b.tab.send({ type: "group.grant.revoke", grantId: "g_group" });
		expect(await b.tab.next("error")).toMatchObject({
			code: "unknown_id",
			for: "group.grant.revoke",
		});
	});
});

describe("backwards compatibility", () => {
	test("a page grant of a signed-in browser passes byte for byte, without a name", async () => {
		const ctx = start();
		const a = await member(ctx, "work Chrome", [], { sse: false });
		const { token } = await issueAccessToken(
			ctx.store,
			{
				addressId: a.tab.addressId,
				app: APP,
				clientId: "https://client.example/cimd.json",
				clientName: "Test client",
			},
			{ ttlMs: 3_600_000 },
		);
		// Odd spacing, and a tab argument of the group's form: neither is touched.
		const body = `{ "jsonrpc":"2.0","id":5, "method":"tools/call","params":{"name":"page_info","arguments":{"tab":"m_x:1"},"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28"}} }`;
		const res = await mcpPost(ctx.address, body, {
			token,
			headers: { "mcp-method": "tools/call", "mcp-name": "page_info" },
		});
		expect(a.requests[0]?.body).toBe(body);
		const text = await res.text();
		expect(text).toBe(
			JSON.stringify({
				jsonrpc: "2.0",
				id: 5,
				result: {
					content: [
						{
							type: "text",
							text: JSON.stringify({
								browser: "work Chrome",
								tool: "page_info",
								args: { tab: "m_x:1" },
							}),
						},
					],
					structuredContent: {
						browser: "work Chrome",
						tool: "page_info",
						args: { tab: "m_x:1" },
					},
				},
			}),
		);
	});

	test("an extension without signin.v1 gets none of the new messages, and its group messages are unknown types", async () => {
		const ctx = start();
		const old = new Member(ctx, "old", [], { capabilities: null });
		const session = await old.tab.connect();
		expect("signIn" in session).toBe(false);
		old.tab.send({ type: "focus", id: "f1" });
		old.tab.send({ type: "group.mode", mode: "pinned", id: "f2" });
		expect(await old.tab.next("error")).toMatchObject({
			code: "unknown_type",
			id: "f1",
		});
		expect(await old.tab.next("error")).toMatchObject({
			code: "unknown_type",
			id: "f2",
		});
		const rest: RelayMessage[] = old.tab.received.filter(
			(m) => m.type !== "ping",
		);
		expect(rest).toEqual([]);
	});

	test("a group token whose record lost its group reaches no browser", async () => {
		const ctx = start();
		const a = await member(ctx, "work Chrome");
		const group = await groupOf(ctx, a);
		const { token } = await issueAccessToken(
			ctx.store,
			{
				addressId: groupAddress(group),
				app: APP,
				clientId: "https://client.example/cimd.json",
				clientName: "Test client",
			},
			{ ttlMs: 3_600_000 },
		);
		const result = await call(ctx, token, "page_info");
		expect(result.isError).toBe(true);
		expect(a.requests).toEqual([]);
	});
});

describe("pairing an AI app with a group by signing in", () => {
	async function openPage(ctx: Ctx) {
		const browser = new TestBrowser(ctx.relay.url);
		const { verifier, challenge } = pkce();
		const page = await browser.open(
			authorizeUrl(ctx.relay.url, {
				client_id: clientId,
				redirect_uri: REDIRECT,
				code_challenge: challenge,
				resource: ctx.address,
			}),
		);
		expect(page.status).toBe(200);
		return { browser, page, verifier };
	}

	/** Follow the provider back to the relay's callback with the browser's cookies. */
	async function viaProvider(browser: TestBrowser, location: string) {
		const atProvider = await fetch(location, { redirect: "manual" });
		const callback = atProvider.headers.get("location") ?? "";
		return browser.open(callback);
	}

	test("the pairing page of a sign-in app offers the providers beside the code; a sign-in makes one grant for the group", async () => {
		const ctx = start();
		const a = await member(ctx, "work Chrome");
		const b = await member(ctx, "Firefox");
		const { browser, page, verifier } = await openPage(ctx);
		expect(page.html).toContain('name="code"');
		expect(page.html).toContain(
			'value="account.google" formnovalidate>Sign in with Google</button>',
		);
		expect(page.html).toContain("Sign in with GitHub");
		expect(page.html).not.toContain("Sign in with Microsoft");
		expect(page.headers.get("content-security-policy")).toContain(
			new URL(fakes.endpoints.googleIssuer ?? "").origin,
		);
		const redirect = await browser.submit(page, { action: "account.google" });
		expect(redirect.status).toBe(303);
		const state = new URL(redirect.location ?? "").searchParams.get("state");
		expect(state?.startsWith("account.google.")).toBe(true);
		const back = await viaProvider(browser, redirect.location ?? "");
		expect(back.status).toBe(303);
		const code = new URL(back.location ?? "").searchParams.get("code") ?? "";
		const res = await postForm(`${ctx.relay.url}/token`, {
			grant_type: "authorization_code",
			code,
			redirect_uri: REDIRECT,
			code_verifier: verifier,
			client_id: clientId,
			resource: ctx.address,
		});
		expect(res.status).toBe(200);
		const tokens = (await res.json()) as {
			access_token: string;
			refresh_token: string;
		};
		const group = await groupOf(ctx, a);
		const grants = await ctx.store.listGrants(groupAddress(group), Date.now());
		expect(grants).toHaveLength(1);
		for (const m of [a, b]) await m.group((g) => g.grants.length === 1);
		// No page of the group got a page grant.
		expect(await ctx.store.listGrants(a.tab.addressId, Date.now())).toEqual([]);
		const result = await call(ctx, tokens.access_token, "list_tabs");
		expect(
			(result.structuredContent as { browsers: unknown[] }).browsers,
		).toHaveLength(2);
		// A refresh keeps the group.
		const refreshed = await postForm(`${ctx.relay.url}/token`, {
			grant_type: "refresh_token",
			refresh_token: tokens.refresh_token,
			client_id: clientId,
		});
		expect(refreshed.status).toBe(200);
		const next = (await refreshed.json()) as { access_token: string };
		const again = await call(ctx, next.access_token, "page_info");
		expect(lastText(again)).toContain("Answered by");
	});

	test("an account without a signed-in browser pairs nothing and says what to do", async () => {
		const ctx = start();
		const { browser, page } = await openPage(ctx);
		const redirect = await browser.submit(page, { action: "account.google" });
		const back = await viaProvider(browser, redirect.location ?? "");
		expect(back.status).toBe(403);
		expect(back.html).toContain(
			"No browser is signed in with this Google account. In the tab-mcp browser extension, sign in with the same account, then sign in here again, or type the code.",
		);
	});

	test("a group whose browsers are all offline still pairs", async () => {
		const ctx = start();
		const a = await member(ctx, "work Chrome");
		a.tab.close();
		await waitFor(() => ctx.relay.sessionCount === 0, "the session to end");
		const { browser, page } = await openPage(ctx);
		const redirect = await browser.submit(page, { action: "account.google" });
		const back = await viaProvider(browser, redirect.location ?? "");
		expect(back.status).toBe(303);
		expect(
			new URL(back.location ?? "").searchParams.get("code"),
		).not.toBeNull();
	});

	test("an app that may not sign in, or a relay without sign-in, shows the code alone", async () => {
		const ctx = start({
			signIn: {
				apps: ["other-app"],
				providers: { google: fakes.clients.google },
			},
		});
		const { page } = await openPage(ctx);
		expect(page.html).not.toContain("Sign in with");
	});
});
