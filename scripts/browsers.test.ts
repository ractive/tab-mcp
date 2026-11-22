/**
 * Which browsers the tests start (test/browsers.ts): only the pinned test
 * browsers, never an installed Chrome, an installed Firefox only on request,
 * and the switch that keeps Chrome's notifications off the desktop.
 */
import { expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	CHROME_VERSION,
	cache,
	chromeSwitches,
	FIREFOX_VERSION,
	findTestFirefox,
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

test("an installed Firefox only with TAB_MCP_SYSTEM_FIREFOX=1, then over the cache, and said once", () => {
	const home = mkdtempSync(join(tmpdir(), "tab-mcp-home-"));
	const saved = {
		HOME: process.env["HOME"],
		FIREFOX_PATH: process.env["FIREFOX_PATH"],
		TAB_MCP_SYSTEM_FIREFOX: process.env["TAB_MCP_SYSTEM_FIREFOX"],
	};
	const said = spyOn(console, "error").mockImplementation(() => {});
	try {
		process.env["HOME"] = home;
		delete process.env["FIREFOX_PATH"];
		const installed = join(
			home,
			"Applications/Firefox.app/Contents/MacOS/firefox",
		);
		fakeBinary(installed);
		// Never into the real cache: a first version of this test, before
		// cache() read HOME, overwrote the real test Firefox.
		if (!cache().startsWith(`${home}/`))
			throw new Error(`cache() is ${cache()}, not under the test's home`);
		// The pinned one is cached too: an explicit request still wins.
		fakeBinary(
			join(cache(), "firefox", `linux-${FIREFOX_VERSION}`, "firefox/firefox"),
		);
		fakeBinary(
			join(
				cache(),
				"firefox",
				`mac_arm-${FIREFOX_VERSION}`,
				"Firefox.app/Contents/MacOS/firefox",
			),
		);
		fakeBinary(
			join(
				cache(),
				"firefox",
				`mac-${FIREFOX_VERSION}`,
				"Firefox.app/Contents/MacOS/firefox",
			),
		);
		delete process.env["TAB_MCP_SYSTEM_FIREFOX"];
		expect(findTestFirefox([installed])).toContain(
			join(home, ".cache/puppeteer"),
		);
		expect(said).not.toHaveBeenCalled();
		process.env["TAB_MCP_SYSTEM_FIREFOX"] = "1";
		expect(findTestFirefox([installed])).toBe(installed);
		expect(findTestFirefox([installed])).toBe(installed);
		expect(said.mock.calls).toEqual([
			[`using the installed Firefox ${installed} (TAB_MCP_SYSTEM_FIREFOX=1)`],
		]);
		// Asked for, none installed: none, not the cache's.
		expect(findTestFirefox([join(home, "nowhere/firefox")])).toBeUndefined();
	} finally {
		said.mockRestore();
		for (const [name, value] of Object.entries(saved))
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
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
});

test("every Chrome the code starts gets the switch: each launch list has chromeSwitches", async () => {
	// A Chrome launch is a spawn list that starts with the binary and holds
	// --headless=new; each must spread chromeSwitches(…), so dropping the
	// switch fails here, without a browser.
	const launches: string[] = [];
	for await (const file of new Bun.Glob("**/*.ts").scan({
		cwd: resolve(import.meta.dir, ".."),
		onlyFiles: true,
	})) {
		if (
			file
				.split("/")
				.some((part) => part === "node_modules" || part === "dist") ||
			file.endsWith(".test.ts")
		)
			continue;
		const text = await Bun.file(resolve(import.meta.dir, "..", file)).text();
		const lists = (
			text.match(/\[\s*binary,[\s\S]*?"about:blank",?\s*\]/g) ?? []
		).filter((list) => list.includes('"--headless=new"'));
		const headless = (text.match(/"--headless=new"/g) ?? []).length;
		expect({ file, lists: lists.length }).toEqual({ file, lists: headless });
		for (const list of lists) {
			launches.push(file);
			expect({ file, switch: list.includes("...chromeSwitches(") }).toEqual({
				file,
				switch: true,
			});
		}
	}
	expect(launches.sort()).toEqual([
		"packages/tab-mcp-client/test/cdp.ts",
		"packages/tab-mcp-extension/test/browser.ts",
		"test/webmcp-spike/browser.ts",
	]);
});

test("the pins are CI's and the releases', and the install commands name them", async () => {
	for (const name of [
		"ci.yml",
		"browser-full.yml",
		"release.yml",
		"extension-release.yml",
	]) {
		const text = await Bun.file(
			resolve(import.meta.dir, "../.github/workflows", name),
		).text();
		expect({ name, pin: /CHROME_VERSION: "([^"]+)"/.exec(text)?.[1] }).toEqual({
			name,
			pin: CHROME_VERSION,
		});
		// Every job that runs the browser tests installs the pinned test
		// Firefox first, under the same condition, and names no other.
		const { jobs } = Bun.YAML.parse(text) as {
			jobs: Record<
				string,
				{
					steps?: { run?: string; if?: string; env?: Record<string, string> }[];
				}
			>;
		};
		let runs = 0;
		for (const [job, { steps = [] }] of Object.entries(jobs))
			steps.forEach((step, i) => {
				if (!/bun run (test:browser|verify:all)/.test(step.run ?? "")) return;
				runs++;
				const install = steps
					.slice(0, i)
					.find((s) => s.run === INSTALL.firefox);
				expect({
					name,
					job,
					installs: install !== undefined,
					same: install?.if === step.if,
				}).toEqual({
					name,
					job,
					installs: true,
					same: true,
				});
				expect({ name, job, firefox: step.env?.["FIREFOX_PATH"] }).toEqual({
					name,
					job,
					firefox: undefined,
				});
			});
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
