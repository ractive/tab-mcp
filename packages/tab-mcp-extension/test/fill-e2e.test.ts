/**
 * End to end, filling in the code on the relay's pairing page (DEC-203): the
 * test build in Chrome for Testing, connected to a relay in this process,
 * and an AI app (the MCP SDK's client) whose `/authorize` page opens in that
 * Chrome (`oauth.ts`). The pages come from the network (the relay, a
 * look-alike on another port of 127.0.0.1, the AI app's callback), not
 * through the DevTools Protocol: the form posts with a body.
 *
 * The test build has host access to every site at install, so the pairing
 * page's script is registered at once. Chrome's prompt for access to the
 * relay's site alone ("Fill in the code for me") cannot be answered from
 * here and is not tested end to end.
 *
 * Needs Chrome for Testing 156 or newer, as `e2e.test.ts`.
 */

import {
	afterAll,
	beforeAll,
	describe,
	expect,
	setDefaultTimeout,
	test,
} from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "../scripts/build.ts";
import {
	Browser,
	chromeMajor,
	findChromeForTesting,
	type Page,
} from "./browser.ts";
import {
	authorizeUrl,
	CLIENT_NAME,
	type OAuthStack,
	startOAuth,
	toolsAfter,
} from "./oauth.ts";

setDefaultTimeout(60_000);

const found = findChromeForTesting();
const chrome =
	found !== undefined && chromeMajor(found) >= 156 ? found : undefined;
if (chrome === undefined && process.env["CI"])
	throw new Error(
		"Chrome for Testing 156 or newer is needed for the extension's end-to-end tests in CI",
	);

interface Stack {
	oauth: OAuthStack;
	browser: Browser;
	panel: Page;
	address: string;
	stop(): Promise<void>;
}

/** Chrome with the test build, its panel open, set to the relay and connected. */
async function start(): Promise<Stack> {
	const dir = mkdtempSync(join(tmpdir(), "tab-mcp-fill-"));
	const oauth = await startOAuth("tab-mcp-extension");
	let browser: Browser | undefined;
	const stop = async () => {
		await browser?.close();
		await oauth.stop();
		rmSync(dir, { recursive: true, force: true });
	};
	try {
		const outdir = join(dir, "dist");
		await build({ outdir, test: true, minify: false });
		browser = await Browser.launch(chrome as string, { extension: outdir });
		const tab = await browser.newPage(oauth.blank);
		await browser.clickIcon(tab);
		const id = browser.extensionId;
		const panel = await browser.attach(
			(
				await browser.waitForTarget(
					(t) => t.url === `chrome-extension://${id}/sidepanel/index.html`,
				)
			).targetId,
		);
		await panel.waitFor(`document.getElementById("relay").value !== ""`);
		// Not clicked while Chrome has yet to size the panel (0×0): lost.
		await panel.waitFor(`innerWidth > 0 && innerHeight > 0`);
		const relay = oauth.relay.url;
		await panel.eval(`document.querySelector("details.settings").open = true`);
		await panel.eval(`(() => {
			document.getElementById("relay").value = ${JSON.stringify(relay)};
			document.getElementById("relay-form").requestSubmit();
			document.getElementById("relay").value = "";
		})()`);
		await panel.waitFor(
			`document.getElementById("relay").value === ${JSON.stringify(relay)}`,
		);
		await panel.click("#connect");
		const address = await panel.waitFor<string>(
			`document.getElementById("address").textContent`,
			15_000,
		);
		return { oauth, browser, panel, address, stop };
	} catch (error) {
		await stop();
		throw error;
	}
}

/** The panel's question cards, as text. */
const questions = (stack: Stack) =>
	stack.panel.eval<string[]>(
		`[...document.querySelectorAll("[data-question]")].map((c) => c.textContent)`,
	);

const questionCount = (n: number) =>
	`document.querySelectorAll("[data-question]").length === ${n}`;

