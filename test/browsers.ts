/**
 * Which browsers the tests start, and how. Never the owner's own: Chrome is
 * Chrome for Testing in the pinned version, Firefox a test Firefox in the
 * pinned version, both from Puppeteer's cache (`~/.cache/puppeteer`), where
 * `bunx @puppeteer/browsers install` puts them (`INSTALL`), or the binary in
 * `CHROME_PATH` / `FIREFOX_PATH`. An installed Firefox only when the caller
 * asks for it (`TAB_MCP_SYSTEM_FIREFOX=1`, `test:browser --system-firefox`):
 * then it is taken even when the pinned one is cached, with a line saying so.
 * No installed Chrome ever: branded Chrome also ignores `--load-extension`.
 * CI installs the same pinned Firefox (`INSTALL.firefox`, checked by
 * scripts/browsers.test.ts).
 *
 * And no notification of a test on the owner's desktop: Chrome without its
 * macOS notifications (`--disable-features=NativeNotifications`: its own
 * notification center, which a headless Chrome does not show; the API
 * answers the same). Firefox has no such switch that leaves its behaviour
 * alone (`alerts.useSystemBackend: false` opens alert windows that take the
 * focus from the panel): its test build records its notifications instead
 * (src/background.ts). kb/research/test-browser-notifications.md.
 */
import { homedir } from "node:os";
import { join } from "node:path";

/** Chrome for Testing as CI pins it (`CHROME_VERSION` in the workflows, checked by scripts/browsers.test.ts). */
export const CHROME_VERSION = "156.0.8078.80";
/** The test Firefox, as `@puppeteer/browsers` names it; CI installs the same (scripts/browsers.test.ts). */
export const FIREFOX_VERSION = "stable_160.0.1";
export const PUPPETEER_BROWSERS = "@puppeteer/browsers@3.2.7";

/** Puppeteer's cache, under the home folder as `HOME` says now. */
export const cache = (): string =>
	join(process.env["HOME"] || homedir(), ".cache", "puppeteer");

export const INSTALL = {
	chrome: `bunx ${PUPPETEER_BROWSERS} install chrome@${CHROME_VERSION} --path ~/.cache/puppeteer`,
	firefox: `bunx ${PUPPETEER_BROWSERS} install firefox@${FIREFOX_VERSION} --path ~/.cache/puppeteer`,
};

const exists = (path: string) => Bun.file(path).size > 0;

/** The platform part of a Puppeteer cache folder (`mac_arm-<version>`). */
function platform(): string | undefined {
	if (process.platform === "darwin")
		return process.arch === "arm64" ? "mac_arm" : "mac";
	if (process.platform === "linux") return "linux";
	return undefined;
}

/** Chrome for Testing: `CHROME_PATH`, else the pinned version in Puppeteer's cache; `undefined` if neither. */
export function findChromeForTesting(): string | undefined {
	const fromEnv = process.env["CHROME_PATH"];
	if (fromEnv) return fromEnv;
	const p = platform();
	if (p === undefined) return undefined;
	const dir = join(cache(), "chrome", `${p}-${CHROME_VERSION}`);
	return [
		"chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
		"chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
		"chrome-linux64/chrome",
	]
		.map((binary) => join(dir, binary))
		.find(exists);
}

/** Where Firefox is installed, for `TAB_MCP_SYSTEM_FIREFOX=1` only. */
export const SYSTEM_FIREFOX = [
	"/Applications/Firefox.app/Contents/MacOS/firefox",
	"/Applications/Firefox Nightly.app/Contents/MacOS/firefox",
	"/usr/bin/firefox",
	"/usr/local/bin/firefox",
	"/snap/bin/firefox",
];

let told = false;

/**
 * The test Firefox: `FIREFOX_PATH`; else, asked for with
 * `TAB_MCP_SYSTEM_FIREFOX=1` (`test:browser --system-firefox`), an installed
 * one from `system`, said once on stderr, even when the pinned one is cached;
 * else the pinned version in Puppeteer's cache. `undefined` if none.
 */
export function findTestFirefox(
	system: readonly string[] = SYSTEM_FIREFOX,
): string | undefined {
	const fromEnv = process.env["FIREFOX_PATH"];
	if (fromEnv) return fromEnv;
	if (process.env["TAB_MCP_SYSTEM_FIREFOX"] === "1") {
		const installed = system.find(exists);
		if (installed !== undefined && !told) {
			console.error(
				`using the installed Firefox ${installed} (TAB_MCP_SYSTEM_FIREFOX=1)`,
			);
			told = true;
		}
		return installed;
	}
	const p = platform();
	if (p === undefined) return undefined;
	const dir = join(cache(), "firefox", `${p}-${FIREFOX_VERSION}`);
	return [
		"Firefox.app/Contents/MacOS/firefox",
		"Firefox Nightly.app/Contents/MacOS/firefox",
		"firefox/firefox",
	]
		.map((binary) => join(dir, binary))
		.find(exists);
}

/** The switches a test Chrome gets besides `args`: its notifications off the desktop, merged into one `--disable-features`. */
export function chromeSwitches(args: readonly string[] = []): string[] {
	const disable = new Set(["NativeNotifications"]);
	const rest: string[] = [];
	for (const arg of args) {
		const m = /^--disable-features=(.*)$/.exec(arg);
		if (m === null) {
			rest.push(arg);
			continue;
		}
		for (const feature of (m[1] as string).split(","))
			if (feature) disable.add(feature);
	}
	return [`--disable-features=${[...disable].join(",")}`, ...rest];
}
