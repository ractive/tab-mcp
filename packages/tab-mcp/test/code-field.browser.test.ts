/**
 * The pairing page's code field in Chrome (DEC-211): the real page from a
 * relay in this process, typed into with real key presses, pasted into from
 * the clipboard, measured at 320 px and at desktop width, its policy
 * allowing the one script, and the page without the script still
 * submitting a typed code. The text and caret rules themselves are in
 * code-field.test.ts.
 */
import {
	afterAll,
	beforeAll,
	describe,
	expect,
	setDefaultTimeout,
	test,
} from "bun:test";
import { browserTests } from "../../../test/browser-gate.ts";
import {
	Browser,
	findChrome,
	type Page,
} from "../../tab-mcp-client/test/cdp.ts";
import { ScriptedTab } from "./helpers.ts";
import {
	authorizeUrl,
	type CimdServer,
	type OAuthTestRelay,
	pkce,
	startCimdServer,
	startOAuthRelay,
} from "./oauth-helpers.ts";

setDefaultTimeout(30_000);

const chrome = browserTests ? findChrome() : undefined;
if (browserTests && chrome === undefined && process.env["CI"])
	throw new Error("Chrome is needed for the code field's browser test in CI");

let cimd: CimdServer;
let relay: OAuthTestRelay;
let tab: ScriptedTab;
let browser: Browser;
let clientId: string;
let callbacks: ReturnType<typeof Bun.serve>;
const waiting: ((params: URLSearchParams) => void)[] = [];

beforeAll(async () => {
	if (chrome === undefined) return;
	cimd = await startCimdServer();
	clientId = cimd.serve(
		"/client.json",
		cimd.document(`${cimd.origin}/client.json`),
	);
	relay = startOAuthRelay(cimd);
	tab = new ScriptedTab(relay.wsUrl);
	await tab.connect();
	await tab.startPairing();
	callbacks = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		fetch: (req) => {
			waiting.shift()?.(new URL(req.url).searchParams);
			return new Response("done", {
				headers: { "content-type": "text/plain" },
			});
		},
	});
	browser = await Browser.launch(chrome);
});

afterAll(async () => {
	if (chrome === undefined) return;
	await browser.close();
	tab.close();
	await relay.stop();
	await callbacks.stop(true);
	await cimd.stop();
});

let used: string | undefined;

/** The page's code now, once the relay replaced the one used last. */
async function freshCode(): Promise<string> {
	const code = await tab.nextCode(used);
	used = code;
	return code;
}

/** The AI app's next callback. */
const nextCallback = () =>
	new Promise<URLSearchParams>((resolve) => {
		waiting.push(resolve);
	});

const FIELD = "document.getElementById('code')";

/**
 * A new tab with the pairing page of a new request, once the code field has
 * the focus; violations of the page's policy are recorded.
 */
async function openPairingPage(
	options: { width?: number; scripts?: boolean } = {},
): Promise<Page> {
	const page = await browser.newPage();
	if (options.width !== undefined) {
		await page.send("Emulation.setDeviceMetricsOverride", {
			width: options.width,
			height: 700,
			deviceScaleFactor: 1,
			mobile: true,
		});
	}
	if (options.scripts === false) {
		await page.send("Emulation.setScriptExecutionDisabled", { value: true });
	}
	await page.send("Emulation.setFocusEmulationEnabled", { enabled: true });
	await page.send("Page.addScriptToEvaluateOnNewDocument", {
		source: `window.__violations = []; document.addEventListener("securitypolicyviolation", (e) => window.__violations.push(e.violatedDirective + " " + e.blockedURI)); window.__errors = []; window.addEventListener("error", (e) => window.__errors.push(String(e.message)));`,
	});
	await page.goto(
		authorizeUrl(relay.url, {
			client_id: clientId,
			redirect_uri: `http://127.0.0.1:${callbacks.port}/callback`,
			code_challenge: pkce().challenge,
			resource: tab.session?.address ?? "",
		}),
	);
	// The field has `autofocus`; Chrome focuses it when it next renders. Asked
	// from here: with JavaScript off, timers in the page never fire.
	for (let tries = 0; ; tries++) {
		if (await page.eval<boolean>(`document.activeElement === ${FIELD}`)) break;
		if (tries === 250) throw new Error("the code field never got the focus");
		await Bun.sleep(20);
	}
	return page;
}

