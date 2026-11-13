/** The default dialogs in a DOM (happy-dom, passed in; no globals touched). */
import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import { Window } from "happy-dom";
import type { TabMcp } from "../src/index.ts";
import type {
	ConfirmRequest,
	Grant,
	RelayClient,
	SessionInfo,
} from "../src/types.ts";
import {
	CODE_USED_WAIT_MS,
	COPIED_MS,
	confirmDialog,
	DIALOG_CSS,
	replacedNotice,
	SELECTED_MS,
	showConnectDialog,
} from "../src/ui.ts";
import { newTab, nextEvent } from "./helpers.ts";
import { StubRelay } from "./stub-relay.ts";

let window: Window;
let doc: Document;

beforeEach(() => {
	window = new Window({ url: "https://page.example/" });
	doc = window.document as unknown as Document;
});
afterEach(async () => {
	await window.happyDOM.close();
});

const buttons = (root: ParentNode) =>
	[...root.querySelectorAll("button")] as HTMLButtonElement[];
const byText = (root: ParentNode, text: string) => {
	const found = buttons(root).find((b) => b.textContent === text);
	if (found === undefined) throw new Error(`no button ${text}`);
	return found;
};
/** Whether the element is shown: neither it nor an ancestor is `hidden`. */
const shown = (node: Element | null) =>
	node !== null && node.closest("[hidden]") === null;

/** Resolves once the button is enabled (event-driven, via MutationObserver). */
function enabled(button: HTMLButtonElement): Promise<void> {
	if (!button.disabled) return Promise.resolve();
	return new Promise((resolve) => {
		const observer = new (
			window.MutationObserver as unknown as typeof MutationObserver
		)(() => {
			if (!button.disabled) {
				observer.disconnect();
				resolve();
			}
		});
		observer.observe(button, {
			attributes: true,
			attributeFilter: ["disabled"],
		});
	});
}

const APP: RelayClient = {
	kind: "relay",
	grantId: "g_1",
	id: "https://claude.ai/c.json",
	name: "Claude",
	host: "claude.ai",
};

function question(signal = new AbortController().signal): ConfirmRequest {
	return {
		tool: {
			name: "clear_memory",
			title: "Clear memory",
			description: "Clears the calculator memory",
		},
		arguments: { all: true, note: "<b>not html</b>" },
		client: APP,
		signal,
	};
}

describe("confirmDialog", () => {
	test("shows the tool, the client and the arguments as text; Allow resolves allow", async () => {
		const answer = confirmDialog(question(), doc);
		const dialog = doc.querySelector(
			"dialog.tab-mcp-confirm",
		) as HTMLDialogElement;
		expect(dialog.open).toBe(true);
		expect(dialog.querySelector("h2")?.textContent).toBe("Allow Clear memory?");
		expect(dialog.textContent).toContain(
			"Claude (claude.ai) wants to run Clear memory.",
		);
		expect(dialog.querySelector("pre")?.textContent).toContain(
			'"note": "<b>not html</b>"',
		);
		expect(dialog.querySelector("b")).toBeNull();
		expect(dialog.getAttribute("aria-labelledby")).toBe(
			dialog.querySelector("h2")?.id ?? "none",
		);
		expect(doc.activeElement?.textContent).toBe("Don't allow");
		const allow = byText(dialog, "Allow");
		await enabled(allow);
		allow.click();
		expect(await answer).toBe("allow");
		expect(doc.querySelector("dialog")).toBeNull();
	});

	test("Don't allow stands out as the safe choice; the arguments wrap and scroll (dialog design)", async () => {
		const answer = confirmDialog(question(), doc, { alwaysAllow: true });
		const dialog = doc.querySelector(
			"dialog.tab-mcp-confirm",
		) as HTMLDialogElement;
		const deny = byText(dialog, "Don't allow");
		expect([...deny.classList]).toEqual(["tab-mcp-deny", "tab-mcp-primary"]);
		expect([...byText(dialog, "Allow").classList]).toEqual(["tab-mcp-allow"]);
		expect([...byText(dialog, "Always allow").classList]).toEqual([
			"tab-mcp-always",
		]);
		const args = dialog.querySelector("pre") as HTMLElement;
		expect(args.style.getPropertyValue("white-space")).toBe("pre-wrap");
		expect(args.style.getPropertyValue("overflow-wrap")).toBe("anywhere");
		expect(args.style.getPropertyValue("overflow")).toBe("auto");
		deny.click();
		expect(await answer).toBe("deny");
	});

	test("Don't allow, Escape (close without a value) and an aborted call resolve deny", async () => {
		const denied = confirmDialog(question(), doc);
		byText(doc, "Don't allow").click();
		expect(await denied).toBe("deny");

		const escaped = confirmDialog(question(), doc);
		(doc.querySelector("dialog") as HTMLDialogElement).close();
		expect(await escaped).toBe("deny");

		const controller = new AbortController();
		const aborted = confirmDialog(question(controller.signal), doc);
		controller.abort();
		expect(await aborted).toBe("deny");
		expect(doc.querySelector("dialog")).toBeNull();
	});
});

describe("confirmDialog: Always allow", () => {
	test('waits like Allow, says how long it lasts, and resolves "always"', async () => {
		const answer = confirmDialog(question(), doc, { alwaysAllow: true });
		const dialog = doc.querySelector(
			"dialog.tab-mcp-confirm",
		) as HTMLDialogElement;
		expect(dialog.querySelector(".tab-mcp-always-note")?.textContent).toBe(
			"Always allow: Clear memory runs without asking for Claude (claude.ai) until you reload this page or disconnect it.",
		);
		const always = byText(dialog, "Always allow");
		expect(always.disabled).toBe(true);
		always.click();
		expect(dialog.open).toBe(true);
		await enabled(always);
		always.click();
		expect(await answer).toBe("always");
	});

	test("off by default: only Don't allow and Allow, no note (iteration 13, DEC-096)", async () => {
		const answer = confirmDialog(question(), doc);
		const dialog = doc.querySelector(
			"dialog.tab-mcp-confirm",
		) as HTMLDialogElement;
		expect(buttons(dialog).map((b) => b.textContent)).toEqual([
			"Don't allow",
			"Allow",
		]);
		expect(dialog.querySelector(".tab-mcp-always-note")).toBeNull();
		expect(dialog.textContent).not.toContain("Always");
		byText(dialog, "Don't allow").click();
		expect(await answer).toBe("deny");
	});

	test("TabMcp remembers it per grant and tool; a removed grant or tool asks again", async () => {
		const g = globalThis as { document?: Document | undefined };
		const saved = g.document;
		g.document = doc;
		const relay = new StubRelay();
		relay.grants = [
			{
				grantId: "g_1",
				client: {
					id: "https://claude.ai/c.json",
					name: "Claude",
					host: "claude.ai",
				},
				createdAt: "2026-10-19T20:00:00.000Z",
			},
		];
		const mcp = newTab(relay.url, { alwaysAllow: true });
		const tool = new AbortController();
		await mcp.registerTool(
			{ name: "clear_memory", description: "Clears", execute: () => "ok" },
			{ signal: tool.signal },
		);
		const dialog = () =>
			new Promise<HTMLDialogElement>((resolve) => {
				const poll = () => {
					const found = doc.querySelector("dialog.tab-mcp-confirm");
					if (found !== null) resolve(found as HTMLDialogElement);
					else setTimeout(poll, 1);
				};
				poll();
			});
		try {
			await mcp.connect();
			const first = mcp.confirmInPage(question());
			const always = byText(await dialog(), "Always allow");
			await enabled(always);
			always.click();
			expect(await first).toBe(true);
			// Asked no more for that grant and tool.
			expect(await mcp.confirmInPage(question())).toBe(true);
			// The grant goes: asked again.
			relay.send({ type: "grant.removed", grantId: "g_1", reason: "revoked" });
			await relay.settled();
			relay.send({ type: "grant.added", grant: relay.grants[0] });
			await relay.settled();
			const again = mcp.confirmInPage(question());
			byText(await dialog(), "Don't allow").click();
			expect(await again).toBe(false);
		} finally {
			tool.abort();
			mcp.disconnect();
			await relay.stop();
			g.document = saved;
		}
	});

	test("TabMcp offers it only with alwaysAllow: true (DEC-096)", async () => {
		const g = globalThis as { document?: Document | undefined };
		const saved = g.document;
		g.document = doc;
		try {
			for (const [options, offered] of [
				[{}, false],
				[{ alwaysAllow: false }, false],
				[{ alwaysAllow: true }, true],
			] as const) {
				const mcp = newTab("http://127.0.0.1:9", options);
				const answer = mcp.confirmInPage(question());
				const dialog = await new Promise<HTMLDialogElement>((resolve) => {
					const poll = () => {
						const found = doc.querySelector("dialog.tab-mcp-confirm");
						if (found !== null) resolve(found as HTMLDialogElement);
						else setTimeout(poll, 1);
					};
					poll();
				});
				expect({
					options,
					offered: buttons(dialog).some(
						(b) => b.textContent === "Always allow",
					),
				}).toEqual({ options, offered });
				byText(dialog, "Don't allow").click();
				expect(await answer).toBe(false);
			}
		} finally {
			g.document = saved;
		}
	});
});

describe("a WebMCP caller (iteration 25)", () => {
	test("is named an agent in this browser and never offered or given Always allow", async () => {
		const g = globalThis as { document?: Document | undefined };
		const saved = g.document;
		g.document = doc;
		const mcp = newTab("http://127.0.0.1:9", { alwaysAllow: true });
		const ask = () =>
			mcp.confirmInPage({ ...question(), client: { kind: "webmcp" } });
		const dialog = () =>
			new Promise<HTMLDialogElement>((resolve) => {
				const poll = () => {
					const found = doc.querySelector("dialog.tab-mcp-confirm");
					if (found !== null) resolve(found as HTMLDialogElement);
					else setTimeout(poll, 1);
				};
				poll();
			});
		try {
			const first = ask();
			const shown = await dialog();
			expect(shown.textContent).toContain(
				"An agent in this browser wants to run Clear memory.",
			);
			expect(buttons(shown).map((b) => b.textContent)).toEqual([
				"Don't allow",
				"Allow",
			]);
			expect(shown.querySelector(".tab-mcp-always-note")).toBeNull();
			const allow = byText(shown, "Allow");
			await enabled(allow);
			allow.click();
			expect(await first).toBe(true);
			// Every call asks again.
			const again = ask();
			byText(await dialog(), "Don't allow").click();
			expect(await again).toBe(false);
		} finally {
			g.document = saved;
		}
	});
});

describe("a caller served over a port (iteration 28)", () => {
	test("is named with what the page said, as this site's assistant, without Always allow", async () => {
		const g = globalThis as { document?: Document | undefined };
		const saved = g.document;
		g.document = doc;
		const mcp = newTab("http://127.0.0.1:9", { alwaysAllow: true });
		const shownFor = async (client: { id: string; name?: string }) => {
			const answer = mcp.confirmInPage({
				...question(),
				client: { kind: "local", ...client },
			});
			let dialog: HTMLDialogElement | null = null;
			while (dialog === null) {
				await new Promise((resolve) => setTimeout(resolve, 1));
				dialog = doc.querySelector("dialog.tab-mcp-confirm");
			}
			const text = dialog.querySelector("p")?.textContent;
			const offered = buttons(dialog).map((b) => b.textContent);
			byText(dialog, "Don't allow").click();
			expect(await answer).toBe(false);
			return { text, offered };
		};
		try {
			expect(await shownFor({ id: "chat", name: "Example assistant" })).toEqual(
				{
					text: "Example assistant (this site's assistant) wants to run Clear memory.",
					offered: ["Don't allow", "Allow"],
				},
			);
			// Without a name, the id; invisible characters are shown as escapes.
			expect((await shownFor({ id: "chat\u202e" })).text).toBe(
				"chat\\u202E (this site's assistant) wants to run Clear memory.",
			);
		} finally {
			g.document = saved;
		}
	});
});

