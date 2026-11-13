/**
 * The navigation tools (iteration 27, DEC-121) without a browser: the
 * address check, the origin rule, back and forward, waiting for the load,
 * the result when the new page cannot be read, the question's texts, and
 * the content script's view of the tab's history.
 */

import { describe, expect, test } from "bun:test";
import type { Tool, ToolExecuteOptions } from "@ractive-ch/tab-mcp-client";
import { Window as HappyWindow } from "happy-dom";
import { pageHistory } from "../src/content.ts";
import type { PageHistory, PageInfo } from "../src/messages.ts";
import type { Answer, QuestionView } from "../src/protocol.ts";
import { questionCard } from "../src/sidepanel/question.ts";
import { noAccess, type TargetTab } from "../src/tabs.ts";
import {
	addressFor,
	hostEnd,
	type Loaded,
	MAX_TITLE_HOST,
	MAX_URL,
	type NavigationChrome,
	type NavigationWhere,
	navigationTools,
	type Step,
	type TabEvents,
	waitForLoad,
} from "../src/worker/navigation.ts";
import {
	type AppRequest,
	type NotificationText,
	notificationText,
	Questions,
	type QuestionsHost,
} from "../src/worker/questions.ts";
import { INSTRUCTIONS } from "../src/worker/tools.ts";

const SHOP = "https://shop.test";

describe("the address navigate opens", () => {
	test("http and https, relative ones against the page in front", () => {
		expect(addressFor("https://other.test/a?b#c", `${SHOP}/x`).href).toBe(
			"https://other.test/a?b#c",
		);
		expect(addressFor("/sale", `${SHOP}/products/1`).href).toBe(`${SHOP}/sale`);
		expect(addressFor("  http://shop.test:8080/ ", SHOP).origin).toBe(
			"http://shop.test:8080",
		);
	});

	test("no other scheme, no user name or password, nothing too long", () => {
		for (const bad of [
			"javascript:alert(1)",
			" JavaScript:alert(1)",
			"data:text/html,<p>x",
			"file:///etc/passwd",
			"blob:https://shop.test/1",
			"chrome://settings",
			"chrome-extension://abc/sidepanel/index.html",
			"about:blank",
			"view-source:https://shop.test/",
		])
			expect(() => addressFor(bad, SHOP)).toThrow("Only http and https");
		expect(() => addressFor("https://shop.test@evil.test/", SHOP)).toThrow(
			"user name or password",
		);
		expect(() => addressFor("https://u:p@shop.test/", SHOP)).toThrow(
			"user name or password",
		);
		expect(() =>
			addressFor(`https://shop.test/${"a".repeat(MAX_URL)}`, SHOP),
		).toThrow("longer than");
		// Relative, but the page in front has no http(s) address to resolve it on.
		expect(() => addressFor("/sale", "")).toThrow("Not an address");
		expect(() => addressFor("/sale", "file:///x")).toThrow("Not an address");
	});
});

/** Tab events the test drives. */
function fakeEvents(status: string | undefined = "complete") {
	let on: Parameters<TabEvents["watch"]>[1] | undefined;
	let watching = 0;
	const events: TabEvents & {
		emit(status: string): void;
		remove(): void;
		set(status: string | undefined): void;
		watching(): number;
	} = {
		watch(_tabId, handlers) {
			on = handlers;
			watching++;
			return () => {
				on = undefined;
				watching--;
			};
		},
		status: async () => status,
		emit: (s) => on?.status(s),
		remove: () => on?.removed(),
		set: (s) => {
			status = s;
		},
		watching: () => watching,
	};
	return events;
}