/** Answer the newest question in the side panel. */
async function answer(stack: Stack, value: "allow" | "deny"): Promise<void> {
	// Allow counts only once the panel has been focused a while.
	await stack.panel.send("Emulation.setFocusEmulationEnabled", {
		enabled: true,
	});
	const selector = `[...document.querySelectorAll('[data-question] button[data-answer="${value}"]')].at(-1)`;
	await stack.panel.waitFor(
		`${selector} && ${selector}.getAttribute("aria-disabled") !== "true"`,
	);
	await stack.panel.eval(`${selector}.id = "e2e-answer"`);
	await stack.panel.click("#e2e-answer");
	await stack.panel.eval(
		`document.getElementById("e2e-answer")?.removeAttribute("id")`,
	);
}

/** Whether the "Fill in the code for me" switch is there, on, and says so. */
const fillSwitch = (stack: Stack) =>
	stack.panel.eval<[boolean, boolean, string | null]>(
		`[!document.getElementById("fill-label").hidden, document.getElementById("fill-switch").checked, document.getElementById("fill-switch").getAttribute("aria-checked")]`,
	);

/** The pairing page's script ran in `page` (its flag in the extension's world). */
async function scriptRan(page: Page): Promise<boolean> {
	const world = await page.isolatedWorld("tab-mcp browser extension");
	return page.eval<boolean>(`globalThis.__tabMcpPairingPage === true`, world);
}