/** The field's text and selection. */
function field(page: Page): Promise<{ value: string; caret: string }> {
	return page.eval(
		`(() => { const f = ${FIELD}; return { value: f.value, caret: f.value.slice(0, f.selectionStart) + "|" + f.value.slice(f.selectionEnd) }; })()`,
	);
}

async function key(
	page: Page,
	name: string,
	code: number,
	extra: Record<string, unknown> = {},
): Promise<void> {
	await page.send("Input.dispatchKeyEvent", {
		type: "rawKeyDown",
		key: name,
		code: name,
		windowsVirtualKeyCode: code,
		...extra,
	});
	await page.send("Input.dispatchKeyEvent", {
		type: "keyUp",
		key: name,
		code: name,
		windowsVirtualKeyCode: code,
	});
}

/** Key presses that type `text`, one character after the other. */
async function typeKeys(page: Page, text: string): Promise<void> {
	for (const ch of text) {
		const upper = ch.toUpperCase();
		await page.send("Input.dispatchKeyEvent", {
			type: "keyDown",
			key: ch,
			code: /[A-Z]/.test(upper) ? `Key${upper}` : "",
			text: ch,
			unmodifiedText: ch,
			windowsVirtualKeyCode: upper.charCodeAt(0),
		});
		await page.send("Input.dispatchKeyEvent", { type: "keyUp", key: ch });
	}
}

const backspace = (page: Page) => key(page, "Backspace", 8);
const del = (page: Page) => key(page, "Delete", 46);

/** Put `text` on the clipboard and paste it with the paste command. */
async function paste(page: Page, text: string): Promise<void> {
	await page.eval(`navigator.clipboard.writeText(${JSON.stringify(text)})`);
	await page.send("Input.dispatchKeyEvent", {
		type: "rawKeyDown",
		key: "v",
		code: "KeyV",
		windowsVirtualKeyCode: 86,
		modifiers: process.platform === "darwin" ? 4 : 2,
		commands: ["paste"],
	});
	await page.send("Input.dispatchKeyEvent", {
		type: "keyUp",
		key: "v",
		code: "KeyV",
	});
}

/** Cmd/Ctrl-Z with the undo command. */
async function undo(page: Page): Promise<void> {
	await page.send("Input.dispatchKeyEvent", {
		type: "rawKeyDown",
		key: "z",
		code: "KeyZ",
		windowsVirtualKeyCode: 90,
		modifiers: process.platform === "darwin" ? 4 : 2,
		commands: ["undo"],
	});
	await page.send("Input.dispatchKeyEvent", {
		type: "keyUp",
		key: "z",
		code: "KeyZ",
	});
}

const caretAt = (page: Page, position: number) =>
	page.eval(`${FIELD}.setSelectionRange(${position}, ${position})`);

const clear = (page: Page) =>
	page.eval(`(() => { const f = ${FIELD}; f.select(); })()`);

/** Whether the field shows all of its text: nothing scrolled, nothing cut off. */
function fits(page: Page): Promise<{
	scroll: boolean;
	inView: boolean;
	page: boolean;
}> {
	return page.eval(`(() => {
		const f = ${FIELD};
		const r = f.closest('.code-field').getBoundingClientRect();
		return {
			scroll: f.scrollWidth <= f.clientWidth && f.scrollLeft === 0,
			inView: r.left >= 0 && r.right <= document.documentElement.clientWidth,
			page: document.documentElement.scrollWidth <= document.documentElement.clientWidth,
		};
	})()`);
}

