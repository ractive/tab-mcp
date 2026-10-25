/** The default dialogs in a DOM (happy-dom, passed in; no globals touched). */
import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import { Window } from "happy-dom";
import type { TabMcp } from "../src/index.ts";
import type { ConfirmRequest, Grant, SessionInfo } from "../src/types.ts";
import {
	commandAddress,
	commandName,
	confirmDialog,
	DIALOG_CSS,
	instructions,
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
			`codex features enable mcp_2026_07_28\ncodex mcp add my-notes --url ${session.address}`,
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
		expect(live.textContent).toBe("Selected: copy it with Ctrl+C or ⌘C");
		// The clipboard refuses: the same.
		Object.defineProperty(window.navigator, "clipboard", {
			value: { writeText: () => Promise.reject(new Error("denied")) },
			configurable: true,
		});
		(dialog.querySelector(".tab-mcp-code-copy") as HTMLElement).click();
		await Bun.sleep(0);
		expect(live.textContent?.trim()).toBe(
			"Selected: copy it with Ctrl+C or ⌘C",
		);
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
			`codex features enable mcp_2026_07_28\ncodex mcp add tools --url ${session.address}`,
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
		expect(dialog.querySelector(".tab-mcp-command-note")?.textContent).toBe(
			"Start a new chat in Codex after it connects. The first line turns on a feature for all of Codex's MCP servers; codex features disable mcp_2026_07_28 turns it off.",
		);
		expect(
			dialog.querySelector(".tab-mcp-command-note code")?.textContent,
		).toBe("codex features disable mcp_2026_07_28");
		// No inline styles but those that keep the announcements out of sight and the code selectable as a whole.
		const styled = [...dialog.querySelectorAll("[style]")] as HTMLElement[];
		expect(styled.map((e) => e.className)).toEqual([
			"tab-mcp-code-value",
			"tab-mcp-announce",
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
			// A sibling tab says its session started (`claimed`).
			const announce = new BroadcastChannel(channelName);
			const listener = new BroadcastChannel(channelName);
			const delivered = new Promise((r) => {
				listener.onmessage = r;
			});
			announce.postMessage({ type: "claimed" });
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
		expect((await relay.next("hello"))["secret"]).toBe(secret);
		expect(await relay.next("grants.revokeAll")).toEqual({
			type: "grants.revokeAll",
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

	test("the channel carries neither the secret nor the address", async () => {
		const seen: unknown[] = [];
		const spy = new BroadcastChannel(channelName);
		spy.onmessage = (e) => seen.push(e.data);
		try {
			const session = await mcp.connect();
			const secret = (await relay.next("hello"))["secret"] as string;
			await relay.settled();
			expect(seen).toEqual([{ type: "claimed" }]);
			const text = JSON.stringify(seen);
			expect(text).not.toContain(secret);
			expect(text).not.toContain(session.address);
		} finally {
			spy.close();
		}
	});
});

describe("the commands in the help (dialog design, review of PR 34)", () => {
	test("the name in a command is a label every shell reads as one plain word", () => {
		const cases: [string, string][] = [
			["tools", "tools"],
			["My notes", "my-notes"],
			["Bücher", "bucher"],
			["ｃａｌｃ", "calc"],
			["a\nb", "a-b"],
			["a\rb", "a-b"],
			["‘x’ “y”", "x-y"],
			["a & calc & b", "a-calc-b"],
			["a | calc", "a-calc"],
			["$HOME", "home"],
			["`calc`", "calc"],
			["%PATH%", "path"],
			["a^b", "a-b"],
			["x' ; calc ; 'y$", "x-calc-y"],
			["'$ & calc & '", "calc"],
			["-rf", "rf"],
			["--url=evil", "url-evil"],
			["my_tools-2", "my_tools-2"],
			["", "tools"],
			["!!!", "tools"],
			["日本語", "tools"],
			["a".repeat(60), "a".repeat(40)],
			[`${"a".repeat(39)} b`, "a".repeat(39)],
		];
		for (const [name, label] of cases)
			expect({ name, label: commandName(name) }).toEqual({ name, label });
	});

	test("an address goes into a command only when every character is plain", () => {
		expect(commandAddress("https://relay.example/a/abc234/mcp")).toBe(
			"https://relay.example/a/abc234/mcp",
		);
		expect(commandAddress("http://127.0.0.1:8080/a/x/mcp")).toBe(
			"http://127.0.0.1:8080/a/x/mcp",
		);
		expect(commandAddress("http://[::1]:8080/a/x/mcp")).toBe(
			"http://[::1]:8080/a/x/mcp",
		);
		for (const unsafe of [
			"https://relay.example/a/x/mcp?q=1&calc",
			"https://relay.example/a/$(calc)/mcp",
			"https://relay.example/a/x%0Acalc/mcp",
			"https://relay.example/a/'x'/mcp",
			"https://relay.example/a/x/mcp#frag",
			"https://user:pw@relay.example/a/x/mcp",
			"ftp://relay.example/a/x/mcp",
			"not an address",
		])
			expect({ unsafe, command: commandAddress(unsafe) }).toEqual({
				unsafe,
				command: undefined,
			});
	});

	test("Codex turns on its MCP 2026-07-28 feature first, one command per line", () => {
		const codex = instructions("calc", "https://relay.example/a/x/mcp").find(
			([app]) => app === "Codex",
		);
		expect(codex?.[2]).toBe(
			"codex features enable mcp_2026_07_28\ncodex mcp add calc --url https://relay.example/a/x/mcp",
		);
		const claudeCode = instructions(
			"x' ; calc ; 'y$",
			"https://r.example/a/x/mcp",
		).find(([app]) => app === "Claude Code");
		expect(claudeCode?.[2]).toBe(
			"claude mcp add --transport http x-calc-y https://r.example/a/x/mcp",
		);
	});

	test("with an address that is not plain, no commands: only the steps", () => {
		const steps = instructions("calc", "https://relay.example/a/x/mcp?a=1&b");
		expect(steps.every(([, , command]) => command === undefined)).toBe(true);
		expect(steps.map(([app]) => app)).toEqual([
			"Claude (claude.ai and the desktop app)",
			"ChatGPT",
			"Claude Code",
			"Codex",
		]);
		const text = steps.map(([, how]) => how).join(" ");
		expect(text).toContain("claude mcp add");
		expect(text).toContain("mcp_2026_07_28");
		expect(text).not.toContain("calc");
	});
});
