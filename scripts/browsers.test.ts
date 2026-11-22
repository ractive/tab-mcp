/**
 * Which browsers the tests start (test/browsers.ts): only the pinned test
 * browsers, never an installed Chrome, an installed Firefox only on request,
 * and the switches that keep notifications off the desktop.
 */
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	CHROME_VERSION,
	chromeSwitches,
	FIREFOX_PREFS,
	FIREFOX_VERSION,
	INSTALL,
} from "../test/browsers.ts";

const BROWSERS = resolve(import.meta.dir, "../test/browsers.ts");

/** What the lookups find with `home` as the home folder and `env` set. */
function lookUp(home: string, env: Record<string, string> = {}) {
	const clean = { ...process.env };
	for (const name of ["CHROME_PATH", "FIREFOX_PATH", "TAB_MCP_SYSTEM_FIREFOX"])
		delete clean[name];
	const run = Bun.spawnSync(
		[
			process.execPath,
			"-e",
			`import { findChromeForTesting, findTestFirefox } from ${JSON.stringify(BROWSERS)}; console.log(JSON.stringify({ chrome: findChromeForTesting() ?? null, firefox: findTestFirefox() ?? null }));`,
		],
		{ env: { ...clean, HOME: home, ...env }, stderr: "pipe" },
	);
	return {
		...(JSON.parse(run.stdout.toString()) as {
			chrome: string | null;
			firefox: string | null;
		}),
		said: run.stderr.toString(),
	};
}

function fakeBinary(path: string) {
	mkdirSync(resolve(path, ".."), { recursive: true });
	writeFileSync(path, "#!/bin/sh\n");
}

test("without the pinned test browsers and without a path, no browser: never an installed one", () => {
	const home = mkdtempSync(join(tmpdir(), "tab-mcp-home-"));
	try {
		expect(lookUp(home)).toEqual({ chrome: null, firefox: null, said: "" });
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("the pinned versions in Puppeteer's cache, or CHROME_PATH and FIREFOX_PATH", () => {
	const home = mkdtempSync(join(tmpdir(), "tab-mcp-home-"));
	try {
		const p =
			process.platform === "darwin"
				? process.arch === "arm64"
					? "mac_arm"
					: "mac"
				: "linux";
		const chrome = join(
			home,
			".cache/puppeteer/chrome",
			`${p}-${CHROME_VERSION}`,
			p === "linux"
				? "chrome-linux64/chrome"
				: `chrome-${p === "mac_arm" ? "mac-arm64" : "mac-x64"}/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,
		);
		const firefox = join(
			home,
			".cache/puppeteer/firefox",
			`${p}-${FIREFOX_VERSION}`,
			p === "linux" ? "firefox/firefox" : "Firefox.app/Contents/MacOS/firefox",
		);
		// Another version in the cache is not the pinned one.
		fakeBinary(chrome.replace(CHROME_VERSION, "155.0.0.0"));
		expect(lookUp(home).chrome).toBeNull();
		fakeBinary(chrome);
		fakeBinary(firefox);
		expect(lookUp(home)).toEqual({ chrome, firefox, said: "" });
		expect(
			lookUp(home, { CHROME_PATH: "/x/chrome", FIREFOX_PATH: "/x/firefox" }),
		).toEqual({ chrome: "/x/chrome", firefox: "/x/firefox", said: "" });
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("an installed Firefox only with TAB_MCP_SYSTEM_FIREFOX=1, and then said", () => {
	const home = mkdtempSync(join(tmpdir(), "tab-mcp-home-"));
	try {
		const asked = lookUp(home, { TAB_MCP_SYSTEM_FIREFOX: "1" });
		if (asked.firefox !== null)
			expect(asked.said).toContain(
				`using the installed Firefox ${asked.firefox}`,
			);
		expect(lookUp(home).firefox).toBeNull();
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("a test Chrome's notifications stay off the desktop, merged with the caller's disabled features", () => {
	expect(chromeSwitches()).toEqual(["--disable-features=NativeNotifications"]);
	expect(
		chromeSwitches([
			"--enable-features=WebMCP",
			"--disable-features=A,B",
			"--x",
		]),
	).toEqual([
		"--disable-features=NativeNotifications,A,B",
		"--enable-features=WebMCP",
		"--x",
	]);
	expect(FIREFOX_PREFS["alerts.useSystemBackend"]).toBe(false);
});

test("the pinned Chrome is CI's and the releases', and the install commands name the pins", async () => {
	for (const name of ["ci.yml", "release.yml", "extension-release.yml"]) {
		const text = await Bun.file(
			resolve(import.meta.dir, "../.github/workflows", name),
		).text();
		expect({ name, pin: /CHROME_VERSION: "([^"]+)"/.exec(text)?.[1] }).toEqual({
			name,
			pin: CHROME_VERSION,
		});
		// Every run of the browser tests names its Firefox: none is picked by itself.
		const { jobs } = Bun.YAML.parse(text) as {
			jobs: Record<
				string,
				{ steps?: { run?: string; env?: Record<string, string> }[] }
			>;
		};
		let runs = 0;
		for (const job of Object.values(jobs))
			for (const step of job.steps ?? [])
				if (/bun run (test:browser|verify:all)/.test(step.run ?? "")) {
					runs++;
					expect({ name, firefox: step.env?.["FIREFOX_PATH"] }).toEqual({
						name,
						firefox: "/usr/bin/firefox",
					});
				}
		expect({ name, runs: runs > 0 }).toEqual({ name, runs: true });
	}
	expect(INSTALL.chrome).toContain(`chrome@${CHROME_VERSION}`);
	expect(INSTALL.firefox).toContain(`firefox@${FIREFOX_VERSION}`);
	// The README's one-time set-up is these two lines.
	const readme = await Bun.file(
		resolve(import.meta.dir, "../README.md"),
	).text();
	expect(readme).toContain(INSTALL.chrome);
	expect(readme).toContain(INSTALL.firefox);
});
