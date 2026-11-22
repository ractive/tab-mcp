/**
 * The harness itself. An out-of-process frame (site isolation) gets a session
 * of its own, attached without anyone awaiting it: when the frame goes away
 * while that attach is on its way (the browser or the page closed, the frame
 * removed), nothing is left unhandled; an attach that fails otherwise still
 * shows. Bun fails a test with an unhandled rejection in it. Needs a Chrome
 * for Testing (`CHROME_PATH`, or Puppeteer's or Playwright's cache):
 * required in CI, skipped elsewhere without it. The tests that need Chrome
 * run with `bun run test:browser` only (test/browser-gate.ts).
 */
import { expect, test } from "bun:test";
import { join } from "node:path";
import { browserTests } from "../browser-gate.ts";
import {
	Browser,
	findChromeForTesting,
	type Page,
	profilePattern,
	type Served,
} from "./browser.ts";

const chrome = browserTests ? findChromeForTesting() : undefined;
if (browserTests && chrome === undefined && process.env["CI"])
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

/**
 * Hold every command for the page's frames (any session but the page's own)
 * until `release()`, and count those Chrome fails then: the frame's attach
 * is still on its way when the frame goes away, whatever the timing.
 */
function holdFrames(browser: Browser, page: Page) {
	const send = browser.send.bind(browser);
	let release = () => {};
	const released = new Promise<void>((resolve) => {
		release = resolve;
	});
	const held = { failed: 0, release };
	browser.send = async (
		method: string,
		params: Record<string, unknown> = {},
		sessionId?: string,
	) => {
		if (sessionId === undefined || sessionId === page.sessionId)
			return send(method, params, sessionId);
		await released;
		return send(method, params, sessionId).catch((error: unknown) => {
			held.failed++;
			throw error;
		});
	};
	return held;
}

/** The session of the next frame that attaches. */
function frameAttached(browser: Browser): Promise<string> {
	return new Promise((resolve) => {
		const off = browser.on((method, params) => {
			const type = (params["targetInfo"] as { type?: string } | undefined)
				?.type;
			if (method !== "Target.attachedToTarget" || type !== "iframe") return;
			off();
			resolve(params["sessionId"] as string);
		});
	});
}

/** Chrome reported `sessionId` detached. */
function detached(browser: Browser, sessionId: string): Promise<void> {
	return new Promise((resolve) => {
		const off = browser.on((method, params) => {
			if (method !== "Target.detachedFromTarget") return;
			if (params["sessionId"] !== sessionId) return;
			off();
			resolve();
		});
	});
}

/**
 * Add a frame on another site to a page, and make it go away (`goAway`)
 * while its attach is on its way.
 */
async function withFrame(
	goAway: (browser: Browser, page: Page) => unknown,
): Promise<{ failed: number }> {
	const browser = await Browser.launch(chrome as string, { serve });
	try {
		const page = await browser.newPage(`${SITE}/`);
		const held = holdFrames(browser, page);
		const attached = frameAttached(browser);
		await page.eval(
			`document.body.append(Object.assign(document.createElement("iframe"), { src: "${FRAME}/" }))`,
		);
		const frame = await attached;
		const gone = detached(browser, frame);
		await goAway(browser, page);
		// Gone: Chrome says so (or 5 s pass; then the count below tells).
		await Promise.race([gone, Bun.sleep(5_000)]);
		// Only now do the frame's commands reach Chrome.
		held.release();
		// A rejection is reported a task or more later: let it come.
		await Bun.sleep(300);
		return { failed: held.failed };
	} finally {
		if (!browser.closed) await browser.close();
	}
}

test.skipIf(chrome === undefined)(
	"the browser closed while a frame is attached: nothing unhandled",
	async () => {
		const browser = await Browser.launch(chrome as string, { serve });
		try {
			const page = await browser.newPage(`${SITE}/`);
			// The page's own listener comes first: the attach has begun, and the
			// connection closes under it.
			const closing = frameAttached(browser).then(() => browser.close());
			await page
				.eval(
					`document.body.append(Object.assign(document.createElement("iframe"), { src: "${FRAME}/" }))`,
				)
				.catch(() => {});
			await closing;
			await Bun.sleep(300);
		} finally {
			if (!browser.closed) await browser.close();
		}
	},
	30_000,
);

test.skipIf(chrome === undefined)(
	"the page closed while a frame is attached: nothing unhandled",
	async () => {
		const { failed } = await withFrame((_, page) => page.close());
		expect(failed).toBeGreaterThan(0);
	},
	30_000,
);

test.skipIf(chrome === undefined)(
	"a frame removed while it is attached: nothing unhandled",
	async () => {
		const { failed } = await withFrame((_, page) =>
			page.eval(`document.querySelector("iframe").remove()`),
		);
		expect(failed).toBeGreaterThan(0);
	},
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
		const page = new Page(browser, "page", "target");
		await page.attached("page");
		listener("Target.attachedToTarget", { sessionId: "frame" }, "page");
		await Bun.sleep(500);
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

test("reap's pattern matches only the profile's own Chrome", async () => {
	// Stand-ins for Chromes, as pgrep sees them: the profile's own, one whose
	// profile only starts the same, one that names it in another argument.
	// A dot, to check that it stands for itself.
	const profile = `/tmp/reap-check-${process.pid}/webmcp-spike-a.b`;
	const args = [
		[`--user-data-dir=${profile}`, "--type=renderer"],
		[`--user-data-dir=${profile}x`],
		[`--user-data-dir=/tmp/reap-check-${process.pid}/webmcp-spike-aXb`],
		["--user-data-dir=/tmp/other", `--note=${profile}`],
	];
	const procs = args.map((a) =>
		Bun.spawn([process.execPath, "-e", "await Bun.sleep(30_000)", ...a], {
			stdout: "ignore",
			stderr: "ignore",
		}),
	);
	try {
		await Bun.sleep(300);
		const { stdout } = Bun.spawnSync(["pgrep", "-f", profilePattern(profile)]);
		const found = stdout
			.toString()
			.trim()
			.split("\n")
			.filter(Boolean)
			.map(Number);
		expect(found).toEqual(procs.slice(0, 1).map((p) => p.pid));
	} finally {
		for (const p of procs) p.kill("SIGKILL");
	}
});