describe("confirmDialog safety (review of PR #2)", () => {
	test("long arguments are shown in full", async () => {
		const long = "x".repeat(5000);
		const answer = confirmDialog(
			{ ...question(), arguments: { long, tail: "END-MARKER" } },
			doc,
		);
		const text =
			doc.querySelector("dialog.tab-mcp-confirm pre")?.textContent ?? "";
		expect(text).toContain(long);
		expect(text).toContain("END-MARKER");
		byText(doc, "Don't allow").click();
		expect(await answer).toBe("deny");
	});

	test("arguments that cannot be shown offer neither Allow nor Always allow", async () => {
		const loop: Record<string, unknown> = {};
		loop["self"] = loop;
		const answer = confirmDialog({ ...question(), arguments: loop }, doc, {
			alwaysAllow: true,
		});
		expect(byText(doc, "Allow").hidden).toBe(true);
		expect(byText(doc, "Always allow").hidden).toBe(true);
		byText(doc, "Don't allow").click();
		expect(await answer).toBe("deny");
	});

	test("Allow is disabled for a moment after the dialog opens; a click then does nothing", async () => {
		const started = Date.now();
		const answer = confirmDialog(question(), doc, { allowDelayMs: 600 });
		const dialog = doc.querySelector(
			"dialog.tab-mcp-confirm",
		) as HTMLDialogElement;
		const allow = byText(dialog, "Allow");
		expect(allow.disabled).toBe(true);
		allow.click();
		expect(dialog.open).toBe(true);
		await enabled(allow);
		expect(Date.now() - started).toBeGreaterThanOrEqual(590);
		allow.click();
		expect(await answer).toBe("allow");
	});

	test("the delay cannot go below 500 ms", async () => {
		const started = Date.now();
		const answer = confirmDialog(question(), doc, { allowDelayMs: 0 });
		const allow = byText(doc, "Allow");
		expect(allow.disabled).toBe(true);
		await enabled(allow);
		expect(Date.now() - started).toBeGreaterThanOrEqual(490);
		allow.click();
		expect(await answer).toBe("allow");
	});
});

describe("confirmDialog: only while the user sees the page (iteration 13)", () => {
	// The tab may be in the background or another window may have the focus
	// when an AI app calls: the delay counts only while the page is visible
	// and focused, and starts again when the user comes back.
	let hidden: boolean;
	let focused: boolean;
	beforeEach(() => {
		hidden = false;
		focused = true;
		Object.defineProperty(doc, "visibilityState", {
			configurable: true,
			get: () => (hidden ? "hidden" : "visible"),
		});
		Object.defineProperty(doc, "hidden", {
			configurable: true,
			get: () => hidden,
		});
		Object.defineProperty(doc, "hasFocus", {
			configurable: true,
			value: () => focused,
		});
		jest.useFakeTimers();
	});
	afterEach(() => {
		jest.useRealTimers();
	});
	const show = () => {
		hidden = false;
		doc.dispatchEvent(new window.Event("visibilitychange") as unknown as Event);
	};
	const hide = () => {
		hidden = true;
		doc.dispatchEvent(new window.Event("visibilitychange") as unknown as Event);
	};
	const focus = () => {
		focused = true;
		window.dispatchEvent(new window.Event("focus"));
	};
	const blur = () => {
		focused = false;
		window.dispatchEvent(new window.Event("blur"));
	};

	test("opened in a hidden tab: Allow waits for the tab to be shown, then the full delay", async () => {
		hidden = true;
		const answer = confirmDialog(question(), doc, {
			allowDelayMs: 600,
			alwaysAllow: true,
		});
		const allow = byText(doc, "Allow");
		const always = byText(doc, "Always allow");
		jest.advanceTimersByTime(60_000);
		expect(allow.disabled).toBe(true);
		expect(always.disabled).toBe(true);
		allow.click(); // the click that brings the tab forward
		expect((doc.querySelector("dialog") as HTMLDialogElement).open).toBe(true);
		show();
		jest.advanceTimersByTime(599);
		expect(allow.disabled).toBe(true);
		jest.advanceTimersByTime(1);
		expect(allow.disabled).toBe(false);
		expect(always.disabled).toBe(false);
		allow.click();
		expect(await answer).toBe("allow");
	});

	test("in a hidden tab, the tab's title says the page asks; put back when shown or answered (CU 9)", async () => {
		doc.title = "Notes";
		hidden = true;
		const first = confirmDialog(question(), doc);
		expect(doc.title).toBe("Allow? – Notes");
		show();
		expect(doc.title).toBe("Notes");
		hide();
		expect(doc.title).toBe("Allow? – Notes");
		byText(doc, "Don't allow").click();
		expect(await first).toBe("deny");
		expect(doc.title).toBe("Notes");
		// A title the page changed meanwhile is left as the page set it.
		const second = confirmDialog(question(), doc);
		expect(doc.title).toBe("Allow? – Notes");
		doc.title = "Notes (1 new)";
		byText(doc, "Don't allow").click();
		await second;
		expect(doc.title).toBe("Notes (1 new)");
		// A visible tab keeps its title.
		show();
		const third = confirmDialog(question(), doc);
		expect(doc.title).toBe("Notes (1 new)");
		byText(doc, "Don't allow").click();
		await third;
	});

	test("opened while another window has the focus: the delay starts on focus", async () => {
		focused = false;
		const answer = confirmDialog(question(), doc, { allowDelayMs: 600 });
		const allow = byText(doc, "Allow");
		jest.advanceTimersByTime(60_000);
		expect(allow.disabled).toBe(true);
		focus();
		jest.advanceTimersByTime(599);
		expect(allow.disabled).toBe(true);
		jest.advanceTimersByTime(1);
		expect(allow.disabled).toBe(false);
		byText(doc, "Don't allow").click();
		expect(await answer).toBe("deny");
	});

	test("leaving the page disables Allow again; coming back starts the delay again", async () => {
		const answer = confirmDialog(question(), doc, {
			allowDelayMs: 600,
			alwaysAllow: true,
		});
		const allow = byText(doc, "Allow");
		const always = byText(doc, "Always allow");
		jest.advanceTimersByTime(600);
		expect(allow.disabled).toBe(false);
		blur();
		expect(allow.disabled).toBe(true);
		expect(always.disabled).toBe(true);
		focus();
		jest.advanceTimersByTime(599);
		expect(allow.disabled).toBe(true);
		jest.advanceTimersByTime(1);
		expect(allow.disabled).toBe(false);
		// Hidden half-way through the delay: it starts over when shown.
		hide();
		expect(allow.disabled).toBe(true);
		show();
		jest.advanceTimersByTime(300);
		hide();
		show();
		jest.advanceTimersByTime(599);
		expect(allow.disabled).toBe(true);
		jest.advanceTimersByTime(1);
		expect(always.disabled).toBe(false);
		always.click();
		expect(await answer).toBe("always");
	});

	test("once closed, it no longer follows the page", async () => {
		const answer = confirmDialog(question(), doc, { allowDelayMs: 600 });
		const allow = byText(doc, "Allow");
		byText(doc, "Don't allow").click();
		expect(await answer).toBe("deny");
		blur();
		focus();
		jest.advanceTimersByTime(600);
		expect(allow.disabled).toBe(true);
		expect(jest.getTimerCount()).toBe(0);
	});
});

describe("confirmDialog: what the arguments look like (iteration 13)", () => {
	test("invisible and direction characters are shown as escapes; the arguments are unchanged", async () => {
		const to = "evil\u202Emoc.elpmaxe@ecila";
		const args = {
			to,
			zw: "a\u200Bb\u2060c\uFEFF",
			isolate: "\u2066x\u2069",
			tag: "\u{E0041}",
			private: "\uE000",
			c1: "\u0085",
			line: "a\u2028b",
			"key\u202E": 1,
		};
		const copy = structuredClone(args);
		const answer = confirmDialog({ ...question(), arguments: args }, doc);
		const text = doc.querySelector("dialog pre")?.textContent ?? "";
		expect(text).toContain('"to": "evil\\u202Emoc.elpmaxe@ecila"');
		expect(text).toContain('"zw": "a\\u200Bb\\u2060c\\uFEFF"');
		expect(text).toContain('"isolate": "\\u2066x\\u2069"');
		expect(text).toContain('"tag": "\\uDB40\\uDC41"');
		expect(text).toContain('"private": "\\uE000"');
		expect(text).toContain('"c1": "\\u0085"');
		expect(text).toContain('"line": "a\\u2028b"');
		expect(text).toContain('"key\\u202E": 1');
		expect(text).not.toMatch(/[\p{Cf}\p{Co}\u0080-\u009F\u2028]/u);
		// What is shown is still JSON for the same arguments.
		expect(JSON.parse(text)).toEqual(copy);
		expect(args).toEqual(copy);
		byText(doc, "Don't allow").click();
		expect(await answer).toBe("deny");
	});

	test("ordinary text, emoji and other scripts are shown as they are", async () => {
		const answer = confirmDialog(
			{ ...question(), arguments: { note: "Grüße, 東京, مرحبا 🙂" } },
			doc,
		);
		expect(doc.querySelector("dialog pre")?.textContent).toContain(
			'"note": "Grüße, 東京, مرحبا 🙂"',
		);
		byText(doc, "Don't allow").click();
		expect(await answer).toBe("deny");
	});

	test("the names of the app and the tool are isolated left to right", async () => {
		const answer = confirmDialog(
			{
				...question(),
				client: { ...APP, name: "\u202EedualC" },
			},
			doc,
		);
		const dialog = doc.querySelector("dialog") as HTMLDialogElement;
		const names = [...dialog.querySelectorAll("bdi")].map((b) => [
			b.getAttribute("dir"),
			b.textContent,
		]);
		expect(names).toContainEqual(["ltr", "Clear memory"]);
		expect(names).toContainEqual(["ltr", "\\u202EedualC (claude.ai)"]);
		expect(dialog.querySelector("pre")?.getAttribute("dir")).toBe("ltr");
		expect(dialog.textContent).not.toContain("\u202E");
		byText(doc, "Don't allow").click();
		expect(await answer).toBe("deny");
	});
});

describe("confirmDialog: the delay option (iteration 13)", () => {
	test("a delay that is not a number of ms falls back to the default", async () => {
		for (const allowDelayMs of [
			Number.NaN,
			Number.POSITIVE_INFINITY,
			2 ** 31,
		]) {
			const started = Date.now();
			const answer = confirmDialog(question(), doc, { allowDelayMs });
			const allow = byText(doc, "Allow");
			await Bun.sleep(20);
			expect(allow.disabled).toBe(true);
			await enabled(allow);
			expect(Date.now() - started).toBeGreaterThanOrEqual(740);
			expect(Date.now() - started).toBeLessThan(5_000);
			allow.click();
			expect(await answer).toBe("allow");
		}
	});
});