describe("waiting for the load", () => {
	const signal = () => new AbortController().signal;

	test("complete after loading; listening before the navigation starts", async () => {
		const events = fakeEvents();
		const done = waitForLoad(
			events,
			1,
			async () => {
				// The first events can come before the call resolves.
				events.emit("loading");
				events.set("loading");
			},
			{ signal: signal(), quietMs: 10 },
		);
		await Bun.sleep(30);
		events.emit("complete");
		expect(await done).toBe("complete");
		expect(events.watching()).toBe(0);
	});

	test("a navigation that never starts loading (within the page) counts as done", async () => {
		const events = fakeEvents("complete");
		expect(
			await waitForLoad(events, 1, async () => {}, {
				signal: signal(),
				quietMs: 10,
			}),
		).toBe("complete");
	});

	test("the time limit, the tab closing, start's error, a cancellation", async () => {
		const slow = fakeEvents("loading");
		expect(
			await waitForLoad(slow, 1, async () => {}, {
				signal: signal(),
				timeoutMs: 20,
				quietMs: 5,
			}),
		).toBe("timeout");
		const closing = fakeEvents("loading");
		const closed = waitForLoad(closing, 1, async () => {}, {
			signal: signal(),
		});
		await Bun.sleep(5);
		closing.remove();
		expect(await closed).toBe("closed");
		await expect(
			waitForLoad(
				fakeEvents(),
				1,
				async () => {
					throw new Error("Cannot find a next page in history.");
				},
				{ signal: signal() },
			),
		).rejects.toThrow("Cannot find a next page");
		const controller = new AbortController();
		const cancelled = waitForLoad(fakeEvents("loading"), 1, async () => {}, {
			signal: controller.signal,
		});
		controller.abort();
		await expect(cancelled).rejects.toThrow("cancelled");
	});
});

/** A tab and its pages, as the fake Chrome shows them. */
interface FakeTab {
	url: string;
	/** Chrome hides the address and refuses the content script. */
	readable: boolean;
	history: PageHistory;
}

/** Chrome with one tab, which the navigation steps move as the test says. */
function fakeChrome(
	tab: FakeTab,
	options: {
		/** Where a step takes the tab, and whether it may still be read there. */
		land?: (step: Step) => { url: string; readable: boolean } | undefined;
		loaded?: Loaded;
	} = {},
) {
	const steps: Step[] = [];
	const target = (): TargetTab => ({
		id: 9,
		url: tab.readable ? tab.url : "",
		title: "A page",
	});
	const chrome: NavigationChrome & { steps: Step[]; tab_: FakeTab } = {
		steps,
		tab_: tab,
		current: async () => target(),
		tab: async () => target(),
		page: async (t): Promise<PageInfo> => {
			if (!tab.readable || t.url === "") throw noAccess(t.url);
			return {
				url: tab.url,
				title: "A page",
				webmcp: { available: false, tools: 0 },
			};
		},
		history: async () => tab.history,
		go: async (_id, step) => {
			steps.push(step);
			const landed =
				options.land?.(step) ??
				(typeof step === "object"
					? {
							url: step.url,
							readable: new URL(step.url).origin === new URL(tab.url).origin,
						}
					: { url: tab.url, readable: tab.readable });
			tab.url = landed.url;
			tab.readable = landed.readable;
			return options.loaded ?? "complete";
		},
	};
	return chrome;
}

const CLIENT = {
	kind: "relay" as const,
	grantId: "g1",
	id: "https://claude.ai/oauth",
	name: "Claude",
	host: "claude.ai",
};

function execOptions(): ToolExecuteOptions {
	return { signal: new AbortController().signal, client: CLIENT };
}

/** The tools with a fake question that answers `answer`; what it was asked. */
function tools(
	chrome: NavigationChrome,
	answer: Answer | "timeout" | "busy" = "allow",
) {
	const asked: { request: AppRequest; where: NavigationWhere }[] = [];
	let refreshed = 0;
	const list = navigationTools(
		chrome,
		async (request, where) => {
			asked.push({ request, where });
			return answer;
		},
		async () => {
			refreshed++;
		},
	);
	const byName = (name: string) => list.find((t) => t.name === name) as Tool;
	const call = (name: string, args: Record<string, unknown> = {}) =>
		byName(name).execute(args, execOptions()) as Promise<unknown>;
	return { list, asked, call, refreshed: () => refreshed };
}

const history = (h: Partial<PageHistory> = {}): PageHistory => ({
	length: 3,
	...h,
});