describe.skipIf(chrome === undefined)("the code field in Chrome", () => {
	test("the script runs under the page's policy, with no violation, and draws the boxes", async () => {
		const page = await openPairingPage();
		expect(
			await page.eval<boolean>(
				"document.querySelector('.code-field').classList.contains('enhanced')",
			),
		).toBe(true);
		expect(await page.eval<string[]>("window.__violations")).toEqual([]);
		expect(
			await page.eval<string[]>(
				"[...document.querySelectorAll('.code-boxes > span')].map((b) => getComputedStyle(b).display === 'none' ? 'hidden' : 'shown')",
			),
		).toEqual(Array(9).fill("shown"));
		// The boxes are no content for assistive technology; the label and the
		// help stay on the input, which keeps its hooks (DEC-199).
		expect(
			await page.eval(
				`(() => { const f = ${FIELD}; return { hidden: document.querySelector('.code-boxes').getAttribute('aria-hidden'), label: f.labels[0].textContent, help: f.getAttribute('aria-describedby'), hook: f.dataset.tabMcpField, focused: document.activeElement === f, maxlength: f.getAttribute('maxlength') }; })()`,
			),
		).toEqual({
			hidden: "true",
			label: "Code",
			help: "code-help",
			hook: "code",
			focused: true,
			maxlength: null,
		});
		await page.close();
	});

	test("typing, Backspace and Delete across the dash, typing in the middle", async () => {
		const page = await openPairingPage();
		await typeKeys(page, "bcdf");
		expect(await field(page)).toEqual({ value: "BCDF", caret: "BCDF|" });
		await typeKeys(page, "g");
		expect((await field(page)).caret).toBe("BCDF-G|");
		await typeKeys(page, "1 hjk");
		expect((await field(page)).caret).toBe("BCDF-GHJK|");
		await typeKeys(page, "l");
		expect((await field(page)).caret).toBe("BCDF-GHJK|");

		await caretAt(page, 5);
		await backspace(page);
		expect((await field(page)).caret).toBe("BCD|G-HJK");
		await caretAt(page, 4);
		await del(page);
		expect((await field(page)).caret).toBe("BCDG|-JK");
		await caretAt(page, 1);
		await typeKeys(page, "x");
		expect((await field(page)).caret).toBe("BX|CD-GJK");
		await backspace(page);
		expect((await field(page)).caret).toBe("B|CDG-JK");
		await backspace(page);
		await backspace(page);
		expect((await field(page)).caret).toBe("|CDGJ-K");
		await key(page, "End", 35);
		for (let i = 0; i < 6; i++) await backspace(page);
		expect(await field(page)).toEqual({ value: "", caret: "|" });
		await page.close();
	});

	test("paste of abcd-efgh, ABCD EFGH and ABCDEFGH, with line breaks around, and into the middle", async () => {
		const page = await openPairingPage();
		await page.send("Browser.grantPermissions", {
			origin: relay.url,
			permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"],
		});
		for (const text of [
			"abcd-efgh",
			"ABCD EFGH",
			"ABCDEFGH",
			"\n  abcd-efgh \n",
		]) {
			await clear(page);
			await paste(page, text);
			expect(await field(page)).toEqual({
				value: "ABCD-EFGH",
				caret: "ABCD-EFGH|",
			});
		}
		await clear(page);
		await typeKeys(page, "abgh");
		await caretAt(page, 2);
		await paste(page, "cd-ef");
		expect((await field(page)).caret).toBe("ABCD-EF|GH");
		await page.close();
	});

	test("undo after typing and after a paste: nothing throws, the text keeps its shape, typing goes on", async () => {
		// The script's rewrites drop the field's undo history (DEC-211), so
		// undo may do nothing; it must not break the field.
		const page = await openPairingPage();
		await page.send("Browser.grantPermissions", {
			origin: relay.url,
			permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"],
		});
		const shape = /^([A-Z]{0,4}|[A-Z]{4}-[A-Z]{1,4})$/;
		await typeKeys(page, "abcde");
		for (let i = 0; i < 3; i++) await undo(page);
		expect((await field(page)).value).toMatch(shape);
		await clear(page);
		await paste(page, "  abcd efgh \n");
		for (let i = 0; i < 3; i++) await undo(page);
		expect((await field(page)).value).toMatch(shape);
		await clear(page);
		await typeKeys(page, "bcdfg");
		expect(await field(page)).toEqual({ value: "BCDF-G", caret: "BCDF-G|" });
		expect(await page.eval<string[]>("window.__errors")).toEqual([]);
		await page.close();
	});

	test("a full code fits, never scrolled or cut off, at 320 px and at desktop width", async () => {
		for (const width of [320, 1280]) {
			const page = await openPairingPage({ width });
			await typeKeys(page, "wmwmwmwm");
			expect((await field(page)).value).toBe("WMWM-WMWM");
			expect(await fits(page)).toEqual({
				scroll: true,
				inView: true,
				page: true,
			});
			await page.close();
		}
	});

	test("Connect submits the typed code, and Enter does too; nothing submits by itself", async () => {
		const code = await freshCode();
		const page = await openPairingPage();
		await typeKeys(page, code.toLowerCase().replace("-", ""));
		expect((await field(page)).value).toBe(code);
		// A full code does not submit by itself.
		await Bun.sleep(200);
		expect(await page.eval<string>("location.pathname")).toBe("/authorize");
		const callback = nextCallback();
		await page.click('button[value="connect"]');
		expect((await callback).get("code")).toBeTruthy();
		await page.close();

		const next = await freshCode();
		const second = await openPairingPage();
		await typeKeys(second, next);
		const viaEnter = nextCallback();
		await second.send("Input.dispatchKeyEvent", {
			type: "keyDown",
			key: "Enter",
			code: "Enter",
			windowsVirtualKeyCode: 13,
			text: "\r",
		});
		await second.send("Input.dispatchKeyEvent", {
			type: "keyUp",
			key: "Enter",
			code: "Enter",
			windowsVirtualKeyCode: 13,
		});
		expect((await viaEnter).get("code")).toBeTruthy();
		await second.close();
	});

	test("an extension that writes the code and submits (DEC-199) works unchanged", async () => {
		const code = await freshCode();
		const page = await openPairingPage();
		const callback = nextCallback();
		// What `fillIn` in @ractive-ch/tab-mcp-client/extension does.
		await page.eval(`(() => {
			const form = document.querySelector('form[data-tab-mcp-pairing="1"]');
			const f = form.querySelector('input[data-tab-mcp-field="code"]');
			f.value = ${JSON.stringify(code)};
			f.dispatchEvent(new Event("input", { bubbles: true }));
			form.requestSubmit(form.querySelector('button[data-tab-mcp-action="connect"]'));
		})()`);
		expect((await callback).get("code")).toBeTruthy();
		await page.close();
	});

	test("without the script the field is a plain input that fits the code and submits it", async () => {
		const code = await freshCode();
		const page = await openPairingPage({ scripts: false, width: 320 });
		expect(
			await page.eval(
				`(() => { const f = ${FIELD}; return { enhanced: f.parentElement.classList.contains('enhanced'), boxes: getComputedStyle(document.querySelector('.code-boxes')).display, maxlength: f.getAttribute('maxlength') }; })()`,
			),
		).toEqual({ enhanced: false, boxes: "none", maxlength: "12" });
		await page.eval(`${FIELD}.focus()`);
		// The plain input keeps its own caret.
		expect(
			await page.eval<string>(`getComputedStyle(${FIELD}).caretColor`),
		).not.toBe("rgba(0, 0, 0, 0)");
		const typed = `${code.slice(0, 4).toLowerCase()} - ${code.slice(5).toLowerCase()}`;
		await page.send("Input.insertText", { text: typed });
		expect((await field(page)).value).toBe(typed);
		expect(await fits(page)).toEqual({
			scroll: true,
			inView: true,
			page: true,
		});
		const callback = nextCallback();
		await page.click('button[value="connect"]');
		expect((await callback).get("code")).toBeTruthy();
		await page.close();
	});
});

