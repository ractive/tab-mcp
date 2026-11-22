/**
 * The rest of Firefox (iteration 50, task 7): only in the full browser run
 * (browser-full.yml: nightly, on demand, on changes to main, and on pull
 * requests that change the workflows) and locally with
 * `bun run test:browser firefox`. The event page outlasting Firefox's idle
 * timeout: two waits of 10 s, a Firefox lifetime that only changes with the
 * extension. No pull request runs it, on purpose (review of PR 220): the
 * full run starts on every push to main that touches the extension and opens
 * an issue within minutes when it fails; 20 s on every pull request is not
 * worth that earlier warning.
 *
 * Needs Firefox 140 or newer, as firefox-smoke.browser.test.ts.
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
import { findFirefox } from "./firefox.ts";
import { call, type Stack, start, useFirefox } from "./firefox-e2e.ts";

setDefaultTimeout(30_000);

const firefoxOk = useFirefox(browserTests ? findFirefox() : undefined);

describe.skipIf(!firefoxOk)(
	"the event page (Firefox has no extension service workers)",
	() => {
		let stack: Stack;

		beforeAll(async () => {
			// Firefox stops an idle event page after 30 s; here after 3 s.
			stack = await start("webmcp.html", {
				"extensions.background.idle.timeout": 3_000,
			});
		}, 90_000);

		afterAll(async () => {
			await stack?.client.close();
			await stack?.stop();
		});

		test("with the panel open, the connection outlasts the idle timeout", async () => {
			await Bun.sleep(10_000);
			const result = await call(stack, "page_info");
			expect(result.structuredContent?.["webmcp"]).toMatchObject({ tools: 5 });
		}, 30_000);

		test("with the panel closed too", async () => {
			await stack.panel.eval("window.close()").catch(() => {});
			await Bun.sleep(10_000);
			const result = await call(stack, "page_info");
			expect(result.structuredContent?.["webmcp"]).toMatchObject({ tools: 5 });
		}, 30_000);
	},
);
