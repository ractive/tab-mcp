/** The default dialogs in a DOM (happy-dom, passed in; no globals touched). */
import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import { Window } from "happy-dom";
import type { TabMcp } from "../src/index.ts";
import type { ConfirmRequest, Grant, SessionInfo } from "../src/types.ts";
import { confirmDialog, DIALOG_CSS, showConnectDialog } from "../src/ui.ts";
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

function question(signal = new AbortController().signal): ConfirmRequest {
	return {
		tool: {
			name: "clear_memory",
			title: "Clear memory",
			description: "Clears the calculator memory",
		},
		arguments: { all: true, note: "<b>not html</b>" },
		client: {
			grantId: "g_1",
			id: "https://claude.ai/c.json",
			name: "Claude",
			host: "claude.ai",
		},
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
		const answer = confirmDialog(question(), doc);
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
		const answer = confirmDialog(question(), doc);
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
		const answer = confirmDialog({ ...question(), arguments: loop }, doc);
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
		const answer = confirmDialog(question(), doc, { allowDelayMs: 600 });
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
		const answer = confirmDialog(question(), doc, { allowDelayMs: 600 });
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
				client: { ...question().client, name: "\u202EedualC" },
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
		// Apps connected before the dialog opened do not count: no Done yet.
		const done = byText(dialog, "Done");
		const close = byText(dialog, "Close");
		expect(done.hidden).toBe(true);
		expect(close.hidden).toBe(false);

		// A newly connected app is announced in the status line.
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

		done.click();
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

	async function sendCode(code: string): Promise<void> {
		const shown = nextEvent(mcp, "pairingcode");
		relay.send({
			type: "pairing.code",
			code,
			expiresAt: "2026-10-20T10:00:00.000Z",
		});
		await shown;
	}

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
		await relay.next("grants.revokeAll");
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

	test("a failed connection shows the reason in the dialog", async () => {
		const offline = newTab("http://127.0.0.1:9");
		const connecting = offline.connect();
		const closed = showConnectDialog(offline, connecting, doc);
		await connecting.catch(() => {});
		await Bun.sleep(0);
		const dialog = doc.querySelector("dialog") as HTMLDialogElement;
		expect(dialog.querySelector(".tab-mcp-status")?.textContent).toMatch(
			/^Could not connect: /,
		);
		byText(dialog, "Close").click();
		await closed;
	});

	test("New address asks first while apps are connected; Cancel keeps the address", async () => {
		const { dialog, session } = await open();
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
		byText(dialog, "Close").click();
	});

	test("the New address question follows the connected apps while it is open", async () => {
		const { dialog } = await open();
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
		expect(await relay.next("grants.revokeAll")).toEqual({
			type: "grants.revokeAll",
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
		expect(await relay.next("grants.revokeAll")).toEqual({
			type: "grants.revokeAll",
		});
		await relay.next("hello");
		byText(dialog, "Close").click();
	});

	test("the dialog follows a disconnect", async () => {
		const { dialog } = await open();
		const gone = nextEvent(mcp, "disconnected");
		relay.close(4002);
		await gone;
		expect(dialog.querySelector(".tab-mcp-status")?.textContent).toContain(
			"Disconnected",
		);
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
		// Copying the address is the next step; Done once an app connected.
		expect(has(".tab-mcp-address-copy", "tab-mcp-primary")).toBe(true);
		expect(has(".tab-mcp-done", "tab-mcp-primary")).toBe(true);
		expect(
			dialog.querySelectorAll(".tab-mcp-primary:not([hidden])").length,
		).toBe(1);
		for (const plain of [
			".tab-mcp-code-copy",
			".tab-mcp-new-address",
			".tab-mcp-close",
		])
			expect(has(plain, "tab-mcp-primary")).toBe(false);
		// Both Copy buttons take the same room as "Copy" and "Copied".
		expect(dialog.querySelectorAll("button.tab-mcp-copy").length).toBe(2);
		// What disconnects apps is marked.
		expect(has(".tab-mcp-disconnect", "tab-mcp-danger")).toBe(true);
		expect(has(".tab-mcp-new-address-confirm", "tab-mcp-danger")).toBe(true);
		const app = dialog.querySelector(".tab-mcp-apps li .tab-mcp-app");
		expect(app?.textContent).toBe("Claude (claude.ai) connected ");
		// The command for Claude Code is set apart, with the address in it.
		expect(dialog.querySelector(".tab-mcp-help code")?.textContent).toBe(
			`claude mcp add --transport http tools ${session.address}`,
		);
		expect(
			[...dialog.querySelectorAll(".tab-mcp-help strong")].map(
				(s) => s.textContent,
			),
		).toEqual([
			"Claude (claude.ai and the desktop app):",
			"ChatGPT:",
			"Claude Code:",
		]);
		// No inline styles but the one that keeps the code selectable as a whole.
		const styled = [...dialog.querySelectorAll("[style]")] as HTMLElement[];
		expect(styled.map((e) => e.className)).toEqual(["tab-mcp-code-value"]);
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

	test("every selector has the weight of one class: element rules of the page do not reach in, two classes win", () => {
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
		for (const selector of selectors) {
			// :where() weighs nothing; nested parentheses one level deep.
			const weighed = selector.replace(/:where\((?:[^()]|\([^()]*\))*\)/g, "");
			for (const part of weighed.split(",")) {
				const classes =
					part.match(/\.[\w-]+|\[[^\]]*\]|(?<!:):(?!:)[\w-]+/g) ?? [];
				expect({ selector, classes }).toEqual({
					selector,
					classes: [expect.stringMatching(/^\.tab-mcp-/)],
				});
				expect(part).not.toContain("#");
				expect(part).not.toMatch(/:is\(|:not\(|:has\(/);
			}
		}
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
		const animations = [...DIALOG_CSS.matchAll(/animation:/g)].length;
		expect(animations).toBe(1);
		expect(DIALOG_CSS).toMatch(
			/@media \(prefers-reduced-motion: no-preference\) \{[^}]*animation:/,
		);
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
