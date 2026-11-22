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