/**
 * Where each letter sits against its box, from the geometry of the page
 * itself (so any cell width passes): the letter's horizontal centre, from the
 * input's padding, the width of `1ch` and the letter spacing, against the
 * centre of the box drawn for it; the boxes' rectangles, the `.at` boxes
 * and whether the page scrolls sideways.
 */
function geometry(page: Page): Promise<{
	offsets: number[];
	dash: number;
	at: number[];
	overflow: boolean;
	boxWidth: number;
	letterWidth: number;
	rowRight: number;
	viewport: number;
}> {
	return page.eval(`(() => {
		const f = ${FIELD};
		const cs = getComputedStyle(f);
		const probe = document.createElement("span");
		probe.style.cssText = "position:absolute;visibility:hidden;width:1ch;font:" + cs.font;
		document.body.append(probe);
		const ch = probe.getBoundingClientRect().width;
		probe.remove();
		const cell = ch + parseFloat(cs.letterSpacing);
		const left = f.getBoundingClientRect().left + parseFloat(cs.borderLeftWidth) + parseFloat(cs.paddingLeft) - f.scrollLeft;
		const boxes = [...document.querySelectorAll(".code-boxes > span")].map((b) => b.getBoundingClientRect());
		const mid = (r) => (r.left + r.right) / 2;
		const letters = f.value.replace("-", "").length;
		const offsets = [];
		for (let i = 0; i < letters; i++) {
			const index = i < 4 ? i : i + 1;
			offsets.push(left + index * cell + ch / 2 - mid(boxes[index]));
		}
		return {
			offsets,
			dash: mid(boxes[4]) - (boxes[3].right + boxes[5].left) / 2,
			at: boxes.map((b, i) => document.querySelectorAll(".code-boxes > span")[i].classList.contains("at") ? i : -1).filter((i) => i >= 0),
			overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
			boxWidth: boxes[0].width,
			letterWidth: ch,
			rowRight: document.querySelector(".code-boxes").getBoundingClientRect().right,
			viewport: document.documentElement.clientWidth,
		};
	})()`);
}