describe("showConnectDialog", () => {
	let relay: StubRelay;
	let mcp: TabMcp;
	const GRANT: Grant = {
		grantId: "g_1",
		client: {
			id: "https://claude.ai/c.json",
			name: "Claude",
			host: "claude.ai",
		},
		createdAt: "2026-10-19T20:00:00.000Z",
	};

	beforeEach(() => {
		relay = new StubRelay();
		relay.grants = [GRANT];
		mcp = newTab(relay.url, { appName: "saturnus" });
	});
	afterEach(async () => {
		mcp.disconnect();
		await relay.stop();
	});

	async function open(): Promise<{
		dialog: HTMLDialogElement;
		closed: Promise<void>;
		session: SessionInfo;
	}> {
		const connecting = mcp.connect();
		const closed = showConnectDialog(mcp, connecting, doc);
		const session = await connecting;
		await relay.next("pairing.start");
		return {
			dialog: doc.querySelector("dialog.tab-mcp-connect") as HTMLDialogElement,
			closed,
			session,
		};
	}

	test("shows the address, instructions and connected apps; pairing runs while open", async () => {
		const { dialog, closed, session } = await open();
		expect(dialog.open).toBe(true);
		expect(dialog.querySelector("h2")?.textContent).toBe("Connect your AI app");
		expect((dialog.querySelector("input") as HTMLInputElement).value).toBe(
			session.address,
		);
		expect(dialog.querySelector(".tab-mcp-status")?.textContent).toBe(
			"saturnus is ready for your AI app.",
		);
		expect(dialog.querySelector(".tab-mcp-help")?.textContent).toContain(
			`claude mcp add --transport http tools ${session.address}`,
		);
		expect(dialog.querySelector(".tab-mcp-apps")?.textContent).toContain(
			"Claude (claude.ai) connected",
		);
		expect((dialog.querySelector(".tab-mcp-code") as HTMLElement).hidden).toBe(
			true,
		);
		// An app was connected when it opened: the connected state, the setup
		// behind "Connect another app", Done.
		const success = dialog.querySelector(".tab-mcp-success") as HTMLElement;
		expect(shown(success)).toBe(true);
		expect(success.textContent).toBe(
			"Claude (claude.ai) is connectedYou can close this now and ask it to use the tools of this page.",
		);
		expect(dialog.getAttribute("aria-describedby")).toBe(success.id);
		const toggle = byText(dialog, "Connect another app");
		expect(shown(toggle)).toBe(true);
		expect(toggle.getAttribute("aria-expanded")).toBe("false");
		const setup = dialog.querySelector(".tab-mcp-setup") as HTMLElement;
		expect(toggle.getAttribute("aria-controls")).toBe(setup.id);
		expect(setup.hidden).toBe(true);
		const done = byText(dialog, "Done");
		const close = byText(dialog, "Close");
		expect(done.hidden).toBe(false);
		expect(close.hidden).toBe(true);
		expect(doc.activeElement).toBe(done);
		toggle.click();
		expect(toggle.getAttribute("aria-expanded")).toBe("true");
		expect(setup.hidden).toBe(false);
		expect(doc.activeElement).toBe(done);

		const code = nextEvent(mcp, "pairingcode");
		relay.send({
			type: "pairing.code",
			code: "123456",
			expiresAt: "2026-10-20T10:00:00.000Z",
		});
		await code;
		const codeLine = dialog.querySelector(".tab-mcp-code") as HTMLElement;
		expect(codeLine.hidden).toBe(false);
		expect(codeLine.querySelector(".tab-mcp-code-value")?.textContent).toBe(
			"123456",
		);
		expect(codeLine.textContent).toBe(
			"When asked, enter the code 123456 CopyA new code appears every 2 minutes and after each use.",
		);
		// A newly connected app is named and announced; the setup closes again.
		const added = nextEvent(mcp, "grantschange");
		relay.send({
			type: "grant.added",
			grant: {
				grantId: "g_2",
				client: {
					id: "https://chatgpt.com/c.json",
					name: "ChatGPT",
					host: "chatgpt.com",
				},
				createdAt: "2026-10-20T10:00:00.000Z",
			},
		});
		await added;
		expect(dialog.querySelector(".tab-mcp-status")?.textContent).toBe(
			"ChatGPT (chatgpt.com) is connected.",
		);
		expect(dialog.querySelector(".tab-mcp-success-title")?.textContent).toBe(
			"ChatGPT (chatgpt.com) is connected",
		);
		expect(dialog.querySelector(".tab-mcp-announce")?.textContent).toBe(
			"ChatGPT (chatgpt.com) is connected. You can close this now and ask it to use the tools of this page.",
		);
		expect(setup.hidden).toBe(true);
		expect(toggle.getAttribute("aria-expanded")).toBe("false");
		expect(done.hidden).toBe(false);
		expect(close.hidden).toBe(true);
		relay.send({ type: "grant.removed", grantId: "g_2", reason: "revoked" });
		await nextEvent(mcp, "grantschange");

		byText(dialog, "Disconnect").click();
		expect(await relay.next("grant.revoke")).toEqual({
			type: "grant.revoke",
			grantId: "g_1",
		});
		relay.send({ type: "grant.removed", grantId: "g_1", reason: "revoked" });
		await nextEvent(mcp, "grantschange");
		expect((dialog.querySelector(".tab-mcp-apps") as HTMLElement).hidden).toBe(
			true,
		);
		// None connected: the setup again, in full, with Close.
		expect(shown(success)).toBe(false);
		expect(shown(toggle)).toBe(false);
		expect(setup.hidden).toBe(false);
		expect(close.hidden).toBe(false);
		expect(dialog.hasAttribute("aria-describedby")).toBe(false);

		close.click();
		await closed;
		expect(await relay.next("pairing.stop")).toEqual({ type: "pairing.stop" });
		expect(doc.querySelector("dialog")).toBeNull();
		expect(mcp.pairing).toBe(false);
	});

	/** A clipboard that records what was written; returns the last text. */
	function stubClipboard(): () => string {
		let copied = "";
		Object.defineProperty(window.navigator, "clipboard", {
			value: {
				writeText: async (text: string) => {
					copied = text;
				},
			},
			configurable: true,
		});
		return () => copied;
	}

	async function sendCode(
		code: string,
		expiresAt = "2026-10-20T10:00:00.000Z",
		reason?: string,
	): Promise<void> {
		const shown = nextEvent(mcp, "pairingcode");
		relay.send({
			type: "pairing.code",
			code,
			expiresAt,
			...(reason === undefined ? {} : { reason }),
		});
		await shown;
	}
	/** An expiry two minutes from now, as the relay sends with a fresh code. */
	const inTwoMinutes = () => new Date(Date.now() + 120_000).toISOString();

	test("each command in the help has a Copy that copies it whole (dialog design)", async () => {
		const copied = stubClipboard();
		const connecting = mcp.connect();
		const closed = showConnectDialog(mcp, connecting, doc, "My notes");
		const session = await connecting;
		await relay.next("pairing.start");
		const dialog = doc.querySelector("dialog.tab-mcp-connect") as HTMLElement;
		const copies = [
			...dialog.querySelectorAll(".tab-mcp-command-copy"),
		] as HTMLButtonElement[];
		expect(copies.map((b) => b.getAttribute("aria-label"))).toEqual([
			"Copy Claude Code command",
			"Copy Codex command",
		]);
		(copies[1] as HTMLButtonElement).click();
		await Bun.sleep(0);
		// The page's server name, quoted for the shell.
		expect(copied()).toBe(
			`codex features enable mcp_2026_07_28\ncodex mcp add my-notes --url ${session.address}\ncodex mcp login my-notes`,
		);
		expect(copies[1]?.textContent).toBe("Copied");
		byText(dialog, "Close").click();
		await closed;
	});

	test("what Copy did is announced: copied, or selected for Ctrl+C (review of PR 34)", async () => {
		const copied = stubClipboard();
		const { dialog } = await open();
		await sendCode("123456");
		const live = dialog.querySelector(".tab-mcp-announce") as HTMLElement;
		expect(live.getAttribute("aria-live")).toBe("polite");
		expect(live.textContent).toBe("");
		(dialog.querySelector(".tab-mcp-address-copy") as HTMLElement).click();
		await Bun.sleep(0);
		expect(copied()).not.toBe("");
		expect(live.textContent).toBe("Address copied");
		(dialog.querySelector(".tab-mcp-code-copy") as HTMLElement).click();
		await Bun.sleep(0);
		expect(live.textContent).toBe("Code copied");
		// The same message again is announced again.
		(dialog.querySelector(".tab-mcp-code-copy") as HTMLElement).click();
		await Bun.sleep(0);
		expect(live.textContent?.trim()).toBe("Code copied");
		expect(live.textContent).not.toBe("Code copied");
		(dialog.querySelector(".tab-mcp-command-copy") as HTMLElement).click();
		await Bun.sleep(0);
		expect(live.textContent).toBe("Claude Code command copied");
		// No clipboard: the text is selected, and that is said.
		Object.defineProperty(window.navigator, "clipboard", {
			value: undefined,
			configurable: true,
		});
		(dialog.querySelector(".tab-mcp-address-copy") as HTMLElement).click();
		await Bun.sleep(0);
		expect(live.textContent).toMatch(/^Press (Ctrl\+C|⌘C): address selected$/);
		// The clipboard refuses: the same.
		Object.defineProperty(window.navigator, "clipboard", {
			value: { writeText: () => Promise.reject(new Error("denied")) },
			configurable: true,
		});
		(dialog.querySelector(".tab-mcp-code-copy") as HTMLElement).click();
		await Bun.sleep(0);
		expect(live.textContent).toMatch(/^Press (Ctrl\+C|⌘C): code selected$/);
		// On a touch screen, no keys are named (review of PR 121).
		Object.defineProperty(window, "matchMedia", {
			value: (query: string) => ({ matches: query === "(pointer: coarse)" }),
			configurable: true,
		});
		(dialog.querySelector(".tab-mcp-address-copy") as HTMLElement).click();
		await Bun.sleep(0);
		expect(live.textContent).toBe("Address selected");
		expect(
			(dialog.querySelector(".tab-mcp-address-copy") as HTMLElement)
				.textContent,
		).toBe("Selected");
		byText(dialog, "Close").click();
	});

	test("Copy writes the address to the clipboard", async () => {
		const copied = stubClipboard();
		const { dialog, session } = await open();
		const copy = dialog.querySelector(
			".tab-mcp-address-copy",
		) as HTMLButtonElement;
		expect(copy).toBe(byText(dialog, "Copy"));
		expect(copy.getAttribute("aria-label")).toBe("Copy address");
		copy.click();
		await Bun.sleep(0);
		expect(copied()).toBe(session.address);
		expect(copy.textContent).toBe("Copied");
		expect(copy.getAttribute("aria-label")).toBe("Copied address");
		byText(dialog, "Close").click();
	});

	test("Copy next to the code copies the code shown, also after it changes", async () => {
		const copied = stubClipboard();
		const { dialog } = await open();
		await sendCode("123456");
		const codeLine = dialog.querySelector(".tab-mcp-code") as HTMLElement;
		const copy = codeLine.querySelector(
			"button.tab-mcp-code-copy",
		) as HTMLButtonElement;
		expect(copy.textContent).toBe("Copy");
		expect(copy.getAttribute("aria-label")).toBe("Copy code");
		// The code is plain text of its own, selectable in one go.
		const value = codeLine.querySelector(".tab-mcp-code-value") as HTMLElement;
		expect(value.childNodes.length).toBe(1);
		expect(value.style.getPropertyValue("user-select")).toBe("all");
		copy.click();
		await Bun.sleep(0);
		expect(copied()).toBe("123456");
		expect(copy.textContent).toBe("Copied");
		expect(copy.getAttribute("aria-label")).toBe("Copied code");

		// A new code: the button is back to Copy and copies the new one.
		await sendCode("654321");
		expect(copy.textContent).toBe("Copy");
		expect(copy.getAttribute("aria-label")).toBe("Copy code");
		copy.click();
		await Bun.sleep(0);
		expect(copied()).toBe("654321");
		expect(copy.textContent).toBe("Copied");
		// The address's Copy is a separate button.
		expect(
			byText(dialog, "Copy").classList.contains("tab-mcp-address-copy"),
		).toBe(true);
		byText(dialog, "Close").click();
	});

	test("before an app connects: no Done, a small Close that says what closing does", async () => {
		relay.grants = [];
		const { dialog, closed, session } = await open();
		await sendCode("123456");
		const done = byText(dialog, "Done");
		const close = byText(dialog, "Close");
		expect(done.hidden).toBe(true);
		expect(close.hidden).toBe(false);
		expect(close.classList.contains("tab-mcp-close")).toBe(true);
		const note = dialog.querySelector(".tab-mcp-close-note") as HTMLElement;
		expect(note.hidden).toBe(false);
		expect(note.textContent).toBe(
			"Closing this stops the code. The address stays the same: to connect later, open this again from the page.",
		);
		// Close comes last: after the code, its Copy and the help.
		const order = [
			...dialog.querySelectorAll("input, button, summary"),
		] as HTMLElement[];
		expect(order.at(-1)).toBe(done);
		expect(order.indexOf(close)).toBeGreaterThan(
			order.indexOf(dialog.querySelector(".tab-mcp-code-copy") as HTMLElement),
		);
		expect(order.indexOf(close)).toBeGreaterThan(
			order.indexOf(dialog.querySelector("summary") as HTMLElement),
		);
		// The dialog starts at the address's Copy, not at Close.
		expect(doc.activeElement).toBe(
			dialog.querySelector(".tab-mcp-address-copy"),
		);

		// Escape closes a modal <dialog> without a return value, like this.
		dialog.close();
		await closed;
		// What the note says: the code stops, the connection and address stay.
		expect(await relay.next("pairing.stop")).toEqual({ type: "pairing.stop" });
		expect(mcp.pairingCode).toBeUndefined();
		expect(mcp.state).toBe("connected");
		expect(mcp.address).toBe(session.address);

		// Opened again from the page: the same address, a new code.
		const again = showConnectDialog(mcp, Promise.resolve(session), doc);
		await relay.next("pairing.start");
		const reopened = doc.querySelector(
			"dialog.tab-mcp-connect",
		) as HTMLDialogElement;
		expect((reopened.querySelector("input") as HTMLInputElement).value).toBe(
			session.address,
		);
		byText(reopened, "Close").click();
		await again;
	});

	test("once an app connects: Done replaces Close (and takes its focus) and closes", async () => {
		relay.grants = [];
		const { dialog, closed } = await open();
		await relay.next("hello");
		const done = byText(dialog, "Done");
		const close = byText(dialog, "Close");
		close.focus();
		const added = nextEvent(mcp, "grantschange");
		relay.send({ type: "grant.added", grant: GRANT });
		await added;
		expect(dialog.querySelector(".tab-mcp-status")?.textContent).toBe(
			"Claude (claude.ai) is connected.",
		);
		expect(done.hidden).toBe(false);
		expect(close.hidden).toBe(true);
		expect(
			(dialog.querySelector(".tab-mcp-close-note") as HTMLElement).hidden,
		).toBe(true);
		expect(doc.activeElement).toBe(done);

		// A new address disconnects it: pairing starts over, so Close is back.
		byText(dialog, "New address").click();
		const connected = nextEvent(mcp, "connected");
		byText(dialog, "Disconnect and get new address").click();
		expect(done.hidden).toBe(true);
		expect(close.hidden).toBe(false);
		await relay.next("hello", (m) => m["revokeAll"] === true);
		await connected;

		const again = nextEvent(mcp, "grantschange");
		relay.send({ type: "grant.added", grant: { ...GRANT, grantId: "g_3" } });
		await again;
		expect(done.hidden).toBe(false);
		done.click();
		await closed;
		expect(doc.querySelector("dialog")).toBeNull();
	});

	test("when the app that connected here is disconnected again, Close and the note come back", async () => {
		relay.grants = [];
		const { dialog } = await open();
		await sendCode("123456");
		const done = byText(dialog, "Done");
		const close = byText(dialog, "Close");
		const note = dialog.querySelector(".tab-mcp-close-note") as HTMLElement;
		const added = nextEvent(mcp, "grantschange");
		relay.send({ type: "grant.added", grant: GRANT });
		await added;
		expect(done.hidden).toBe(false);
		done.focus();

		const removed = nextEvent(mcp, "grantschange");
		relay.send({
			type: "grant.removed",
			grantId: GRANT.grantId,
			reason: "revoked",
		});
		await removed;
		expect(done.hidden).toBe(true);
		expect(close.hidden).toBe(false);
		expect(note.hidden).toBe(false);
		// Focus moves off the hidden Done.
		expect(doc.activeElement).toBe(close);
		close.click();
	});

	test("the note about the code shows only while a code is shown; only the code is announced", async () => {
		relay.grants = [];
		const { dialog } = await open();
		const note = dialog.querySelector(".tab-mcp-close-note") as HTMLElement;
		// Connected, but no code yet: nothing to stop.
		expect(note.hidden).toBe(true);
		await sendCode("123456");
		expect(note.hidden).toBe(false);
		const code = dialog.querySelector(".tab-mcp-code-value") as HTMLElement;
		const live = dialog.querySelector('[aria-live="polite"]') as HTMLElement;
		expect(live.contains(code)).toBe(true);
		// The Copy button's "Copied" is not read out as a new code.
		expect(live.contains(dialog.querySelector(".tab-mcp-code-copy"))).toBe(
			false,
		);
		byText(dialog, "Close").click();
	});

	test("an app connects: the connected state in one change, no node made again, no new code in view (owner feedback)", async () => {
		relay.grants = [];
		const { dialog, closed } = await open();
		await sendCode("111111", inTwoMinutes(), "start");
		const value = dialog.querySelector(".tab-mcp-code-value") as HTMLElement;
		const used = dialog.querySelector(".tab-mcp-code-used") as HTMLElement;
		const success = dialog.querySelector(".tab-mcp-success") as HTMLElement;
		const setup = dialog.querySelector(".tab-mcp-setup") as HTMLElement;
		const toggle = byText(dialog, "Connect another app");
		const done = byText(dialog, "Done");
		expect(shown(value)).toBe(true);
		expect(used.hidden).toBe(true);
		expect(shown(success)).toBe(false);
		expect(shown(toggle)).toBe(false);
		expect(setup.hidden).toBe(false);
		const before = [...dialog.querySelectorAll("*")];
		const removed: Node[] = [];
		const observer = new (
			window.MutationObserver as unknown as typeof MutationObserver
		)((records) => {
			for (const record of records)
				for (const node of record.removedNodes)
					if (node.nodeType === 1) removed.push(node);
		});
		observer.observe(dialog, { childList: true, subtree: true });
		(dialog.querySelector(".tab-mcp-code-copy") as HTMLElement).focus();

		// The code is entered: the relay sends the next one at once, saying
		// why. The AI app connects a moment later.
		await sendCode("222222", inTwoMinutes(), "used");
		expect(shown(value)).toBe(false);
		expect(shown(used)).toBe(true);
		expect(used.textContent).toBe("Code used. Waiting for your AI app…");
		expect(shown(dialog.querySelector(".tab-mcp-code-copy"))).toBe(false);
		// Focus leaves the hidden Copy for the visible Close.
		expect(doc.activeElement).toBe(byText(dialog, "Close"));
		expect(dialog.querySelector(".tab-mcp-announce")?.textContent).toBe(
			"Code used. Waiting for your AI app…",
		);

		const added = nextEvent(mcp, "grantschange");
		relay.send({ type: "grant.added", grant: GRANT });
		await added;
		// The confirmation leads; the setup, with the next code, is closed.
		expect(shown(success)).toBe(true);
		expect(dialog.querySelector(".tab-mcp-success-title")?.textContent).toBe(
			"Claude (claude.ai) is connected",
		);
		expect(dialog.querySelector(".tab-mcp-success-next")?.textContent).toBe(
			"You can close this now and ask it to use the tools of this page.",
		);
		expect(dialog.querySelector(".tab-mcp-announce")?.textContent).toBe(
			"Claude (claude.ai) is connected. You can close this now and ask it to use the tools of this page.",
		);
		expect(dialog.getAttribute("aria-describedby")).toBe(success.id);
		expect(shown(toggle)).toBe(true);
		expect(toggle.getAttribute("aria-expanded")).toBe("false");
		expect(setup.hidden).toBe(true);
		expect(shown(dialog.querySelector(".tab-mcp-status"))).toBe(false);
		expect(doc.activeElement).toBe(done);
		// Opened again, the setup shows the next code, ready to use.
		toggle.click();
		expect(shown(value)).toBe(true);
		expect(value.textContent).toBe("222222");
		expect(used.hidden).toBe(true);

		// Nothing was taken out and put back: the same nodes, only shown or hidden.
		observer.disconnect();
		expect(removed).toEqual([]);
		expect(before.every((node) => node.isConnected)).toBe(true);
		expect(doc.querySelectorAll("dialog")).toHaveLength(1);
		done.click();
		await closed;
	});

	test("a used code that no app follows: the next code shows after the wait", async () => {
		relay.grants = [];
		const { dialog } = await open();
		const value = dialog.querySelector(".tab-mcp-code-value") as HTMLElement;
		const used = dialog.querySelector(".tab-mcp-code-used") as HTMLElement;
		await sendCode("111111", inTwoMinutes(), "start");
		jest.useFakeTimers();
		try {
			await sendCode("222222", inTwoMinutes(), "used");
			expect(shown(used)).toBe(true);
			jest.advanceTimersByTime(CODE_USED_WAIT_MS - 1);
			expect(shown(used)).toBe(true);
			jest.advanceTimersByTime(1);
			expect(used.hidden).toBe(true);
			expect(shown(value)).toBe(true);
			expect(value.textContent).toBe("222222");
		} finally {
			jest.useRealTimers();
		}
		byText(dialog, "Close").click();
	});

	test("only a used code waits: expired, locked or no reason (an older relay) show the next code at once, whatever the clock", async () => {
		relay.grants = [];
		const { dialog } = await open();
		const value = dialog.querySelector(".tab-mcp-code-value") as HTMLElement;
		const used = dialog.querySelector(".tab-mcp-code-used") as HTMLElement;
		const now = Date.now();
		// The relay's expiry, read with the page's clock far behind and far ahead.
		const relayExpiry = new Date(now + 120_000).toISOString();
		for (const skew of [-600_000, 0, 600_000]) {
			const clock = jest.spyOn(Date, "now").mockReturnValue(now + skew);
			try {
				let n = 100_000 + (skew + 600_000) / 1000;
				for (const reason of [undefined, "start", "expired", "locked"]) {
					const next = String(n++);
					await sendCode(next, relayExpiry, reason);
					expect({ reason, skew, shown: value.textContent }).toEqual({
						reason,
						skew,
						shown: next,
					});
					expect(used.hidden).toBe(true);
					expect(shown(value)).toBe(true);
				}
			} finally {
				clock.mockRestore();
			}
		}
		// A lockout during the wait ends it: /authorize says to enter the new code.
		await sendCode("200001", inTwoMinutes(), "used");
		expect(shown(used)).toBe(true);
		await sendCode("200002", inTwoMinutes(), "locked");
		expect(used.hidden).toBe(true);
		expect(shown(value)).toBe(true);
		expect(value.textContent).toBe("200002");
		byText(dialog, "Close").click();
	});

	test("one app paired twice is named once, in the confirmation and the New address question", async () => {
		relay.grants = [GRANT, { ...GRANT, grantId: "g_2" }];
		const { dialog } = await open();
		expect(dialog.querySelector(".tab-mcp-success")?.textContent).toBe(
			"Claude (claude.ai) is connectedYou can close this now and ask it to use the tools of this page.",
		);
		byText(dialog, "Connect another app").click();
		byText(dialog, "New address").click();
		expect(
			dialog.querySelector(".tab-mcp-new-address-question p")?.textContent,
		).toBe(
			"A new address disconnects Claude (claude.ai). To use this page again, add the new address to it.",
		);
		// Both grants are listed, each with its own Disconnect, named for its app (CU 14).
		expect(dialog.querySelectorAll(".tab-mcp-apps li")).toHaveLength(2);
		expect(
			[...dialog.querySelectorAll(".tab-mcp-disconnect")].map((b) =>
				b.getAttribute("aria-label"),
			),
		).toEqual([
			"Disconnect Claude (claude.ai)",
			expect.stringMatching(/^Disconnect /),
		]);
		byText(dialog, "Cancel").click();
		byText(dialog, "Done").click();
	});

	test("opened while an app is connected: the connected state, focus on Done, the code behind the disclosure", async () => {
		const { dialog } = await open();
		await sendCode("123456", inTwoMinutes());
		expect(shown(dialog.querySelector(".tab-mcp-success"))).toBe(true);
		expect(shown(dialog.querySelector(".tab-mcp-code-value"))).toBe(false);
		expect(shown(dialog.querySelector(".tab-mcp-address-input"))).toBe(false);
		expect(shown(dialog.querySelector(".tab-mcp-help"))).toBe(false);
		expect(shown(dialog.querySelector(".tab-mcp-close-note"))).toBe(false);
		// The connected apps, with Disconnect, stay in view.
		expect(shown(dialog.querySelector(".tab-mcp-apps"))).toBe(true);
		expect(doc.activeElement).toBe(byText(dialog, "Done"));
		const added = nextEvent(mcp, "grantschange");
		relay.send({
			type: "grant.added",
			grant: {
				...GRANT,
				grantId: "g_2",
				client: {
					id: "https://chatgpt.com/c.json",
					name: "ChatGPT",
					host: "chatgpt.com",
				},
			},
		});
		await added;
		// Named: the one that connected here.
		expect(dialog.querySelector(".tab-mcp-success-title")?.textContent).toBe(
			"ChatGPT (chatgpt.com) is connected",
		);
		relay.send({ type: "grant.removed", grantId: "g_2", reason: "revoked" });
		await nextEvent(mcp, "grantschange");
		// The one that connected here is gone: the confirmation names who is left.
		expect(dialog.querySelector(".tab-mcp-success-title")?.textContent).toBe(
			"Claude (claude.ai) is connected",
		);
		byText(dialog, "Done").click();
	});

	test("the apps list keeps its items: a focused Disconnect keeps the focus, a removed one hands it on", async () => {
		const { dialog } = await open();
		const first = dialog.querySelector(".tab-mcp-apps li") as HTMLElement;
		const disconnect = first.querySelector("button") as HTMLButtonElement;
		disconnect.focus();
		const added = nextEvent(mcp, "grantschange");
		relay.send({
			type: "grant.added",
			grant: {
				...GRANT,
				grantId: "g_2",
				client: {
					id: "https://chatgpt.com/c.json",
					name: "ChatGPT",
					host: "chatgpt.com",
				},
			},
		});
		await added;
		const items = [...dialog.querySelectorAll(".tab-mcp-apps li")];
		expect(items).toHaveLength(2);
		expect(items[0]).toBe(first);
		expect(doc.activeElement).toBe(disconnect);
		expect(dialog.querySelector(".tab-mcp-success-title")?.textContent).toBe(
			"ChatGPT (chatgpt.com) is connected",
		);

		const removed = nextEvent(mcp, "grantschange");
		relay.send({ type: "grant.removed", grantId: "g_1", reason: "revoked" });
		await removed;
		expect(first.isConnected).toBe(false);
		expect(doc.activeElement).toBe(byText(dialog, "Done"));
		byText(dialog, "Done").click();
	});

	test("a failed connection says why in the user's words, with Connect again (CU 4)", async () => {
		const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
		const offline = newTab("http://127.0.0.1:9");
		const connecting = offline.connect();
		const closed = showConnectDialog(offline, connecting, doc);
		await connecting.catch(() => {});
		await Bun.sleep(0);
		const dialog = doc.querySelector("dialog") as HTMLDialogElement;
		expect(dialog.querySelector(".tab-mcp-status")?.textContent).toBe(
			"Could not connect. Check your internet connection.",
		);
		// The relay's own wording goes to the console, not to the user.
		expect(String(warn.mock.calls[0]?.[1])).toContain("relay");
		warn.mockRestore();
		const retry = byText(dialog, "Connect again");
		expect(shown(retry)).toBe(true);
		expect(retry.classList.contains("tab-mcp-primary")).toBe(true);
		byText(dialog, "Close").click();
		await closed;
	});

	test("refused for want of a user action: Connect again connects from its click (CU 4)", async () => {
		relay.grants = [];
		const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
		const refused = Promise.reject(
			new DOMException(
				"connect() must be called from a user action, such as a click",
				"NotAllowedError",
			),
		);
		refused.catch(() => {});
		const closed = showConnectDialog(mcp, refused, doc);
		await Bun.sleep(0);
		warn.mockRestore();
		const dialog = doc.querySelector("dialog") as HTMLDialogElement;
		const status = dialog.querySelector(".tab-mcp-status") as HTMLElement;
		// No developer message in the dialog.
		expect(status.textContent).toBe("Not connected.");
		const retry = byText(dialog, "Connect again");
		expect(shown(retry)).toBe(true);
		const connected = nextEvent(mcp, "connected");
		retry.click();
		expect(status.textContent).toBe("Connecting…");
		expect(shown(retry)).toBe(false);
		await connected;
		expect(shown(dialog.querySelector(".tab-mcp-address-input"))).toBe(true);
		expect(status.textContent).toBe("saturnus is ready for your AI app.");
		byText(dialog, "Close").click();
		await closed;
	});

	test("while it reconnects by itself, the dialog says so; Connect again tries at once (CU 4)", async () => {
		mcp = newTab(relay.url, {
			appName: "saturnus",
			reconnect: { delaysMs: [60_000] },
		});
		const { dialog } = await open();
		const status = dialog.querySelector(".tab-mcp-status") as HTMLElement;
		const reconnecting = nextEvent(mcp, "reconnecting");
		relay.close(4004); // the relay shuts down
		await reconnecting;
		expect(status.textContent).toBe("Connection lost. Reconnecting…");
		expect(shown(status)).toBe(true);
		const retry = byText(dialog, "Connect again");
		expect(shown(retry)).toBe(true);
		const connected = nextEvent(mcp, "connected");
		retry.click();
		await connected;
		expect(mcp.reconnecting).toBeUndefined();
		expect(shown(retry)).toBe(false);
		byText(dialog, "Done").click();
	});

	test("reconnecting that stops says why: a refusal, or the page's disconnect() (review of PR 121)", async () => {
		const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
		mcp = newTab(relay.url, {
			appName: "saturnus",
			reconnect: { delaysMs: [60_000] },
		});
		const { dialog } = await open();
		await relay.next("hello"); // the first session's
		const status = dialog.querySelector(".tab-mcp-status") as HTMLElement;
		let reconnecting = nextEvent(mcp, "reconnecting");
		relay.close(4004);
		await reconnecting;
		// The next attempt is refused: reconnecting stops, and the dialog says why.
		relay.answerHello = false;
		let hello = relay.next("hello");
		const stopped = nextEvent(mcp, "reconnecting");
		// The page's own connect() makes the attempt, not the dialog's button.
		mcp.connect().catch(() => {});
		await hello;
		relay.send({ type: "error", code: "rate_limited", message: "slow down" });
		expect((await stopped).detail).toBeNull();
		await Bun.sleep(0);
		expect(status.textContent).toBe(
			"Too many attempts. Wait a minute, then connect again.",
		);
		// Connect again, refused too: focus comes back to it from Close, so a
		// second Enter tries again instead of closing the dialog.
		const retry = byText(dialog, "Connect again");
		expect(shown(retry)).toBe(true);
		retry.focus();
		hello = relay.next("hello");
		retry.click();
		expect(doc.activeElement).toBe(byText(dialog, "Close"));
		await hello;
		relay.send({ type: "error", code: "policy", message: "no" });
		await nextEvent(mcp, "statechange");
		await Bun.sleep(0);
		expect(status.textContent).toBe("The connection was refused.");
		expect(doc.activeElement).toBe(retry);
		// Reconnecting again, then the page turns it off.
		relay.answerHello = true;
		const connected = nextEvent(mcp, "connected");
		retry.click();
		await connected;
		reconnecting = nextEvent(mcp, "reconnecting");
		relay.close(4004);
		await reconnecting;
		mcp.disconnect();
		expect(status.textContent).toBe("Disconnected.");
		warn.mockRestore();
		byText(dialog, "Close").click();
	});

	test("with identity binding: no address until the relay knows who is signed in (CU 7)", async () => {
		relay.pairing = "oidc";
		relay.grants = [];
		let assertion: string | null = null;
		mcp = newTab(relay.url, { identityAssertion: () => assertion });
		const { dialog } = await open();
		const status = dialog.querySelector(".tab-mcp-status") as HTMLElement;
		const signIn = dialog.querySelector(".tab-mcp-sign-in") as HTMLElement;
		const address = dialog.querySelector(".tab-mcp-address") as HTMLElement;
		// Nobody is signed in to the page.
		await Bun.sleep(0);
		expect(mcp.identity).toBe("none");
		expect(status.textContent).toBe("Sign in to this page first.");
		expect(address.hidden).toBe(true);
		expect(shown(signIn)).toBe(false);
		// The page signs the user in: checking, then refused with the relay's reason.
		assertion = "a.b.c";
		const refreshed = mcp.refreshIdentity();
		expect(status.textContent).toBe("Checking your sign-in…");
		const first = await relay.next("identity");
		relay.send({
			type: "error",
			code: "identity_refused",
			message: "the token has expired",
			round: first["round"],
		});
		expect(await refreshed).toBe(false);
		expect(status.textContent).toBe(
			"Your sign-in on this page was not accepted (the token has expired).",
		);
		expect(address.hidden).toBe(true);
		// Accepted: the address and the sign-in line.
		const again = mcp.refreshIdentity();
		const second = await relay.next("identity");
		relay.send({ type: "identity.bound", round: second["round"] });
		expect(await again).toBe(true);
		expect(address.hidden).toBe(false);
		expect(shown(signIn)).toBe(true);
		expect(status.textContent).toBe("This page is ready for your AI app.");
		byText(dialog, "Close").click();
	});

	test("with identity binding, New address says the address is new once it shows, at its Copy (review of PR 121)", async () => {
		relay.pairing = "oidc";
		relay.grants = [];
		mcp = newTab(relay.url, { identityAssertion: () => "a.b.c" });
		const { dialog } = await open();
		const bind = async () => {
			const m = await relay.next("identity");
			relay.send({ type: "identity.bound", round: m["round"] });
			await relay.settled();
			expect(mcp.identity).toBe("bound");
		};
		await bind();
		const status = dialog.querySelector(".tab-mcp-status") as HTMLElement;
		const address = dialog.querySelector(".tab-mcp-address") as HTMLElement;
		expect(address.hidden).toBe(false);
		byText(dialog, "New address").click();
		// The new session's identity is not bound yet: no address, no claim about it.
		await nextEvent(mcp, "connected");
		await Bun.sleep(0);
		expect(address.hidden).toBe(true);
		await bind();
		expect(address.hidden).toBe(false);
		expect(status.textContent).toBe(
			"This is a new address. Add it to your AI app again.",
		);
		expect(doc.activeElement).toBe(
			dialog.querySelector(".tab-mcp-address-copy"),
		);
		byText(dialog, "Close").click();
	});

	test("New address asks first while apps are connected; Cancel keeps the address", async () => {
		const { dialog, session } = await open();
		byText(dialog, "Connect another app").click();
		const fresh = byText(dialog, "New address");
		expect(fresh.disabled).toBe(false);
		const question = dialog.querySelector(
			".tab-mcp-new-address-question",
		) as HTMLElement;
		expect(question.hidden).toBe(true);

		fresh.click();
		expect(question.hidden).toBe(false);
		expect(question.getAttribute("role")).toBe("group");
		expect(question.getAttribute("aria-labelledby")).toBe(
			question.querySelector("p")?.id ?? "none",
		);
		expect(question.querySelector("p")?.textContent).toBe(
			"A new address disconnects Claude (claude.ai). To use this page again, add the new address to it.",
		);
		expect(doc.activeElement?.textContent).toBe("Cancel");

		byText(question, "Cancel").click();
		expect(question.hidden).toBe(true);
		expect(doc.activeElement).toBe(fresh);
		expect(mcp.state).toBe("connected");
		expect(mcp.address).toBe(session.address);
		expect(relay.received.some((m) => m.type === "grants.revokeAll")).toBe(
			false,
		);
		byText(dialog, "Done").click();
	});

	test("the New address question follows the connected apps while it is open", async () => {
		const { dialog } = await open();
		byText(dialog, "Connect another app").click();
		const fresh = byText(dialog, "New address");
		const question = dialog.querySelector(
			".tab-mcp-new-address-question",
		) as HTMLElement;
		fresh.click();
		expect(question.hidden).toBe(false);

		const added = nextEvent(mcp, "grantschange");
		relay.send({
			type: "grant.added",
			grant: {
				grantId: "g_2",
				client: {
					id: "https://chatgpt.com/c.json",
					name: "ChatGPT",
					host: "chatgpt.com",
				},
				createdAt: "2026-10-20T10:00:00.000Z",
			},
		});
		await added;
		expect(question.querySelector("p")?.textContent).toBe(
			"A new address disconnects Claude (claude.ai) and ChatGPT (chatgpt.com). To use this page again, add the new address to them.",
		);
		// The setup stays open while the question is: the user is answering it.
		expect(shown(question)).toBe(true);
		expect(doc.activeElement?.textContent).toBe("Cancel");

		for (const grantId of ["g_1", "g_2"]) {
			const removed = nextEvent(mcp, "grantschange");
			relay.send({ type: "grant.removed", grantId, reason: "revoked" });
			await removed;
		}
		expect(question.hidden).toBe(true);
		expect(doc.activeElement).toBe(fresh);
		byText(dialog, "Close").click();
	});

	test("New address, confirmed, revokes the apps, makes a new secret and connects again", async () => {
		relay.grants = [
			GRANT,
			{
				...GRANT,
				grantId: "g_2",
				client: {
					id: "https://chatgpt.com/c.json",
					name: "ChatGPT",
					host: "chatgpt.com",
				},
			},
		];
		const { dialog } = await open();
		const hello = await relay.next("hello");
		expect(dialog.querySelector(".tab-mcp-success")?.textContent).toBe(
			"Claude (claude.ai) and ChatGPT (chatgpt.com) are connectedYou can close this now and ask them to use the tools of this page.",
		);
		byText(dialog, "Connect another app").click();
		byText(dialog, "New address").click();
		expect(
			dialog.querySelector(".tab-mcp-new-address-question p")?.textContent,
		).toBe(
			"A new address disconnects Claude (claude.ai) and ChatGPT (chatgpt.com). To use this page again, add the new address to them.",
		);

		relay.grants = []; // what the relay has for the new address
		const connected = nextEvent(mcp, "connected");
		byText(dialog, "Disconnect and get new address").click();
		expect(dialog.querySelector(".tab-mcp-status")?.textContent).toBe(
			"Getting a new address…",
		);
		// The relay revokes them as it hands the old address back (DEC-136).
		expect(await relay.next("hello")).toMatchObject({
			secret: hello["secret"],
			revokeAll: true,
		});
		const again = await relay.next("hello");
		expect(again["secret"]).not.toBe(hello["secret"]);
		await connected;
		await Bun.sleep(0);
		expect(dialog.querySelector(".tab-mcp-status")?.textContent).toBe(
			"This is a new address. Add it to your AI app again.",
		);
		expect(
			(dialog.querySelector(".tab-mcp-new-address-question") as HTMLElement)
				.hidden,
		).toBe(true);
		expect(
			(dialog.querySelector(".tab-mcp-address") as HTMLElement).hidden,
		).toBe(false);
		expect((dialog.querySelector(".tab-mcp-apps") as HTMLElement).hidden).toBe(
			true,
		);
		expect(mcp.pairing).toBe(true);
		byText(dialog, "Close").click();
	});

	test("New address without connected apps does not ask", async () => {
		relay.grants = [];
		const { dialog } = await open();
		await relay.next("hello");
		byText(dialog, "New address").click();
		expect(
			(dialog.querySelector(".tab-mcp-new-address-question") as HTMLElement)
				.hidden,
		).toBe(true);
		expect(await relay.next("hello")).toMatchObject({ revokeAll: true });
		await relay.next("hello");
		byText(dialog, "Close").click();
	});

	test("the dialog follows a disconnect, says why, and offers Connect again (CU 4)", async () => {
		const { dialog } = await open();
		const gone = nextEvent(mcp, "disconnected");
		relay.close(4002); // idle
		await gone;
		expect(dialog.querySelector(".tab-mcp-status")?.textContent).toBe(
			"The session ended.",
		);
		const retry = byText(dialog, "Connect again");
		expect(shown(retry)).toBe(true);
		expect(doc.activeElement).toBe(retry);
		const disconnect = byText(dialog, "Disconnect");
		expect(disconnect.disabled).toBe(true);
		expect(dialog.querySelector(".tab-mcp-apps")?.textContent).toContain(
			"connect this page again",
		);
		expect(
			(dialog.querySelector(".tab-mcp-address") as HTMLElement).hidden,
		).toBe(true);
		byText(dialog, "Close").click();
	});

	test("the look: one primary step, Disconnect marked, Copy that keeps its width (dialog design)", async () => {
		const { dialog, session } = await open();
		await sendCode("123456");
		const has = (selector: string, kind: string) =>
			(dialog.querySelector(selector) as HTMLElement).classList.contains(kind);
		const primary = () =>
			[...dialog.querySelectorAll(".tab-mcp-primary")].filter(shown);
		// An app is connected: Done is the next step, also with the setup open.
		expect(primary()).toEqual([byText(dialog, "Done")]);
		byText(dialog, "Connect another app").click();
		expect(primary()).toEqual([byText(dialog, "Done")]);
		expect(has(".tab-mcp-address-copy", "tab-mcp-primary")).toBe(false);
		for (const plain of [
			".tab-mcp-code-copy",
			".tab-mcp-new-address",
			".tab-mcp-close",
			".tab-mcp-setup-toggle",
		])
			expect(has(plain, "tab-mcp-primary")).toBe(false);
		// Both Copy buttons take the same room as "Copy" and "Copied".
		expect(dialog.querySelectorAll("button.tab-mcp-copy").length).toBe(4);
		// What disconnects apps is marked.
		expect(has(".tab-mcp-disconnect", "tab-mcp-danger")).toBe(true);
		expect(has(".tab-mcp-new-address-confirm", "tab-mcp-danger")).toBe(true);
		const app = dialog.querySelector(".tab-mcp-apps li .tab-mcp-app");
		expect(app?.textContent).toBe("Claude (claude.ai) connected ");
		// Each command is a block with its own Copy; the server name defaults to "tools".
		expect(
			[...dialog.querySelectorAll(".tab-mcp-help .tab-mcp-command pre")].map(
				(p) => p.textContent,
			),
		).toEqual([
			`claude mcp add --transport http tools ${session.address}`,
			`codex features enable mcp_2026_07_28\ncodex mcp add tools --url ${session.address}\ncodex mcp login tools`,
		]);
		expect(
			[...dialog.querySelectorAll(".tab-mcp-help strong")].map(
				(s) => s.textContent,
			),
		).toEqual([
			"Claude (claude.ai and the desktop app):",
			"ChatGPT:",
			"Claude Code:",
			"Codex:",
		]);
		const notes = [...dialog.querySelectorAll(".tab-mcp-command-note")];
		expect(notes.map((n) => n.textContent)).toEqual([
			"The Mac app first needs a feature of Codex: run codex features enable mcp_2026_07_28 in a terminal.",
			"Then type /mcp in Claude Code and choose Authenticate.",
			"The last line opens the sign-in that asks for the code. Start a new chat in Codex after it connects. The first line turns on a feature for all of Codex's MCP servers; codex features disable mcp_2026_07_28 turns it off.",
		]);
		expect(notes[2]?.querySelector("code")?.textContent).toBe(
			"codex features disable mcp_2026_07_28",
		);
		// No inline styles but those that keep the announcements out of sight and the code selectable as a whole.
		const styled = [...dialog.querySelectorAll("[style]")] as HTMLElement[];
		expect(styled.map((e) => e.className)).toEqual([
			"tab-mcp-code-value",
			"tab-mcp-announce",
		]);
		// The check mark is drawn inline, hidden from assistive technology.
		const icon = dialog.querySelector(".tab-mcp-success svg") as Element;
		expect(icon.getAttribute("class")).toBe("tab-mcp-success-icon");
		expect(icon.getAttribute("aria-hidden")).toBe("true");
		expect(icon.querySelector("path")?.getAttribute("stroke")).toBe(
			"currentColor",
		);

		// None connected: copying the address is the next step.
		relay.send({ type: "grant.removed", grantId: "g_1", reason: "revoked" });
		await nextEvent(mcp, "grantschange");
		expect(primary()).toEqual([
			dialog.querySelector(".tab-mcp-address-copy") as Element,
		]);
		byText(dialog, "Close").click();
	});
});