describe.skipIf(chrome === undefined)(
	"filling in the code on the relay's page (the test build)",
	() => {
		let stack: Stack;
		beforeAll(async () => {
			stack = await start();
		});
		afterAll(async () => {
			await stack?.stop();
		});

		test("off by default, also with access to all sites: no question; Fill in the code for me turns it on", async () => {
			const host = new URL(stack.oauth.relay.url).host;
			// The test build has access to all sites: Chrome asks nothing, and
			// the line is the same with the switch off and on.
			expect(
				await stack.panel.waitFor<string>(
					`!document.getElementById("fill").hidden && document.getElementById("fill-text").textContent`,
				),
			).toBe(
				`While this is on, tab-mcp asks you and fills in the code when an AI app opens the sign-in page of ${host} in this Chrome profile.`,
			);
			expect(await fillSwitch(stack)).toEqual([true, false, "false"]);
			// Off: the relay's page has no script of it, and asks nothing.
			const { url } = await authorizeUrl(stack.oauth, stack.address);
			const page = await stack.browser.newPage(url);
			expect(await scriptRan(page)).toBe(false);
			await Bun.sleep(1_000);
			expect(await questions(stack)).toEqual([]);
			await page.close();
			// A real click: `permissions.request` needs the user's gesture.
			await stack.panel.click("#fill-switch");
			expect(await fillSwitch(stack)).toEqual([true, true, "true"]);
			// The worker took it: the script is registered (on the look-alike,
			// which it refuses, so no question).
			const end = Date.now() + 5_000;
			for (;;) {
				const page = await stack.browser.newPage(stack.oauth.lookAlike);
				const ran = await scriptRan(page);
				await page.close();
				if (ran) break;
				if (Date.now() > end) throw new Error("the script was not registered");
				await Bun.sleep(200);
			}
			expect(await fillSwitch(stack)).toEqual([true, true, "true"]);
		});

		test("a look-alike of the page on another origin is ignored: no question", async () => {
			const page = await stack.browser.newPage(stack.oauth.lookAlike);
			// The script runs there (its pattern has no port), and the worker
			// refuses the origin.
			expect(await scriptRan(page)).toBe(true);
			await Bun.sleep(1_500);
			expect(await questions(stack)).toEqual([]);
			expect(
				await page.eval<string>(`document.getElementById("code").value`),
			).toBe("");
			await page.close();
		});

		test("the page going withdraws the question", async () => {
			const { url } = await authorizeUrl(stack.oauth, stack.address);
			const page = await stack.browser.newPage(url);
			await stack.panel.waitFor(questionCount(1));
			await page.close();
			await stack.panel.waitFor(questionCount(0));
		});

		test("Don't allow fills in nothing, and typing the code by hand pairs as before", async () => {
			const { url, provider, transport } = await authorizeUrl(
				stack.oauth,
				stack.address,
			);
			const page = await stack.browser.newPage(url);
			await stack.panel.waitFor(questionCount(1));
			const [card] = await questions(stack);
			const host = new URL(stack.oauth.cimd.origin).host;
			expect(card).toContain(
				`Connect ${CLIENT_NAME} (${host}) to the tab-mcp browser extension?`,
			);
			expect(card).toContain(`AI app at (verified) ${host}`);
			await answer(stack, "deny");
			await stack.panel.waitFor(questionCount(0));
			await Bun.sleep(500);
			expect(
				await page.eval<string>(`document.getElementById("code").value`),
			).toBe("");
			// By hand: the letters from the panel (the relay takes them with
			// or without the dash), typed and sent.
			const code = await stack.panel.waitFor<string>(
				`(() => { const c = (document.getElementById("code").textContent ?? "").replace(/[^A-Z]/g, ""); return c.length === 8 && c; })()`,
			);
			await page.eval(`document.getElementById("code").focus()`);
			await page.send("Input.insertText", { text: code });
			const callback = stack.oauth.nextCallback();
			await page.click('button[value="connect"]');
			await transport.finishAuth(await callback);
			expect(provider.tokens()?.access_token).toBeString();
			await page.close();
		});

		test("Allow fills in the code and the AI app is paired, also with the pairing view closed", async () => {
			// One app is paired now: the panel shows no code, so the worker
			// starts pairing for the fill itself.
			await stack.panel.waitFor(
				`document.getElementById("pairing").hidden === true`,
			);
			const { url, provider } = await authorizeUrl(stack.oauth, stack.address);
			const callback = stack.oauth.nextCallback();
			const page = await stack.browser.newPage(url);
			await stack.panel.waitFor(questionCount(1));
			await answer(stack, "allow");
			const params = await callback;
			expect(params.get("state")).toBe("fill-state");
			expect(await toolsAfter(stack.address, provider, params)).toContain(
				"page_info",
			);
			await page.close().catch(() => {});
			// The panel lists both AI apps.
			await stack.panel.waitFor(
				`document.querySelectorAll("#grants li").length === 2`,
			);
		});

		test("with AI access off, the page gets no question", async () => {
			await stack.panel.eval(`document.getElementById("ai-switch").click()`);
			await stack.panel.waitFor(
				`document.getElementById("state").dataset.state === "off"`,
			);
			const { url } = await authorizeUrl(stack.oauth, stack.address);
			const page = await stack.browser.newPage(url);
			expect(await scriptRan(page)).toBe(true);
			await Bun.sleep(1_500);
			expect(await questions(stack)).toEqual([]);
			await page.close();
		});

		test("turning AI access off withdraws a question that waits", async () => {
			await stack.panel.eval(`document.getElementById("ai-switch").click()`);
			await stack.panel.waitFor(
				`document.getElementById("state").dataset.state === "on"`,
				15_000,
			);
			const { url } = await authorizeUrl(stack.oauth, stack.address);
			const page = await stack.browser.newPage(url);
			await stack.panel.waitFor(questionCount(1));
			await stack.panel.eval(`document.getElementById("ai-switch").click()`);
			await stack.panel.waitFor(questionCount(0));
			await page.close();
		});

		test("the switch turned off: off again, the page has no script and asks nothing", async () => {
			await stack.panel.eval(`document.getElementById("ai-switch").click()`);
			await stack.panel.waitFor(
				`document.getElementById("state").dataset.state === "on"`,
				15_000,
			);
			await stack.panel.eval(`document.getElementById("add-app").click()`);
			await stack.panel.waitFor(
				`document.getElementById("pairing").hidden === false`,
			);
			expect(await fillSwitch(stack)).toEqual([true, true, "true"]);
			await stack.panel.click("#fill-switch");
			expect(await fillSwitch(stack)).toEqual([true, false, "false"]);
			const { url } = await authorizeUrl(stack.oauth, stack.address);
			// The unregistration may still be on its way: a page after it.
			const end = Date.now() + 5_000;
			for (;;) {
				const page = await stack.browser.newPage(url);
				const ran = await scriptRan(page);
				if (!ran) {
					await Bun.sleep(1_000);
					expect(await questions(stack)).toEqual([]);
					await page.close();
					break;
				}
				await page.close();
				if (Date.now() > end) throw new Error("the script stayed registered");
				await Bun.sleep(200);
			}
		});
	},
);