describe("the navigation tools", () => {
	test("four tools, none read-only, none consequential (the extension asks itself)", () => {
		const { list } = tools(
			fakeChrome({ url: SHOP, readable: true, history: history() }),
		);
		expect(list.map((t) => t.name)).toEqual([
			"navigate",
			"go_back",
			"go_forward",
			"reload",
		]);
		for (const tool of list) {
			expect(tool.annotations?.readOnlyHint).toBe(false);
			expect(tool.annotations?.consequentialHint).toBeUndefined();
			expect(tool.annotations?.untrustedContentHint).toBe(true);
			expect(tool.description.length).toBeLessThan(500);
		}
		// The server instructions say they are there.
		expect(INSTRUCTIONS).toContain("navigate");
		expect(INSTRUCTIONS).toContain("go_back");
	});

	test("on the page's origin navigate runs at once and answers with the new page", async () => {
		const chrome = fakeChrome({
			url: `${SHOP}/products`,
			readable: true,
			history: history(),
		});
		const t = tools(chrome);
		expect(await t.call("navigate", { url: "/sale" })).toEqual({
			url: `${SHOP}/sale`,
			title: "A page",
			webmcp: { available: false, tools: 0 },
		});
		expect(chrome.steps).toEqual([{ url: `${SHOP}/sale` }]);
		expect(t.asked).toEqual([]);
		// The page's tools are read before the answer.
		expect(t.refreshed()).toBe(1);
	});

	test("to another origin it asks first: From, To, no Don't ask again; the answer counts", async () => {
		const chrome = fakeChrome({
			url: `${SHOP}/products`,
			readable: true,
			history: history(),
		});
		const t = tools(chrome, "allow");
		const result = await t.call("navigate", { url: "https://other.test/x" });
		expect(t.asked).toHaveLength(1);
		const [{ request, where }] = t.asked as [(typeof t.asked)[0]];
		expect(where).toEqual({
			tabId: 9,
			origin: SHOP,
			navigation: { to: "https://other.test/x" },
		});
		expect(request.tool.name).toBe("navigate");
		expect(request.tool.title).toBe("opening other.test");
		expect(request.arguments).toEqual({ url: "https://other.test/x" });
		expect(chrome.steps).toEqual([{ url: "https://other.test/x" }]);
		// Without host access the new page cannot be read: the result says so.
		expect(result).toEqual({
			readable: false,
			reason: noAccess("").message,
		});
		// A subdomain is another origin too (from a page the user clicked on).
		Object.assign(chrome.tab_, { url: "https://other.test/x", readable: true });
		await t.call("navigate", { url: "https://www.other.test/" });
		expect(t.asked).toHaveLength(2);
	});

	test("Don't allow, no answer and too many questions leave the tab where it is", async () => {
		for (const [answer, text] of [
			["deny", "did not allow"],
			["timeout", "did not answer within 60 s"],
			["busy", "already wait"],
		] as const) {
			const chrome = fakeChrome({
				url: SHOP,
				readable: true,
				history: history(),
			});
			await expect(
				tools(chrome, answer).call("navigate", { url: "https://evil.test/" }),
			).rejects.toThrow(text);
			expect(chrome.steps).toEqual([]);
		}
	});

	test("a tab the extension may not read: nothing happens, page_info's message", async () => {
		const chrome = fakeChrome({
			url: SHOP,
			readable: false,
			history: history(),
		});
		const t = tools(chrome);
		for (const name of ["navigate", "go_back", "go_forward", "reload"])
			await expect(t.call(name, { url: `${SHOP}/sale` })).rejects.toThrow(
				"may not read this tab yet",
			);
		expect(chrome.steps).toEqual([]);
		expect(t.asked).toEqual([]);
	});

	test("an address that is refused is not asked about", async () => {
		const chrome = fakeChrome({
			url: SHOP,
			readable: true,
			history: history(),
		});
		const t = tools(chrome);
		await expect(
			t.call("navigate", { url: "javascript:alert(1)" }),
		).rejects.toThrow("Only http and https");
		expect(t.asked).toEqual([]);
		expect(chrome.steps).toEqual([]);
	});

	test("back and forward on the page's origin run at once", async () => {
		const chrome = fakeChrome(
			{
				url: `${SHOP}/b`,
				readable: true,
				history: history({
					back: { url: `${SHOP}/a` },
					forward: { url: null },
				}),
			},
			{ land: () => ({ url: `${SHOP}/a`, readable: true }) },
		);
		const t = tools(chrome);
		expect(await t.call("go_back")).toMatchObject({ url: `${SHOP}/a` });
		// An entry the Navigation API lists without its address: still the page's origin.
		await t.call("go_forward");
		expect(chrome.steps).toEqual(["back", "forward"]);
		expect(t.asked).toEqual([]);
	});

	test("back or forward the content script cannot see: asked, the address unknown", async () => {
		const chrome = fakeChrome(
			{ url: `${SHOP}/b`, readable: true, history: history() },
			{ land: () => ({ url: "https://other.test/", readable: false }) },
		);
		const t = tools(chrome);
		expect(await t.call("go_back")).toMatchObject({ readable: false });
		const [{ request, where }] = t.asked as [(typeof t.asked)[0]];
		expect(request.tool.title).toBe("going back to another site");
		expect(where.origin).toBe(SHOP);
		expect(where.navigation.to).toContain("previous page");
		expect(where.navigation.to).toContain("not known");
		Object.assign(chrome.tab_, { url: `${SHOP}/b`, readable: true });
		await t.call("go_forward");
		expect(t.asked[1]?.where.navigation.to).toContain("next page");
		// An entry whose address is on another origin is not taken as the page's.
		const odd = fakeChrome({
			url: SHOP,
			readable: true,
			history: history({ back: { url: "https://other.test/" } }),
		});
		const o = tools(odd);
		await o.call("go_back");
		expect(o.asked).toHaveLength(1);
	});

	test("a tab with one page in its history has nothing to go back to: not asked", async () => {
		const chrome = fakeChrome({
			url: SHOP,
			readable: true,
			history: { length: 1 },
		});
		const t = tools(chrome);
		await expect(t.call("go_back")).rejects.toThrow("no page to go back to");
		await expect(t.call("go_forward")).rejects.toThrow(
			"no page to go forward to",
		);
		expect(t.asked).toEqual([]);
		expect(chrome.steps).toEqual([]);
	});

	test("reload never asks; a page still loading at the time limit says so", async () => {
		const chrome = fakeChrome(
			{ url: `${SHOP}/a`, readable: true, history: history() },
			{ loaded: "timeout" },
		);
		const t = tools(chrome);
		expect(await t.call("reload")).toMatchObject({
			url: `${SHOP}/a`,
			loading: true,
		});
		expect(chrome.steps).toEqual(["reload"]);
		expect(t.asked).toEqual([]);
	});

	test("a page of no http(s) origin: every navigation asks, but reload", async () => {
		const chrome = fakeChrome({
			url: "file:///x.html",
			readable: true,
			history: history(),
		});
		const t = tools(chrome);
		await t.call("reload");
		expect(t.asked).toHaveLength(0);
		await t.call("navigate", { url: "https://shop.test/" });
		expect(t.asked).toHaveLength(1);
		expect(t.asked[0]?.where.origin).toBeUndefined();
	});

	test("a tab that went elsewhere while the user was asked is not navigated", async () => {
		const tab: FakeTab = { url: SHOP, readable: true, history: history() };
		const chrome = fakeChrome(tab);
		const list = navigationTools(
			chrome,
			async () => {
				tab.url = "https://elsewhere.test/";
				return "allow";
			},
			async () => {},
		);
		const navigate = list.find((t) => t.name === "navigate") as Tool;
		await expect(
			navigate.execute(
				{ url: "https://other.test/" },
				execOptions(),
			) as Promise<unknown>,
		).rejects.toThrow("went to another page meanwhile");
		expect(chrome.steps).toEqual([]);
	});

	test("another tab in front once the user answered: not navigated", async () => {
		const chrome = fakeChrome({
			url: SHOP,
			readable: true,
			history: history(),
		});
		const inFront = chrome.current;
		const list = navigationTools(
			chrome,
			async () => {
				// The user switched tabs while the question was open.
				chrome.current = async () => ({
					id: 10,
					url: SHOP,
					title: "Other tab",
				});
				return "allow";
			},
			async () => {},
		);
		const navigate = list.find((t) => t.name === "navigate") as Tool;
		await expect(
			navigate.execute(
				{ url: "https://other.test/" },
				execOptions(),
			) as Promise<unknown>,
		).rejects.toThrow("The tab in front changed meanwhile");
		expect(chrome.steps).toEqual([]);
		// No tab in front at all counts the same.
		chrome.current = inFront;
		const none = navigationTools(
			chrome,
			async () => {
				chrome.current = async () => {
					throw new Error("No tab is in front.");
				};
				return "allow";
			},
			async () => {},
		).find((t) => t.name === "navigate") as Tool;
		await expect(
			none.execute(
				{ url: "https://other.test/" },
				execOptions(),
			) as Promise<unknown>,
		).rejects.toThrow("The tab in front changed meanwhile");
		expect(chrome.steps).toEqual([]);
	});

	test("another tab in front once the page loaded: the answer says so, not the other tab's page", async () => {
		const chrome = fakeChrome({
			url: SHOP,
			readable: true,
			history: history(),
		});
		const t = navigationTools(
			{
				...chrome,
				current: () => chrome.current(),
				go: async (id, step, signal) => {
					const loaded = await chrome.go(id, step, signal);
					chrome.current = async () => ({
						id: 10,
						url: SHOP,
						title: "Other tab",
					});
					return loaded;
				},
			},
			async () => "allow",
			async () => {},
		).find((x) => x.name === "navigate") as Tool;
		expect(
			await (t.execute(
				{ url: `${SHOP}/sale` },
				execOptions(),
			) as Promise<unknown>),
		).toEqual({
			readable: false,
			reason:
				"The tab was navigated, but another tab is in front now; page_info says which page that is.",
		});
		expect(chrome.steps).toEqual([{ url: `${SHOP}/sale` }]);
	});

	test("a caller that is not an AI app through the relay is not asked, and nothing runs", async () => {
		const chrome = fakeChrome({
			url: SHOP,
			readable: true,
			history: history(),
		});
		const t = tools(chrome);
		const navigate = t.list.find((x) => x.name === "navigate") as Tool;
		await expect(
			navigate.execute(
				{ url: "https://other.test/" },
				{
					signal: new AbortController().signal,
					client: { kind: "webmcp" } as never,
				},
			) as Promise<unknown>,
		).rejects.toThrow("did not allow");
		expect(t.asked).toEqual([]);
		expect(chrome.steps).toEqual([]);
	});
});