describe("the dialogs' stylesheet (dialog design)", () => {
	test("one constructed stylesheet for every dialog, next to the page's own", async () => {
		const Sheet = window.CSSStyleSheet as unknown as typeof CSSStyleSheet;
		const page = new Sheet();
		doc.adoptedStyleSheets = [page];
		const first = confirmDialog(question(), doc);
		expect(doc.adoptedStyleSheets.length).toBe(2);
		expect(doc.adoptedStyleSheets[0]).toBe(page);
		const ours = doc.adoptedStyleSheets[1];
		(doc.querySelector("dialog") as HTMLDialogElement).close();
		await first;
		// Again: the same sheet, not a second one.
		const second = confirmDialog(question(), doc);
		expect(doc.adoptedStyleSheets).toEqual([page, ours as CSSStyleSheet]);
		(doc.querySelector("dialog") as HTMLDialogElement).close();
		await second;
		// The page replaced the list: it is added again.
		doc.adoptedStyleSheets = [page];
		const third = confirmDialog(question(), doc);
		expect(doc.adoptedStyleSheets).toEqual([page, ours as CSSStyleSheet]);
		(doc.querySelector("dialog") as HTMLDialogElement).close();
		await third;
	});

	test("every selector weighs one class; states and fills one class and two elements (review of PR 34)", () => {
		// The selectors of every rule, without the at-rules and keyframes.
		const css = DIALOG_CSS.replace(
			/@keyframes[^{]*\{(?:[^{}]*\{[^}]*\})*[^}]*\}/g,
			"",
		)
			.replace(/@media[^{]*\{/g, "")
			.replace(/\{[^}]*\}/g, "\n");
		const selectors = css
			.split("\n")
			.map((s) => s.trim())
			.filter((s) => s !== "" && s !== "}");
		expect(selectors.length).toBeGreaterThan(40);
		/** [classes, elements]: :where() weighs nothing; nested parentheses one level deep. */
		const weight = (part: string): [number, number] => {
			const rest = part.replace(/:where\((?:[^()]|\([^()]*\))*\)/g, "");
			const classes =
				rest.match(/\.[\w-]+|\[[^\]]*\]|(?<!:):(?!:)[\w-]+/g)?.length ?? 0;
			const bare = rest.replace(/\.[\w-]+|\[[^\]]*\]|::?[\w-]+/g, "");
			const elements =
				(bare.match(/(?:^|[\s>+~])[a-z][\w-]*/g)?.length ?? 0) +
				(rest.match(/::[\w-]+/g)?.length ?? 0);
			return [classes, elements];
		};
		for (const selector of selectors) {
			expect(selector).not.toContain("#");
			// Outside :where(), nothing that adds weight of its own.
			expect(
				selector.replace(/:where\((?:[^()]|\([^()]*\))*\)/g, ""),
			).not.toMatch(/:is\(|:not\(|:has\(/);
			for (const part of selector.split(/,(?![^(]*\))/)) {
				const [classes, elements] = weight(part);
				const state =
					/:hover|:focus|:disabled|\.tab-mcp-primary|\.tab-mcp-danger/.test(
						part,
					);
				expect({ part, classes, elements }).toEqual({
					part,
					classes: 1,
					// One element at most (a pseudo-element); two for states and fills.
					elements: state ? 2 : expect.any(Number),
				});
				if (!state) expect(elements).toBeLessThanOrEqual(1);
			}
		}
		// Above `button:hover` (0,1,1), below two classes (0,2,0).
		expect(
			weight("html dialog.tab-mcp-dialog :where(button:disabled)"),
		).toEqual([1, 2]);
	});

	test("game feedback 1: the dialog centres itself, also under a CSS reset that sets margin: 0", () => {
		expect(DIALOG_CSS).toMatch(/\.tab-mcp-dialog \{[^}]*\bmargin: auto;/);
	});

	test("hidden stays hidden, a closed dialog stays closed, motion only when the user allows it", () => {
		expect(DIALOG_CSS).toContain(
			".tab-mcp-dialog :where([hidden]) { display: none !important; }",
		);
		// Display is set only while open, so a closed <dialog> stays hidden.
		expect(DIALOG_CSS).not.toMatch(/\.tab-mcp-dialog\s*\{[^}]*display:/);
		expect(DIALOG_CSS).toContain(
			".tab-mcp-dialog:where([open]) { display: flex;",
		);
		// Every animation (the dialog's, the check mark's) is in the one block
		// for users who allow motion.
		const animations = [...DIALOG_CSS.matchAll(/animation:/g)].length;
		expect(animations).toBe(2);
		const motion =
			/@media \(prefers-reduced-motion: no-preference\) \{((?:[^{}]*\{[^}]*\})*)[^}]*\}/.exec(
				DIALOG_CSS,
			)?.[1] ?? "";
		expect([...motion.matchAll(/animation:/g)].length).toBe(animations);
		expect(motion).toContain(".tab-mcp-success-icon { animation:");
		expect(DIALOG_CSS).toContain(":focus-visible");
	});

	test("every --tab-mcp-* custom property the dialogs read is in the README", async () => {
		const root = new URL("..", import.meta.url).pathname;
		const source = await Bun.file(`${root}src/ui.ts`).text();
		const readme = await Bun.file(`${root}README.md`).text();
		const used = new Set(
			[...source.matchAll(/var\((--tab-mcp-[a-z-]+)/g)].map((m) => m[1]),
		);
		expect(used.size).toBeGreaterThan(10);
		const missing = [...used].filter((name) => !readme.includes(`\`${name}\``));
		expect(missing).toEqual([]);
	});
});

