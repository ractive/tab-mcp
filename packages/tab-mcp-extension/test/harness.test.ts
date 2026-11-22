/**
 * The extension's browser harness itself (as `test/webmcp-spike/browser.test.ts`
 * for the spike's). An out-of-process frame (site isolation) gets a session
 * of its own, attached without anyone awaiting it: when the frame goes away
 * while that attach is on its way (the browser or the page closed, the frame
 * removed), nothing is left unhandled; an attach that fails otherwise still
 * shows. Bun fails a test with an unhandled rejection in it. Needs a Chrome
 * for Testing (`CHROME_PATH`, or Puppeteer's or Playwright's cache):
 * required in CI, skipped elsewhere without it.
 */
import { expect, test } from "bun:test";
import { join } from "node:path";
import {
	Browser,
	findChromeForTesting,
	type Page,
	type Served,
} from "./browser.ts";

const chrome = findChromeForTesting();
if (chrome === undefined && process.env["CI"])
	throw new Error("Chrome for Testing is needed for the harness test in CI");

const SITE = "https://site.test";
const FRAME = "https://frame.test";

function serve(url: string): Served {
	return {
		status: 200,
		headers: { "content-type": "text/html; charset=utf-8" },
		body:
			new URL(url).origin === FRAME
				? "<p>frame</p>"
				: `<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>`,
	};
}

/** Call `then` as soon as a frame's session comes, its attach just begun. */
function onFrameAttached(browser: Browser, then: () => unknown): Promise<void> {
	return new Promise((resolve) => {
		const off = browser.on((method, params) => {
			const type = (params["targetInfo"] as { type?: string } | undefined)
				?.type;
			if (method !== "Target.attachedToTarget" || type !== "iframe") return;
			off();
			resolve(Promise.resolve(then()).then(() => {}));
		});
	});
}

async function withFrame(
	whenAttached: (browser: Browser, page: Page) => unknown,
): Promise<void> {
	const browser = await Browser.launch(chrome as string, { serve });
	try {
		const page = await browser.newPage(`${SITE}/`);
		// The page's own listener comes first, so the attach has begun.
		const done = onFrameAttached(browser, () => whenAttached(browser, page));
		await page.eval(
			`document.body.append(Object.assign(document.createElement("iframe"), { src: "${FRAME}/" }))`,
		);
		await done;
		// A rejection is reported a task or more later: let it come.
		await Bun.sleep(300);
	} finally {
		if (!browser.closed) await browser.close();
	}
}

test.skipIf(chrome === undefined)(
	"the browser closed while a frame is attached: nothing unhandled",
	() => withFrame((browser) => browser.close()),
	30_000,
);

test.skipIf(chrome === undefined)(
	"the page closed while a frame is attached: nothing unhandled",
	() => withFrame((_, page) => page.close()),
	30_000,
);

test.skipIf(chrome === undefined)(
	"a frame removed while it is attached: nothing unhandled",
	() =>
		withFrame((_, page) =>
			page.eval(`document.querySelector("iframe").remove()`),
		),
	30_000,
);

test("an attach that fails otherwise is thrown on, unhandled", async () => {
	// A browser that answers the page and fails the frame: in a process of its
	// own, as the unhandled rejection would fail this test.
	const script = `
		import { Page } from ${JSON.stringify(join(import.meta.dir, "browser.ts"))};
		let listener;
		const browser = {
			closed: false,
			on: (l) => { listener = l; return () => {}; },
			send: (method, params, session) =>
				session === "frame" ? Promise.reject(new Error("attach failed")) : Promise.resolve({}),
		};
		const page = new Page(browser, "page", "target", false);
		await page.attached("page");
		listener("Target.attachedToTarget", { sessionId: "frame" }, "page");
		await Bun.sleep(50);
	`;
	const proc = Bun.spawn([process.execPath, "-e", script], {
		stdout: "ignore",
		stderr: "pipe",
	});
	const [code, stderr] = await Promise.all([
		proc.exited,
		new Response(proc.stderr).text(),
	]);
	expect(code).not.toBe(0);
	expect(stderr).toContain("attach failed");
});