/** A host for `Questions` that only collects the notifications. */
function questionsHost() {
	const shown = new Map<string, NotificationText>();
	const host: QuestionsHost = {
		windowOf: async () => 3,
		panelInFocus: async () => false,
		notify: async (id, text) => {
			shown.set(id, text);
		},
		clear: (id) => {
			shown.delete(id);
		},
		showQuestion: () => {},
		changed: () => {},
		now: () => 0,
	};
	return { host, shown };
}

describe("the navigation question", () => {
	const navRequest = (to: string): AppRequest => ({
		tool: {
			name: "navigate",
			title: `opening ${new URL(to).host}`,
			description: "",
		},
		arguments: { url: to },
		client: CLIENT,
		signal: new AbortController().signal,
	});

	test("a notification: where to, from which site, Allow only", async () => {
		const { host, shown } = questionsHost();
		const questions = new Questions(host);
		void questions.ask(navRequest("https://evil.test/login"), {
			tabId: 9,
			origin: SHOP,
			navigation: { to: "https://evil.test/login" },
		});
		await Bun.sleep(5);
		const [view] = questions.list as [QuestionView];
		expect(view.site).toBe(false);
		expect(view.navigation).toEqual({ to: "https://evil.test/login" });
		const [text] = [...shown.values()] as [NotificationText];
		expect(text).toEqual({
			title: "Allow opening evil.test?",
			message:
				"Claude (claude.ai) wants to take the tab to https://evil.test/login",
			contextMessage: "From shop.test · tab-mcp for Chrome",
			buttons: ["Allow"],
		});
	});

	test("a long address is cut in the notification, the site stays in its title", () => {
		const to = `https://evil.test/${"a".repeat(400)}`;
		const text = notificationText(
			{
				id: "q",
				app: "Claude (claude.ai)",
				host: "claude.ai",
				tool: "navigate",
				title: "opening evil.test",
				origin: SHOP,
				navigation: { to },
				args: "{}",
				site: false,
			},
			"{}",
		);
		expect(text.title).toBe("Allow opening evil.test?");
		expect(text.message.length).toBeLessThanOrEqual(300);
	});

	test("a long host is cut from its start in the title: the end names the site", async () => {
		const host = `shop.example.${"a".repeat(80)}.evil.test`;
		expect(hostEnd(host)).toHaveLength(MAX_TITLE_HOST);
		expect(hostEnd(host)).toEndWith("aaaa.evil.test");
		expect(hostEnd(host)).toStartWith("…");
		expect(hostEnd("evil.test")).toBe("evil.test");
		const chrome = fakeChrome({
			url: SHOP,
			readable: true,
			history: history(),
		});
		const t = tools(chrome);
		await t.call("navigate", { url: `https://${host}/` });
		const title = t.asked[0]?.request.tool.title ?? "";
		expect(title).toEndWith(".evil.test");
		// Whole after notificationText's own cut of the title.
		expect(`opening ${hostEnd(host)}`.length).toBeLessThanOrEqual(60);
	});

	test("the card in the panel: From (verified), To, the arguments; no page title, no Don't ask again", async () => {
		const window = new HappyWindow({
			url: "chrome-extension://x/sidepanel/index.html",
		});
		const before = globalThis.document;
		globalThis.document = window.document as unknown as Document;
		try {
			const card = questionCard(
				{
					id: "q",
					app: "Claude (claude.ai)",
					host: "claude.ai",
					tool: "navigate",
					title: "opening evil.test",
					origin: SHOP,
					navigation: { to: "https://evil.test/" },
					args: '{\n  "url": "https://evil.test/"\n}',
					site: true, // not trusted for a navigation: see below
				},
				() => {},
			);
			const text = card.textContent ?? "";
			expect(text).toContain(
				"Claude (claude.ai) wants to take the tab to another site (navigate).",
			);
			expect(text).toContain(`From (verified) ${SHOP}`);
			expect(text).toContain("To https://evil.test/");
			expect(text).not.toContain("Title (from the page)");
			expect(card.querySelector("pre")?.textContent).toContain("evil.test");
			expect(
				[...card.querySelectorAll("button")].map((b) => b.dataset["answer"]),
			).toEqual(["deny", "allow"]);
		} finally {
			globalThis.document = before;
			await window.happyDOM.close();
		}
	});

	test("a page tool's card: Don't allow, Allow, Don't ask again on <host> (EQ 10)", async () => {
		const window = new HappyWindow({
			url: "chrome-extension://x/sidepanel/index.html",
		});
		const before = globalThis.document;
		globalThis.document = window.document as unknown as Document;
		try {
			const answers: Answer[] = [];
			const card = questionCard(
				{
					id: "q",
					app: "Claude (claude.ai)",
					host: "claude.ai",
					tool: "page_place_order",
					title: "Place order",
					origin: "https://www.shop.example:8443",
					args: "{}",
					site: true,
				},
				(answer) => answers.push(answer),
			);
			const buttons = [...card.querySelectorAll("button")];
			expect(buttons.map((b) => b.textContent)).toEqual([
				"Don't allow",
				"Allow",
				"Don't ask again on www.shop.example:8443",
			]);
			expect(card.textContent).toContain("for every paired AI app");
			// Disabled until the panel has been in front long enough.
			expect(buttons[2]?.disabled).toBe(true);
			(buttons[2] as HTMLButtonElement).disabled = false;
			buttons[2]?.click();
			expect(answers).toEqual(["site"]);
			// Not offered (an opaque origin): two buttons.
			const opaque = questionCard(
				{
					id: "q2",
					app: "Claude (claude.ai)",
					host: "claude.ai",
					tool: "page_place_order",
					origin: "null",
					args: "{}",
					site: false,
				},
				() => {},
			);
			expect(opaque.querySelectorAll("button")).toHaveLength(2);
		} finally {
			globalThis.document = before;
			await window.happyDOM.close();
		}
	});
});