/** Wait until exactly the boxes `expected` are marked as the caret's. */
async function atIs(page: Page, expected: number[]): Promise<void> {
	const deadline = Date.now() + 3000;
	let at: number[] = [];
	while (Date.now() < deadline) {
		at = (await geometry(page)).at;
		if (JSON.stringify(at) === JSON.stringify(expected)) return;
		await Bun.sleep(20);
	}
	expect(at).toEqual(expected);
}

const caretColor = (page: Page) =>
	page.eval<string>(`getComputedStyle(${FIELD}).caretColor`);

/**
 * The one assumption the box arithmetic rests on: every letter of the code's
 * alphabet and the dash is exactly `1ch` wide in the font the input uses.
 */
function advances(page: Page): Promise<{ font: string; worst: number }> {
	return page.eval(`(() => {
		const f = ${FIELD};
		const font = getComputedStyle(f).font;
		const probe = document.createElement("span");
		probe.style.cssText = "position:absolute;visibility:hidden;width:1ch;font:" + font;
		document.body.append(probe);
		const ch = probe.getBoundingClientRect().width;
		probe.remove();
		const ctx = document.createElement("canvas").getContext("2d");
		ctx.font = font;
		let worst = 0;
		for (const c of "ABCDEFGHIJKLMNOPQRSTUVWXYZ-") worst = Math.max(worst, Math.abs(ctx.measureText(c).width - ch));
		return { font, worst };
	})()`);
}

interface CaretLine {
	box: number;
	/** The line's left and right edge, against the box's middle, in px. */
	from: number;
	to: number;
	/** The letter's advance box, against the box's middle: half a `1ch`. */
	half: number;
	width: number;
	height: number;
	animation: string;
	color: string;
	letterColor: string;
}

