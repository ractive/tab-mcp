/**
 * The harness of the Firefox fill tests (DEC-203), for
 * firefox-fill-smoke.browser.test.ts and firefox-fill-full.browser.test.ts:
 * the Firefox test build (host access to every site at install) as a
 * temporary add-on over WebDriver BiDi, its panel in a tab, connected to a
 * relay in this process, and an AI app whose `/authorize` page opens in that
 * Firefox (`oauth.ts`). Firefox's port senders carry no `origin`: the
 * address decides there.
 */

import { expect } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { browserTempDir } from "../../../test/browser-dirs.ts";
import { browserTests } from "../../../test/browser-gate.ts";
import { build, FIREFOX_ID } from "../scripts/build.ts";
import { Firefox, firefoxMajor, Tab } from "./firefox.ts";
import { type OAuthStack, startOAuth } from "./oauth.ts";

let binary: string | undefined;

/**
 * The Firefox `startFill` launches: `found`, the test file's own
 * `findFirefox()` (scripts/test-browser.ts reads which browsers a file
 * needs from its calls), if it is 128 or newer. Whether the tests run.
 */
export function useFirefox(found: string | undefined): boolean {
	const ok = found !== undefined && firefoxMajor(found) >= 128;
	if (browserTests && !ok && process.env["CI"])
		throw new Error(
			"Firefox 128 or newer is needed for the extension's Firefox fill test in CI",
		);
	binary = ok ? found : undefined;
	return ok;
}

/** The add-on's UUID in the test profile, so the panel's address is known. */
const UUID = "5b2e7d14-8c3a-4f6e-a1d9-0e7c3b5a9f21";
const PANEL = `moz-extension://${UUID}/sidepanel/index.html`;

export const questionCount = (n: number) =>
	`document.querySelectorAll("[data-question]").length === ${n}`;

export interface FillStack {
	oauth: OAuthStack;
	firefox: Firefox;
	panel: Tab;
	address: string;
	stop(): Promise<void>;
}

/** Firefox with the test build, its panel set to a relay with OAuth and connected. */
export async function startFill(): Promise<FillStack> {
	const dir = browserTempDir("firefox-fill-build-");
	const oauth = await startOAuth("tab-mcp-extension-firefox");
	let firefox: Firefox | undefined;
	const stop = async () => {
		await firefox?.close();
		await oauth.stop();
		rmSync(dir, { recursive: true, force: true });
	};
	try {
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
		let panel: Tab | undefined;
		const end = Date.now() + 15_000;
		while (panel === undefined) {
			const found = (await firefox.tabs()).find((t) => t.url === PANEL);
			if (found) panel = new Tab(firefox, found.context);
			else if (Date.now() > end) throw new Error("the panel did not open");
			else await Bun.sleep(100);
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
		const address = await panel.waitFor<string>(
			`document.getElementById("address").textContent`,
			15_000,
		);
		return { oauth, firefox, panel, address, stop };
	} catch (error) {
		await stop();
		throw error;
	}
}

/**
 * "Fill in the code for me" turned on by a real click (Firefox's gesture
 * rule for `permissions.request`), and still on once the worker took it:
 * the smoke's first test does it with its checks, the full run's tests
 * start from it.
 */
export async function fillOn(panel: Tab): Promise<void> {
	const fillSwitch = `document.getElementById("fill-switch")`;
	await panel.waitFor(
		`!document.getElementById("fill-label").hidden && !${fillSwitch}.checked`,
	);
	await panel.click("#fill-switch");
	await panel.waitFor(
		`${fillSwitch}.checked && ${fillSwitch}.getAttribute("aria-checked") === "true"`,
	);
}