describe("replaced: the page's address taken over (iteration 10, DEC-095)", () => {
	let relay: StubRelay;
	let mcp: TabMcp;
	/** The page's channel: its storage key plus `#tabs`. */
	let channelName: string;

	beforeEach(() => {
		relay = new StubRelay();
		mcp = newTab(relay.url);
		channelName = `tab-mcp:secret:${relay.url}:test-page#tabs`;
	});
	afterEach(async () => {
		mcp.disconnect();
		await relay.stop();
	});

	/** The element once it is in the document (polling; the dialogs open asynchronously). */
	function waitFor(selector: string): Promise<HTMLElement> {
		return new Promise((resolve) => {
			const poll = () => {
				const found = doc.querySelector(selector);
				if (found !== null) resolve(found as HTMLElement);
				else setTimeout(poll, 1);
			};
			poll();
		});
	}

	async function openThenReplace(sibling: boolean): Promise<HTMLDialogElement> {
		const connecting = mcp.connect();
		const closed = showConnectDialog(mcp, connecting, doc);
		await connecting;
		await relay.next("pairing.start");
		if (sibling) {
			// A sibling tab says its session started (`claimed`), on this address.
			const address = new URL(relay.urls.at(-1) ?? "").searchParams.get("a");
			const announce = new BroadcastChannel(channelName);
			const listener = new BroadcastChannel(channelName);
			const delivered = new Promise((r) => {
				listener.onmessage = r;
			});
			announce.postMessage({ type: "claimed", address });
			await delivered;
			announce.close();
			listener.close();
		}
		const gone = nextEvent(mcp, "disconnected");
		relay.send({ type: "bye", reason: "replaced" });
		relay.close(4005, "replaced");
		await gone;
		await closed; // the connect dialog gives way to the notice
		expect(doc.querySelector("dialog.tab-mcp-connect")).toBeNull();
		return (await waitFor("dialog.tab-mcp-replaced")) as HTMLDialogElement;
	}

	test("nobody announced it: a warning that another tab or program took over, with New address", async () => {
		const replaced = openThenReplace(false);
		const secret = (await relay.next("hello"))["secret"];
		const notice = await replaced;
		expect(notice.open).toBe(true);
		expect(notice.querySelector("h2")?.textContent).toBe(
			"Another tab or program took over this page",
		);
		expect(notice.textContent).toContain("someone may have copied its address");
		expect(buttons(notice).map((b) => b.textContent)).toEqual([
			"Close",
			"New address",
		]);
		expect(doc.activeElement?.textContent).toBe("New address");
		byText(notice, "New address").click();
		// Back on the old address first, so the relay disconnects its apps.
		expect(await relay.next("hello")).toMatchObject({
			secret,
			revokeAll: true,
		});
		expect(await relay.next("bye")).toEqual({ type: "bye", reason: "user" });
		expect((await relay.next("hello"))["secret"]).not.toBe(secret);
		// Then the connect dialog, to add the new address to the AI apps.
		const connect = await waitFor("dialog.tab-mcp-connect");
		await relay.next("pairing.start");
		expect(doc.querySelector("dialog.tab-mcp-replaced")).toBeNull();
		(connect as HTMLDialogElement).close();
	});

	test("taken over again during New address: the notice says so and New address works again (review of PR 39)", async () => {
		const notice = await openThenReplace(false);
		relay.answerHello = false;
		byText(notice, "New address").click();
		expect(
			await relay.next("hello", (m) => m["revokeAll"] === true),
		).toBeDefined();
		relay.send({ type: "bye", reason: "replaced" });
		relay.close(4005, "replaced");
		const status = notice.querySelector(".tab-mcp-status") as HTMLElement;
		await new Promise<void>((resolve) => {
			const poll = () =>
				status.textContent?.startsWith("It was taken over again")
					? resolve()
					: setTimeout(poll, 1);
			poll();
		});
		expect(status.textContent).toBe(
			"It was taken over again before its AI apps were disconnected. Try again.",
		);
		expect(byText(notice, "New address").disabled).toBe(false);
		expect(notice.open).toBe(true);
	});

	test("a sibling tab announced it: 'Opened in another tab', nothing to do", async () => {
		const notice = await openThenReplace(true);
		expect(notice.querySelector("h2")?.textContent).toBe(
			"Opened in another tab",
		);
		expect(buttons(notice).map((b) => b.textContent)).toEqual(["Close"]);
		byText(notice, "Close").click();
		expect(doc.querySelector("dialog.tab-mcp-replaced")).toBeNull();
		expect(mcp.state).toBe("disconnected");
	});

	test("the channel carries the address id, never the secret (CC 5)", async () => {
		const seen: unknown[] = [];
		const spy = new BroadcastChannel(channelName);
		spy.onmessage = (e) => seen.push(e.data);
		try {
			await mcp.connect();
			const secret = (await relay.next("hello"))["secret"] as string;
			await relay.settled();
			expect(seen).toEqual([
				{
					type: "claimed",
					address: new URL(relay.urls.at(-1) ?? "").searchParams.get("a"),
				},
			]);
			expect(JSON.stringify(seen)).not.toContain(secret);
		} finally {
			spy.close();
		}
	});
});

