/**
 * No notification of a test on the owner's desktop (iteration 50, DEC-220):
 * the test Chrome starts with `--disable-features=NativeNotifications`
 * (test/browsers.ts), so `chrome.notifications` works as ever (create, getAll,
 * clear) but macOS never gets the notification. macOS's notification daemon
 * logs every notification it delivers, with the extension's id and the
 * notification's id (`req:"r|Default|<extension>-<id>"`): after a question-like
 * notification of the test build, the log must not name it. macOS only, where
 * the owner's desktop is; it fails if Chrome renames or drops the feature.
 * Firefox's test build records its notifications instead of showing them
 * (src/worker/notifications.ts; build.test.ts keeps that out of every other
 * build).
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
	if (chrome === undefined || !onMac) return;
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

test.skipIf(chrome === undefined || !onMac)(
	"a notification of the test build works and never reaches macOS",
	async () => {
		const id = `guard-${Date.now()}`;
		await worker.eval(`chrome.notifications.create(${JSON.stringify(id)}, {
			type: "basic",
			iconUrl: chrome.runtime.getURL("icons/icon-128.png"),
			title: "tab-mcp test",
			message: "never on the desktop",
			buttons: [{ title: "Allow" }, { title: "Don't allow" }],
			requireInteraction: true,
			priority: 2,
		})`);
		expect(
			await worker.eval<string[]>(
				"chrome.notifications.getAll().then((all) => Object.keys(all))",
			),
		).toContain(id);
		// What macOS delivers shows within a second (it did in the experiment).
		await Bun.sleep(3_000);
		expect(
			await worker.eval<boolean>(
				`chrome.notifications.clear(${JSON.stringify(id)})`,
			),
		).toBe(true);
		const log = Bun.spawnSync(
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
		expect({ exit: log.exitCode, error: log.stderr.toString().trim() }).toEqual(
			{ exit: 0, error: "" },
		);
		const text = log.stdout.toString();
		// The log was read: its header, even when usernoted was quiet.
		expect(text).toStartWith("Timestamp");
		expect(text.split("\n").filter((l) => l.includes(`-${id}"`))).toEqual([]);
	},
	30_000,
);