/** The drawn caret lines: one per box that has one, measured from computed styles. */
function caretLines(page: Page): Promise<CaretLine[]> {
	return page.eval(`(() => {
		const f = ${FIELD};
		const probe = document.createElement("span");
		probe.style.cssText = "position:absolute;visibility:hidden;width:1ch;font:" + getComputedStyle(f).font;
		document.body.append(probe);
		const ch = probe.getBoundingClientRect().width;
		probe.remove();
		const out = [];
		document.querySelectorAll(".code-boxes > span").forEach((b, box) => {
			if (b.classList.contains("code-dash")) return;
			const cs = getComputedStyle(b, "::before");
			if (cs.content === "none" || cs.content === "normal") return;
			const r = b.getBoundingClientRect();
			const left = r.left + parseFloat(getComputedStyle(b).borderLeftWidth) + parseFloat(cs.left);
			const width = parseFloat(cs.borderLeftWidth);
			const mid = (r.left + r.right) / 2;
			out.push({
				box,
				from: left - mid,
				to: left + width - mid,
				half: ch / 2,
				width,
				height: parseFloat(cs.height),
				animation: cs.animationName,
				color: cs.borderLeftColor,
				letterColor: getComputedStyle(f).color,
			});
		});
		return out;
	})()`);
}

/** Wait until exactly one caret line is drawn, then return it. */
async function oneCaret(page: Page): Promise<CaretLine> {
	const deadline = Date.now() + 3000;
	let lines: CaretLine[] = [];
	while (Date.now() < deadline) {
		lines = await caretLines(page);
		if (lines.length === 1) break;
		await Bun.sleep(20);
	}
	expect(lines).toHaveLength(1);
	return lines[0] as CaretLine;
}

/** Wait until no caret line is drawn. */
async function noCaret(page: Page): Promise<void> {
	const deadline = Date.now() + 3000;
	let lines: CaretLine[] = [];
	while (Date.now() < deadline) {
		lines = await caretLines(page);
		if (lines.length === 0) return;
		await Bun.sleep(20);
	}
	expect(lines).toEqual([]);
}

/** The native caret is hidden exactly while a drawn one exists. */
async function nativeCaretHidden(page: Page): Promise<boolean> {
	return (await caretColor(page)) === "rgba(0, 0, 0, 0)";
}

/** Which side of the letter's advance box the line stands on, from where it is drawn. */
function sideOf(line: CaretLine): "before" | "after" | "empty" | "other" {
	if (line.to <= -line.half) return "before";
	if (line.from >= line.half) return "after";
	return Math.abs((line.from + line.to) / 2) < 0.5 ? "empty" : "other";
}

/** The line stands in `box`, on `side`, a clear gap from the letter's advance box (or in the box's middle). */
function expectCaret(
	line: CaretLine,
	box: number,
	side: "before" | "after" | "empty",
) {
	expect(line.box).toBe(box);
	expect(sideOf(line)).toBe(side);
	expect(line.width).toBeGreaterThanOrEqual(1);
	expect(line.height).toBeGreaterThan(0);
	// A clear gap to the letter's advance box (the font test proves it is 1ch).
	if (side === "before") expect(-line.half - line.to).toBeGreaterThanOrEqual(1);
	if (side === "after") expect(line.from - line.half).toBeGreaterThanOrEqual(1);
	// The field's text colour, as a native caret.
	expect(line.color).toBe(line.letterColor);
}

