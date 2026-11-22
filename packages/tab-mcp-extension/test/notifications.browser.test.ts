/**
 * No notification of a test on the owner's desktop (iteration 50, DEC-220):
 * the test Chrome starts with `--disable-features=NativeNotifications`
 * (test/browsers.ts), so `chrome.notifications` works as ever (create, getAll,
 * clear) but macOS never gets the notification. macOS's notification daemon
 * logs every notification it delivers, with the extension's id and the
 * notification's id (`req:"r|Default|<extension>-<id>"`): after a question-like
 * notification of the test build, the log must not name it. macOS only, where
 * the owner's desktop is.
 *
 * What it can and cannot see: it has no positive control, because one would
 * put a notification on the owner's desktop at every run. So it passes too
 * when macOS would not show Chrome for Testing's notifications anyway (never
 * allowed in System Settings), when usernoted hides the request id
 * (`<private>`) or logs in another format, or when the log has no line for
 * it. On the machine of the experiment (kb/research/test-browser-notifications.md)
 * it fails if Chrome renames or drops the feature. The weight is carried
 * without a browser: scripts/browsers.test.ts fails when a Chrome launch list
 * lacks `chromeSwitches(…)`.
 *
 * Firefox's test build records its notifications instead of showing them
 * (src/worker/notifications.ts, read in firefox.browser.test.ts;
 * build.test.ts keeps it out of every other build).
 * Runs with `bun run test:browser` only (test/browser-gate.ts).
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { browserTempDir } from "../../../test/browser-dirs.ts";
import { browserTests } from "../../../test/browser-gate.ts";
import { build } from "../scripts/build.ts";
import {
	Browser,
	chromeMajor,
	findChromeForTesting,
	type Worker,
} from "./browser.ts";

const found = browserTests ? findChromeForTesting() : undefined;
const chrome =
	found !== undefined && chromeMajor(found) >= 156 ? found : undefined;
if (browserTests && chrome === undefined && process.env["CI"])
	throw new Error(
		"Chrome for Testing 156 or newer is needed for the notification test in CI",
	);
const onMac = process.platform === "darwin";

let dir: string;
let browser: Browser | undefined;
let worker: Worker;

beforeAll(async () => {
	if (chrome === undefined) return;
	dir = browserTempDir("notifications-build-");
	const outdir = join(dir, "dist");
	await build({ outdir, test: true, minify: false });
	browser = await Browser.launch(chrome, { extension: outdir });
	worker = await browser.serviceWorker(browser.extensionId as string);
}, 60_000);

afterAll(async () => {
	await browser?.close();
	if (dir) rmSync(dir, { recursive: true, force: true });
});

/** Create a question-like notification `id` in the worker, through the real API. */
const create = (id: string) =>
	worker.eval<string>(`chrome.notifications.create(${JSON.stringify(id)}, {
		type: "basic",
		iconUrl: chrome.runtime.getURL("icons/icon-128.png"),
		title: "tab-mcp test",
		message: "never on the desktop",
		buttons: [{ title: "Allow" }, { title: "Don't allow" }],
		requireInteraction: true,
		priority: 2,
	})`);
const listed = () =>
	worker.eval<string[]>(
		"chrome.notifications.getAll().then((all) => Object.keys(all))",
	);
const clear = (id: string) =>
	worker.eval<boolean>(`chrome.notifications.clear(${JSON.stringify(id)})`);

test.skipIf(chrome === undefined)(
	"with the switch, the real API creates, lists and clears a notification as before",
	async () => {
		const id = `api-${Date.now()}`;
		expect(await create(id)).toBe(id);
		expect(await listed()).toContain(id);
		expect(await clear(id)).toBe(true);
		expect(await listed()).not.toContain(id);
	},
	30_000,
);

test.skipIf(chrome === undefined || !onMac)(
	"a notification of the test build never reaches macOS",
	async () => {
		const id = `guard-${Date.now()}`;
		await create(id);
		expect(await listed()).toContain(id);
		// What macOS delivers shows within a second (it did in the experiment).
		await Bun.sleep(3_000);
		expect(await clear(id)).toBe(true);
		// The last minute only, and at most 15 s: past that the log could not
		// be read, which is no pass of the check.
		const log = Bun.spawn(
			[
				"/usr/bin/log",
				"show",
				"--last",
				"1m",
				"--predicate",
				'process == "usernoted"',
				"--style",
				"compact",
			],
			{ stdout: "pipe", stderr: "pipe" },
		);
		const timer = setTimeout(() => log.kill("SIGKILL"), 15_000);
		const [exit, out, err] = await Promise.all([
			log.exited,
			new Response(log.stdout).text(),
			new Response(log.stderr).text(),
		]);
		clearTimeout(timer);
		if (log.signalCode !== null)
			throw new Error(
				"could not check: macOS's log did not answer within 15 s, so whether the notification reached the desktop is unknown",
			);
		expect({ exit, error: err.trim() }).toEqual({ exit: 0, error: "" });
		const text = out;
		// The log was read: its header, even when usernoted was quiet.
		expect(text).toStartWith("Timestamp");
		expect(text.split("\n").filter((l) => l.includes(`-${id}"`))).toEqual([]);
	},
	30_000,
);
