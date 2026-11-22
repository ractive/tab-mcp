/**
 * The rest of the Firefox fill tests (iteration 50, task 7): only in the
 * full browser run (browser-full.yml) and locally with `bun run
 * test:browser firefox`. Always allow (DEC-213) repeats in Firefox the
 * Chrome test of shared code (fill.ts, fill.browser.test.ts). It starts
 * with filling in turned on, as the smoke's first test leaves it.
 * Harness: firefox-fill.ts.
 *
 * Needs Firefox 128 or newer, as firefox-fill-smoke.browser.test.ts.
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
	fillOn,
	questionCount,
	startFill,
	useFirefox,
} from "./firefox-fill.ts";
import { ALWAYS_CLIENT_NAME, authorizeUrl, type OAuthStack } from "./oauth.ts";

setDefaultTimeout(60_000);

const firefoxOk = useFirefox(browserTests ? findFirefox() : undefined);

describe.skipIf(!firefoxOk)(
	"filling in the code on the relay's page (the Firefox test build), the full run",
	() => {
		let stack: FillStack;
		let oauth: OAuthStack;
		let firefox: Firefox;
		let panel: Tab;
		let address: string;

		beforeAll(async () => {
			stack = await startFill();
			({ oauth, firefox, panel, address } = stack);
			await fillOn(panel);
		}, 90_000);

		afterAll(async () => {
			await stack?.stop();
		});

		test("Always allow (DEC-213): the same host's next page is filled in without a question, with the panel's line; removed, it asks again", async () => {
			const host = oauth.alwaysHost;
			const first = await authorizeUrl(oauth, address, oauth.alwaysClientId);
			let callback = oauth.nextCallback();
			const firstTab = await firefox.newTab(first.url, "window");
			await panel.waitFor(questionCount(1), 15_000);
			const buttons = `[...[...document.querySelectorAll("[data-question]")].at(-1).querySelectorAll("button")].map((b) => b.textContent)`;
			expect(await panel.eval<string[]>(buttons)).toEqual([
				"Don't allow",
				"Allow once",
				"Always allow",
			]);
			const always = `[...document.querySelectorAll('[data-question] button[data-answer="site"]')].at(-1)`;
			await panel.waitFor(
				`(void chrome.windows.getCurrent().then((w) => chrome.windows.update(w.id, { focused: true })), ${always} && ${always}.getAttribute("aria-disabled") !== "true")`,
				10_000,
			);
			await panel.eval(`${always}.click()`);
			expect((await callback).get("code")).toBeString();
			await firstTab.close().catch(() => {});
			await panel.waitFor(questionCount(0));
			expect(
				await panel.eval<string[]>(
					`[...document.querySelectorAll("#fill-always-list .always-host")].map((e) => e.textContent)`,
				),
			).toEqual([host]);

			const second = await authorizeUrl(oauth, address, oauth.alwaysClientId);
			callback = oauth.nextCallback();
			const secondTab = await firefox.newTab(second.url, "window");
			expect((await callback).get("code")).toBeString();
			expect(await panel.eval(questionCount(0))).toBe(true);
			expect(
				await panel.waitFor<string>(
					`!document.getElementById("fill-notice").hidden && document.getElementById("fill-notice").textContent`,
				),
			).toBe(`Filled in the code for ${ALWAYS_CLIENT_NAME} (${host}).`);
			await secondTab.close().catch(() => {});

			// Removed under the switch: the next page asks.
			await panel.eval(
				`document.querySelector('#fill-always-list button[data-host="${host}"]').click()`,
			);
			await panel.waitFor(`document.getElementById("fill-always").hidden`);
			const third = await authorizeUrl(oauth, address, oauth.alwaysClientId);
			const thirdTab = await firefox.newTab(third.url, "window");
			await panel.waitFor(questionCount(1), 15_000);
			await thirdTab.close();
			await panel.waitFor(questionCount(0), 15_000);
		});
	},
);