describe.skipIf(chrome === undefined)("the code boxes in Chrome", () => {
	test("a blinking line stands in the box at the caret, on the side of the real caret; the native caret hides exactly then", async () => {
		const page = await openPairingPage();
		// Empty: the next letter goes to box 0.
		expectCaret(await oneCaret(page), 0, "empty");
		expect(await nativeCaretHidden(page)).toBe(true);
		// Half typed: caret after "NHN", box 3 has no letter.
		await typeKeys(page, "nhn");
		expectCaret(await oneCaret(page), 3, "empty");
		await caretAt(page, 1);
		await atIs(page, [1]);
		expectCaret(await oneCaret(page), 1, "before");
		// A full code: every caret position of "NHNX-MNMH".
		await clear(page);
		await typeKeys(page, "nhnxmnmh");
		expect((await field(page)).value).toBe("NHNX-MNMH");
		for (const [caret, box, side] of [
			[0, 0, "before"],
			[1, 1, "before"],
			[2, 2, "before"],
			[3, 3, "before"],
			[4, 5, "before"],
			[5, 5, "before"],
			[6, 6, "before"],
			[7, 7, "before"],
			[8, 8, "before"],
			[9, 8, "after"],
		] as const) {
			await caretAt(page, caret);
			await atIs(page, [box]);
			expectCaret(await oneCaret(page), box, side);
			expect(await nativeCaretHidden(page)).toBe(true);
			expect((await caretLines(page)).map((l) => l.animation)).toEqual([
				"code-blink",
			]);
		}
		// Four letters, caret at the end: the first box of the second group.
		await clear(page);
		await typeKeys(page, "nhnx");
		expectCaret(await oneCaret(page), 5, "empty");
		await page.close();
	});

	test("no line and the native caret back: blurred, with a selection, while an input method composes", async () => {
		const page = await openPairingPage();
		await typeKeys(page, "nhnxmnmh");
		await oneCaret(page);
		await clear(page); // a selection of every letter
		await noCaret(page);
		expect(await nativeCaretHidden(page)).toBe(false);
		await caretAt(page, 2);
		await oneCaret(page);
		await page.eval(
			`${FIELD}.dispatchEvent(new CompositionEvent("compositionstart"))`,
		);
		await noCaret(page);
		expect(await nativeCaretHidden(page)).toBe(false);
		// A selection change during the composition draws no line: a negative,
		// so it is given 100 ms to show up.
		await caretAt(page, 1);
		await Bun.sleep(100);
		expect(await caretLines(page)).toEqual([]);
		await page.eval(
			`${FIELD}.dispatchEvent(new CompositionEvent("compositionend"))`,
		);
		expectCaret(await oneCaret(page), 1, "before");
		await page.eval(`${FIELD}.blur()`);
		await noCaret(page);
		expect(await nativeCaretHidden(page)).toBe(false);
		await page.close();
	});

	test("the line blinks, and stands still when the user asks for less motion; every paint starts a new blink", async () => {
		const page = await openPairingPage();
		await typeKeys(page, "nhnxmnmh");
		await oneCaret(page);
		expect(
			await page.eval(
				`(() => { const b = document.querySelector(".code-boxes > .at"); const cs = getComputedStyle(b, "::before"); return { count: b.getAnimations({ subtree: true }).filter((x) => x.animationName === "code-blink").length, duration: cs.animationDuration, iterations: cs.animationIterationCount, easing: cs.animationTimingFunction }; })()`,
			),
		).toEqual({
			count: 1,
			duration: "1.1s",
			iterations: "infinite",
			easing: "steps(1)",
		});
		// In one evaluation, without wall time: the caret moves within the same
		// box (behind the last letter instead of in front of it) and the
		// animation is a new object, so it starts again.
		await caretAt(page, 8);
		await atIs(page, [8]);
		expect(
			await page.eval<{ fresh: boolean; same: boolean }>(`(async () => {
				const f = ${FIELD};
				const first = () => document.querySelector(".code-boxes > .at").getAnimations({ subtree: true })[0];
				const before = first();
				const box = document.querySelector(".code-boxes > .at");
				const moved = new Promise((r) => f.addEventListener("selectionchange", r, { once: true }));
				f.setSelectionRange(9, 9);
				await moved;
				return { fresh: first() !== before, same: document.querySelector(".code-boxes > .at") === box };
			})()`),
		).toEqual({ fresh: true, same: true });
		await page.send("Emulation.setEmulatedMedia", {
			features: [{ name: "prefers-reduced-motion", value: "reduce" }],
		});
		expect((await caretLines(page)).map((l) => l.animation)).toEqual(["none"]);
		await page.close();
	});

	test("typing eight letters one by one moves the line across the dash, and a paste of more than eight ends behind the last letter", async () => {
		const page = await openPairingPage();
		const expected = [
			[1, "empty"],
			[2, "empty"],
			[3, "empty"],
			[5, "empty"],
			[6, "empty"],
			[7, "empty"],
			[8, "empty"],
			[8, "after"],
		] as const;
		let i = 0;
		for (const letter of "nhnxmnmh") {
			await typeKeys(page, letter);
			const [box, side] = expected[i++] as (typeof expected)[number];
			await atIs(page, [box]);
			expectCaret(await oneCaret(page), box, side);
			expect(await nativeCaretHidden(page)).toBe(true);
		}
		await page.send("Browser.grantPermissions", {
			origin: relay.url,
			permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"],
		});
		await clear(page);
		await paste(page, "abcdefghijkl");
		expect((await field(page)).value).toBe("ABCD-EFGH");
		await atIs(page, [8]);
		expectCaret(await oneCaret(page), 8, "after");
		await page.close();
	});

	test("no line while the window is not in front, though the field keeps being the active element; it is back with the window", async () => {
		const page = await openPairingPage();
		await typeKeys(page, "nh");
		await oneCaret(page);
		// Another tab in front: the page keeps its active element but loses the
		// window's focus (the harness's focus emulation would keep it).
		await page.send("Emulation.setFocusEmulationEnabled", { enabled: false });
		const other = await browser.newPage();
		await other.goto("about:blank");
		await browser.send("Target.activateTarget", { targetId: other.targetId });
		await noCaret(page);
		expect(
			await page.eval<{ active: boolean; focus: boolean }>(
				`({ active: document.activeElement === ${FIELD}, focus: document.hasFocus() })`,
			),
		).toEqual({ active: true, focus: false });
		expect(await nativeCaretHidden(page)).toBe(false);
		await page.send("Emulation.setFocusEmulationEnabled", { enabled: true });
		expectCaret(await oneCaret(page), 2, "empty");
		await other.close();
		await page.close();
	});

	test("each letter is centred in its box, the dash between the groups, boxes roomier than the letters, nothing scrolled or cropped, from 263 px to desktop width", async () => {
		// 263 px is 280 px less a classic scrollbar of 17 px.
		for (const width of [263, 280, 320, 1280]) {
			const page = await openPairingPage({ width });
			const font = await advances(page);
			expect(font.font).not.toBe("");
			expect(font.worst).toBeLessThan(0.5);
			// Four letters: no dash typed, and no box of the second group used.
			await typeKeys(page, "nhnx");
			let g = await geometry(page);
			expect(g.offsets).toHaveLength(4);
			for (const o of g.offsets) expect(Math.abs(o)).toBeLessThan(1);
			expect(g.overflow).toBe(false);
			// Eight letters: the dash is there.
			await typeKeys(page, "mnmh");
			expect((await field(page)).value).toBe("NHNX-MNMH");
			g = await geometry(page);
			expect(g.offsets).toHaveLength(8);
			for (const o of g.offsets) expect(Math.abs(o)).toBeLessThan(1);
			expect(Math.abs(g.dash)).toBeLessThan(1);
			expect(g.overflow).toBe(false);
			expect(g.rowRight).toBeLessThanOrEqual(g.viewport);
			// Roomier than the letters: a box is at least twice a letter wide.
			expect(g.boxWidth).toBeGreaterThanOrEqual(g.letterWidth * 2);
			expect(await fits(page)).toEqual({
				scroll: true,
				inView: true,
				page: true,
			});
			await page.close();
		}
	});

	test("the highlighted box follows the caret at the start, in front of the dash and at the end", async () => {
		const page = await openPairingPage();
		await typeKeys(page, "nhnxmnmh");
		for (const [caret, box] of [
			[0, 0],
			[4, 5],
			[8, 8],
			[9, 8],
		] as const) {
			await caretAt(page, caret);
			await atIs(page, [box]);
		}
		await page.close();
	});
});