describe("confirmDialog: one at a time, arguments seen, no stray keys (iteration 31)", () => {
	beforeEach(() => {
		Object.defineProperty(doc, "hasFocus", {
			configurable: true,
			value: () => true,
		});
		jest.useFakeTimers();
	});
	afterEach(() => {
		jest.useRealTimers();
	});
	const confirms = () =>
		[...doc.querySelectorAll("dialog.tab-mcp-confirm")] as HTMLDialogElement[];
	const named = (tool: string, signal = new AbortController().signal) => ({
		...question(signal),
		tool: { name: tool, description: `Runs ${tool}` },
	});
	const key = (target: EventTarget, k: string, type = "keydown") => {
		const event = new window.KeyboardEvent(type, {
			key: k,
			bubbles: true,
			cancelable: true,
		}) as unknown as KeyboardEvent;
		target.dispatchEvent(event);
		return event.defaultPrevented;
	};

	test("two calls: one dialog at a time, and the next starts its own delay (CU 1)", async () => {
		const first = confirmDialog(named("one"), doc, { allowDelayMs: 600 });
		const second = confirmDialog(named("two"), doc, { allowDelayMs: 600 });
		expect(confirms()).toHaveLength(1);
		const waiting = doc.querySelector(".tab-mcp-waiting") as HTMLElement;
		expect(shown(waiting)).toBe(true);
		expect(waiting.textContent).toBe("1 more call is waiting after this one.");
		jest.advanceTimersByTime(600);
		byText(doc, "Allow").click();
		expect(await first).toBe("allow");
		// The second shows now, with Allow disabled again for the full delay.
		expect(confirms()).toHaveLength(1);
		expect(confirms()[0]?.querySelector("h2")?.textContent).toBe("Allow two?");
		expect(shown(doc.querySelector(".tab-mcp-waiting"))).toBe(false);
		const allow = byText(doc, "Allow");
		expect(allow.disabled).toBe(true);
		allow.click(); // the second click of a double click
		expect(confirms()[0]?.open).toBe(true);
		jest.advanceTimersByTime(599);
		expect(allow.disabled).toBe(true);
		jest.advanceTimersByTime(1);
		expect(allow.disabled).toBe(false);
		byText(doc, "Don't allow").click();
		expect(await second).toBe("deny");
		expect(confirms()).toHaveLength(0);
	});

	test("a call cancelled while it waits is never shown; the count follows (CU 1)", async () => {
		const first = confirmDialog(named("one"), doc);
		const cancelled = new AbortController();
		const second = confirmDialog(named("two", cancelled.signal), doc);
		const third = confirmDialog(named("three"), doc);
		const waiting = doc.querySelector(".tab-mcp-waiting") as HTMLElement;
		expect(waiting.textContent).toBe(
			"2 more calls are waiting after this one.",
		);
		cancelled.abort();
		expect(await second).toBe("deny");
		expect(waiting.textContent).toBe("1 more call is waiting after this one.");
		byText(doc, "Don't allow").click();
		expect(await first).toBe("deny");
		expect(confirms()[0]?.querySelector("h2")?.textContent).toBe(
			"Allow three?",
		);
		byText(doc, "Don't allow").click();
		expect(await third).toBe("deny");
		// The queue is free again: the next one shows at once.
		const fourth = confirmDialog(named("four"), doc);
		expect(confirms()).toHaveLength(1);
		byText(doc, "Don't allow").click();
		expect(await fourth).toBe("deny");
	});

	test("a dialog that cannot be shown does not block the queue (review of PR 118)", async () => {
		const proto = window.HTMLDialogElement.prototype as unknown as {
			showModal: () => void;
		};
		const original = proto.showModal;
		proto.showModal = () => {
			proto.showModal = original;
			throw new window.DOMException("not active", "InvalidStateError");
		};
		const failed = confirmDialog(named("one"), doc);
		await expect(failed).rejects.toThrow("not active");
		expect(doc.querySelectorAll("dialog")).toHaveLength(0);
		const next = confirmDialog(named("two"), doc);
		expect(confirms()).toHaveLength(1);
		expect(confirms()[0]?.open).toBe(true);
		byText(doc, "Don't allow").click();
		expect(await next).toBe("deny");
	});

	test("a waiting call allowed always meanwhile is not shown (review of PR 118)", async () => {
		let always = false;
		const first = confirmDialog(named("one"), doc, { allowDelayMs: 600 });
		const second = confirmDialog(named("one"), doc, {
			allowedNow: () => always,
		});
		const third = confirmDialog(named("two"), doc, {
			allowedNow: () => false,
		});
		jest.advanceTimersByTime(600);
		always = true; // what "Always allow" on the first one does
		byText(doc, "Allow").click();
		expect(await first).toBe("allow");
		expect(await second).toBe("allow");
		// The next waiting call is shown, and asked.
		expect(confirms()).toHaveLength(1);
		expect(confirms()[0]?.querySelector("h2")?.textContent).toBe("Allow two?");
		byText(doc, "Don't allow").click();
		expect(await third).toBe("deny");
	});

	test("another dialog closing over the confirmation starts the delay again (CU 1)", async () => {
		const answer = confirmDialog(question(), doc, { allowDelayMs: 600 });
		const allow = byText(doc, "Allow");
		jest.advanceTimersByTime(600);
		expect(allow.disabled).toBe(false);
		const other = doc.createElement("dialog");
		doc.body.append(other);
		other.showModal();
		other.close();
		expect(allow.disabled).toBe(true);
		jest.advanceTimersByTime(599);
		expect(allow.disabled).toBe(true);
		jest.advanceTimersByTime(1);
		expect(allow.disabled).toBe(false);
		allow.click();
		expect(await answer).toBe("allow");
	});

	test("Allow waits until the arguments were scrolled to their end (CU 2)", async () => {
		let scrollTop = 0;
		const proto = window.HTMLElement.prototype as unknown as object;
		const box = (self: unknown) =>
			(self as HTMLElement).classList?.contains("tab-mcp-arguments");
		Object.defineProperty(proto, "scrollHeight", {
			configurable: true,
			get() {
				return box(this) ? 1000 : 0;
			},
		});
		Object.defineProperty(proto, "clientHeight", {
			configurable: true,
			get() {
				return box(this) ? 200 : 0;
			},
		});
		Object.defineProperty(proto, "scrollTop", {
			configurable: true,
			get() {
				return box(this) ? scrollTop : 0;
			},
			set() {},
		});
		const answer = confirmDialog(question(), doc, {
			allowDelayMs: 600,
			alwaysAllow: true,
		});
		const dialog = confirms()[0] as HTMLDialogElement;
		const args = dialog.querySelector(".tab-mcp-arguments") as HTMLElement;
		const note = dialog.querySelector(".tab-mcp-scroll-note") as HTMLElement;
		const allow = byText(dialog, "Allow");
		const always = byText(dialog, "Always allow");
		expect(shown(note)).toBe(true);
		expect(note.textContent).toBe(
			"Scroll to the end of the arguments to allow this call.",
		);
		expect(args.tabIndex).toBe(0);
		expect(args.style.getPropertyValue("max-height")).toBe(
			"var(--tab-mcp-arguments-height, min(50vh, 24rem))",
		);
		jest.advanceTimersByTime(60_000);
		expect(allow.disabled).toBe(true);
		expect(always.disabled).toBe(true);
		// Half-way is not the end.
		scrollTop = 400;
		args.dispatchEvent(new window.Event("scroll") as unknown as Event);
		expect(allow.disabled).toBe(true);
		scrollTop = 800;
		args.dispatchEvent(new window.Event("scroll") as unknown as Event);
		expect(shown(note)).toBe(false);
		expect(allow.disabled).toBe(false);
		expect(always.disabled).toBe(false);
		// Once seen, scrolling back up does not take it back.
		scrollTop = 0;
		args.dispatchEvent(new window.Event("scroll") as unknown as Event);
		expect(allow.disabled).toBe(false);
		allow.click();
		expect(await answer).toBe("allow");
	});

	test("before the delay has run out, Enter or Space on a button and Escape do not answer (CU 13)", async () => {
		const answer = confirmDialog(question(), doc, { allowDelayMs: 600 });
		const dialog = confirms()[0] as HTMLDialogElement;
		const deny = byText(dialog, "Don't allow");
		expect(doc.activeElement).toBe(deny);
		expect(key(deny, "Enter")).toBe(true);
		expect(key(deny, " ")).toBe(true);
		expect(key(deny, " ", "keyup")).toBe(true);
		expect(key(dialog, "Escape")).toBe(true);
		const cancel = new window.Event("cancel", {
			cancelable: true,
		}) as unknown as Event;
		dialog.dispatchEvent(cancel);
		expect(cancel.defaultPrevented).toBe(true);
		// Other keys, and keys on the arguments box, are not touched.
		expect(key(deny, "a")).toBe(false);
		expect(key(dialog.querySelector("pre") as Element, " ")).toBe(false);
		// A click still answers.
		jest.advanceTimersByTime(600);
		expect(key(deny, "Enter")).toBe(false);
		expect(key(dialog, "Escape")).toBe(false);
		deny.click();
		expect(await answer).toBe("deny");
	});

	test("the question and short arguments describe the dialog for screen readers (CU 14)", async () => {
		const answer = confirmDialog(question(), doc);
		const dialog = confirms()[0] as HTMLDialogElement;
		const ids = (dialog.getAttribute("aria-describedby") ?? "").split(" ");
		expect(ids.map((id) => doc.getElementById(id)?.textContent)).toEqual([
			"Claude (claude.ai) wants to run Clear memory.",
			dialog.querySelector("pre")?.textContent,
		]);
		byText(doc, "Don't allow").click();
		await answer;
		// Long arguments are not read out; no arguments neither.
		for (const args of [{ long: "x".repeat(600) }, {}]) {
			const next = confirmDialog({ ...question(), arguments: args }, doc);
			const d = confirms()[0] as HTMLDialogElement;
			expect(
				(d.getAttribute("aria-describedby") ?? "").split(" "),
			).toHaveLength(1);
			byText(doc, "Don't allow").click();
			await next;
		}
	});
});