describe("the tab's history, as the content script sees it", () => {
	/** A window with a Navigation API of `entries` (same origin only) at `index`. */
	const win = (
		length: number,
		entries?: { url: string | null }[],
		index = 0,
	): Window =>
		({
			history: { length },
			...(entries
				? {
						navigation: {
							currentEntry: { index },
							entries: () => entries.map((e, i) => ({ ...e, index: i })),
						},
					}
				: {}),
		}) as unknown as Window;

	test("back and forward only where the Navigation API lists them", () => {
		expect(
			pageHistory(
				win(4, [{ url: `${SHOP}/a` }, { url: `${SHOP}/b` }, { url: null }], 1),
			),
		).toEqual({
			length: 4,
			back: { url: `${SHOP}/a` },
			forward: { url: null },
		});
		// The first of its origin: the page before (if any) is another origin.
		expect(pageHistory(win(3, [{ url: `${SHOP}/a` }], 0))).toEqual({
			length: 3,
		});
		// No Navigation API: nothing known.
		expect(pageHistory(win(2))).toEqual({ length: 2 });
		// An address too long to send is hidden, the entry still there.
		expect(
			pageHistory(
				win(2, [{ url: `${SHOP}/${"a".repeat(MAX_URL)}` }, { url: SHOP }], 1),
			),
		).toEqual({ length: 2, back: { url: null } });
	});
});
