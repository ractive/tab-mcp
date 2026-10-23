/** The default dialogs in a DOM (happy-dom, passed in; no globals touched). */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import type { TabMcp } from "../src/index.ts";
import type { ConfirmRequest, Grant, SessionInfo } from "../src/types.ts";
import { confirmDialog, showConnectDialog } from "../src/ui.ts";
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
		expect(byText(dialog, "Copy").className).toBe("tab-mcp-address-copy");
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
		expect(close.className).toBe("tab-mcp-close");
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
});
