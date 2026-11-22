/**
 * The Firefox fill smoke (iteration 50, task 7), on every pull request:
 * filling in the code on the relay's pairing page (DEC-203) where Firefox
 * differs. Its gesture rule for `permissions.request` (a real click), and
 * its port senders without `origin`, so that the address decides who may
 * speak for the page. Always allow repeats the Chrome test on shared code:
 * firefox-fill-full.browser.test.ts. Harness: firefox-fill.ts.
 *
 * Needs Firefox 140 or newer: required in CI, skipped elsewhere without it.
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
import { type Firefox, findFirefox, type Tab } from "./firefox.ts";
import {
	type FillStack,
	questionCount,
	startFill,
	useFirefox,
} from "./firefox-fill.ts";
import { authorizeUrl, type OAuthStack, toolsAfter } from "./oauth.ts";

setDefaultTimeout(60_000);

const firefoxOk = useFirefox(browserTests ? findFirefox() : undefined);

describe.skipIf(!firefoxOk)(
	"filling in the code on the relay's page (the Firefox test build)",
	() => {
		let stack: FillStack;
		let oauth: OAuthStack;
		let firefox: Firefox;
		let panel: Tab;
		let address: string;

		beforeAll(async () => {
			stack = await startFill();
			({ oauth, firefox, panel, address } = stack);
		}, 90_000);

		afterAll(async () => {
			await stack?.stop();
		});

		test("off by default; a real click on the Fill in the code for me switch turns it on", async () => {
			const fillSwitch = `document.getElementById("fill-switch")`;
			await panel.waitFor(
				`!document.getElementById("fill-label").hidden && !${fillSwitch}.checked`,
			);
			await panel.click("#fill-switch");
			await panel.waitFor(
				`${fillSwitch}.checked && ${fillSwitch}.getAttribute("aria-checked") === "true"`,
			);
			// It stays on: the permission was given and the worker took it.
			await Bun.sleep(500);
			expect(await panel.eval(`${fillSwitch}.checked`)).toBe(true);
		});

		test("a look-alike on another origin gets no question; the relay's page, Allow fills in the code and pairs", async () => {
			const fake = await firefox.newTab(oauth.lookAlike, "window");
			await Bun.sleep(1_500);
			expect(await panel.eval(questionCount(0))).toBe(true);
			await fake.close();

			const { url, provider } = await authorizeUrl(oauth, address);
			const callback = oauth.nextCallback();
			// In a window of its own: the panel's tab stays in front in the first.
			await firefox.newTab(url, "window");
			await panel.waitFor(questionCount(1), 15_000);
			const allow = `[...document.querySelectorAll('[data-question] button[data-answer="allow"]')].at(-1)`;
			// Allow counts once the panel has been in front a while; BiDi
			// cannot activate an extension's page, the panel brings its own
			// window forward (as in firefox.browser.test.ts).
			await panel.waitFor(
				`(void chrome.windows.getCurrent().then((w) => chrome.windows.update(w.id, { focused: true })), ${allow} && ${allow}.getAttribute("aria-disabled") !== "true")`,
				10_000,
			);
			await panel.eval(`${allow}.click()`);
			const params = await callback;
			expect(await toolsAfter(address, provider, params)).toContain(
				"page_info",
			);
		});
	},
);
