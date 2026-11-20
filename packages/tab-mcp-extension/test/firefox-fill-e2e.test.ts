/**
 * End to end in Firefox, filling in the code on the relay's pairing page
 * (DEC-203): the Firefox test build (host access to every site at install)
 * as a temporary add-on over WebDriver BiDi, its panel in a tab, connected
 * to a relay in this process, and an AI app whose `/authorize` page opens in
 * that Firefox (`oauth.ts`). Firefox's port senders carry no `origin`: the
 * address decides there.
 *
 * Needs Firefox 128 or newer, as `firefox-e2e.test.ts`; skipped without it.
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
import { build, FIREFOX_ID } from "../scripts/build.ts";
import { Firefox, findFirefox, firefoxMajor, Tab } from "./firefox.ts";
import {
	authorizeUrl,
	type OAuthStack,
	startOAuth,
	toolsAfter,
} from "./oauth.ts";

setDefaultTimeout(60_000);

const binary = findFirefox();
const firefoxOk = binary !== undefined && firefoxMajor(binary) >= 128;

/** The add-on's UUID in the test profile, so the panel's address is known. */
const UUID = "5b2e7d14-8c3a-4f6e-a1d9-0e7c3b5a9f21";
const PANEL = `moz-extension://${UUID}/sidepanel/index.html`;

const questionCount = (n: number) =>
	`document.querySelectorAll("[data-question]").length === ${n}`;

describe.skipIf(!firefoxOk)(
	"filling in the code on the relay's page (the Firefox test build)",
	() => {
		let oauth: OAuthStack;
		let firefox: Firefox;
		let panel: Tab;
		let address: string;
		let dir: string;

		beforeAll(async () => {
			dir = mkdtempSync(join(tmpdir(), "tab-mcp-firefox-fill-"));
			oauth = await startOAuth("tab-mcp-extension-firefox");
			const outdir = join(dir, "dist");
			await build({ outdir, firefox: true, test: true, minify: false });
			firefox = await Firefox.launch(binary as string, {
				prefs: {
					"extensions.webextensions.uuids": JSON.stringify({
						[FIREFOX_ID]: UUID,
					}),
				},
			});
			expect(await firefox.installExtension(outdir)).toBe(FIREFOX_ID);
			const end = Date.now() + 15_000;
			for (;;) {
				const found = (await firefox.tabs()).find((t) => t.url === PANEL);
				if (found) {
					panel = new Tab(firefox, found.context);
					break;
				}
				if (Date.now() > end) throw new Error("the panel did not open");
				await Bun.sleep(100);
			}
			const relay = oauth.relay.url;
			await panel.waitFor(`document.getElementById("relay")?.value !== ""`);
			await panel.eval(`(() => {
				document.querySelector("details.settings").open = true;
				document.getElementById("relay").value = ${JSON.stringify(relay)};
				document.getElementById("relay-form").requestSubmit();
				document.getElementById("relay").value = "";
			})()`);
			await panel.waitFor(
				`document.getElementById("relay").value === ${JSON.stringify(relay)}`,
			);
			await panel.eval(`document.getElementById("connect").click()`);
			address = await panel.waitFor<string>(
				`document.getElementById("address").textContent`,
				15_000,
			);
		}, 90_000);

		afterAll(async () => {
			await firefox?.close();
			await oauth?.stop();
			rmSync(dir, { recursive: true, force: true });
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
			// window forward (as in firefox-e2e.test.ts).
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