describe("DIALOG_CSS: page rules do not reach into the dialogs (CU 3, CU 8)", () => {
	test("every element inherits the dialog's colour; buttons reset width, case and spacing; pointer events on", () => {
		expect(DIALOG_CSS).toContain(
			".tab-mcp-dialog :where(*) { box-sizing: border-box; color: inherit; }",
		);
		expect(DIALOG_CSS).toMatch(
			/\.tab-mcp-dialog :where\(button\) \{[^}]*text-transform: none; letter-spacing: normal; width: auto;/,
		);
		expect(DIALOG_CSS).toMatch(/\.tab-mcp-dialog \{[^}]*pointer-events: auto;/);
	});
});

describe("the connect dialog for people who are not developers (iteration 33)", () => {
	let relay: StubRelay;
	let mcp: TabMcp;
	beforeEach(() => {
		relay = new StubRelay();
		mcp = newTab(relay.url);
	});
	afterEach(async () => {
		mcp.disconnect();
		await relay.stop();
	});
	async function open(): Promise<HTMLDialogElement> {
		const connecting = mcp.connect();
		showConnectDialog(mcp, connecting, doc);
		await connecting;
		await relay.next("pairing.start");
		return doc.querySelector("dialog.tab-mcp-connect") as HTMLDialogElement;
	}

	test("every dialog is English and left to right, whatever the page's lang and dir (CU 5)", async () => {
		doc.documentElement.lang = "ar";
		doc.documentElement.dir = "rtl";
		const dialog = await open();
		const answer = confirmDialog(question(), doc);
		const confirm = doc.querySelector("dialog.tab-mcp-confirm") as HTMLElement;
		replacedNotice(mcp, doc, true);
		const notice = doc.querySelector("dialog.tab-mcp-replaced") as HTMLElement;
		for (const d of [dialog, confirm, notice]) {
			expect(d.getAttribute("lang")).toBe("en");
			expect(d.getAttribute("dir")).toBe("ltr");
		}
		byText(confirm, "Don't allow").click();
		await answer;
		byText(notice, "Close").click();
		byText(dialog, "Close").click();
	});

	test("first run: the help between the address and the code; New address apart, saying what it does (CU 23)", async () => {
		const dialog = await open();
		const code = nextEvent(mcp, "pairingcode");
		relay.send({
			type: "pairing.code",
			code: "123456",
			expiresAt: "2026-10-20T10:00:00.000Z",
		});
		await code;
		const setup = dialog.querySelector(".tab-mcp-setup") as HTMLElement;
		expect([...setup.children].map((c) => c.className || c.localName)).toEqual([
			"tab-mcp-address",
			"tab-mcp-help",
			"tab-mcp-code",
			"tab-mcp-sign-in",
			"tab-mcp-new-address-row",
			"tab-mcp-new-address-question",
		]);
		// Closed: open, its steps would push the code out of view.
		const help = dialog.querySelector(".tab-mcp-help") as HTMLDetailsElement;
		expect(shown(help)).toBe(true);
		expect(help.open).toBe(false);
		const address = dialog.querySelector(".tab-mcp-address") as HTMLElement;
		expect(address.querySelector(".tab-mcp-new-address")).toBeNull();
		const row = dialog.querySelector(".tab-mcp-new-address-row") as HTMLElement;
		expect(shown(row)).toBe(true);
		expect(row.textContent).toContain(
			"A new address disconnects every AI app from this one.",
		);
		byText(dialog, "Close").click();
	});

	test("a refused Copy says on the button what to do; Copied and that go back to Copy (CU 12)", async () => {
		const dialog = await open();
		const copy = dialog.querySelector(
			".tab-mcp-address-copy",
		) as HTMLButtonElement;
		Object.defineProperty(window.navigator, "clipboard", {
			value: { writeText: () => Promise.reject(new Error("denied")) },
			configurable: true,
		});
		Object.defineProperty(window.navigator, "platform", {
			value: "MacIntel",
			configurable: true,
		});
		jest.useFakeTimers();
		try {
			copy.click();
			await Promise.resolve();
			await Promise.resolve();
			expect(copy.textContent).toBe("Press ⌘C");
			expect(copy.getAttribute("aria-label")).toBe(
				"Press ⌘C: address selected",
			);
			jest.advanceTimersByTime(SELECTED_MS);
			expect(copy.textContent).toBe("Copy");
			Object.defineProperty(window.navigator, "platform", {
				value: "Win32",
				configurable: true,
			});
			copy.click();
			await Promise.resolve();
			await Promise.resolve();
			expect(copy.textContent).toBe("Press Ctrl+C");
			Object.defineProperty(window.navigator, "clipboard", {
				value: { writeText: async () => {} },
				configurable: true,
			});
			copy.click();
			await Promise.resolve();
			await Promise.resolve();
			expect(copy.textContent).toBe("Copied");
			jest.advanceTimersByTime(COPIED_MS - 1);
			expect(copy.textContent).toBe("Copied");
			jest.advanceTimersByTime(1);
			expect(copy.textContent).toBe("Copy");
			expect(copy.getAttribute("aria-label")).toBe("Copy address");
		} finally {
			jest.useRealTimers();
		}
		byText(dialog, "Close").click();
	});
});
