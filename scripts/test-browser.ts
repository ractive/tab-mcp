/**
 * `bun run test:browser [--no-chrome] [--no-firefox] [--system-firefox]
 * [--no-wait] [filter…]`: the browser
 * tests, the files named `*.browser.test.ts`, which plain `bun test` loads and
 * skips (test/browser-gate.ts). A filter narrows the run to the files whose
 * name contains it: `bun run test:browser extension` runs
 * `extension.browser.test.ts`, `bun run test:browser fill` the extension's two
 * fill files. One `bun test` process, `TAB_MCP_BROWSER=1`.
 *
 * It does not pass without having tested. Before the run it finds the
 * browsers the chosen files need, with the harnesses' own lookup, and prints
 * each one's path and version; a missing or too old browser fails the run,
 * with the command that installs the pinned test browser (test/browsers.ts:
 * never the owner's own Chrome or Firefox; an installed Firefox only with
 * `--system-firefox`).
 * `--no-chrome` or `--no-firefox` leaves out the files that need that browser
 * instead, and says which were not tested. After the run, a file with no
 * passed test fails it too. SIGINT, SIGTERM and SIGHUP go on to the test run.
 *
 * One browser run per machine: it takes the machine-wide lock
 * (test/browser-lock.ts) before it starts anything, and waits while another
 * run holds it, saying whose (`--no-wait` fails at once instead). Then it
 * sweeps the browsers and folders of runs that are gone
 * (test/browser-sweep.ts), and again after the run. `--sweep` only sweeps,
 * `--sweep --dry-run` only
 * says what it would stop and remove.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { constants, tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { holdBrowserLock } from "../test/browser-lock.ts";
import { sweep } from "../test/browser-sweep.ts";
import { INSTALL } from "../test/browsers.ts";

const ROOT = resolve(import.meta.dir, "..");

/** The browser test files under `root`, relative to it and sorted; with filters, those whose name contains one. */
export async function browserTestFiles(
	root: string,
	filters: readonly string[] = [],
): Promise<string[]> {
	const files: string[] = [];
	for await (const file of new Bun.Glob("**/*.browser.test.{ts,tsx}").scan({
		cwd: root,
		onlyFiles: true,
	})) {
		if (file.split("/").includes("node_modules")) continue;
		const name = basename(file);
		if (filters.length > 0 && !filters.some((f) => name.includes(f))) continue;
		files.push(file);
	}
	return files.sort();
}

export type Need = "chrome" | "chrome-for-testing" | "firefox";

/** The browsers `source`, a browser test file, looks for. */
export function needs(source: string): Need[] {
	const found: Need[] = [];
	if (/\bfindChromeForTesting\(/.test(source)) found.push("chrome-for-testing");
	if (/\bfindChrome\(/.test(source)) found.push("chrome");
	if (/\bfindFirefox\(/.test(source)) found.push("firefox");
	return found;
}

const module = (path: string) => JSON.stringify(join(ROOT, path));
const EXTENSION = "packages/tab-mcp-extension/test";

const LOOKUP: Record<Need, { label: string; min: number; code: string }> = {
	"chrome-for-testing": {
		label: "Chrome for Testing",
		min: 156,
		code: `import { findChromeForTesting as find, chromeMajor as major } from ${module(`${EXTENSION}/browser.ts`)};`,
	},
	chrome: {
		label: "Chrome for Testing (cdp.ts)",
		min: 1,
		code: `import { findChrome as find } from ${module("packages/tab-mcp-client/test/cdp.ts")}; import { chromeMajor as major } from ${module(`${EXTENSION}/browser.ts`)};`,
	},
	firefox: {
		label: "Firefox",
		min: 128,
		code: `import { findFirefox as find, firefoxMajor as major } from ${module(`${EXTENSION}/firefox.ts`)};`,
	},
};

/** The browser the harnesses would use for `need`, and its major version (0 if it does not say). */
function lookUp(need: Need): { path?: string; major: number } {
	// In a process of its own: the harnesses are test modules, outside this
	// script's type check.
	const script = `${LOOKUP[need].code} const path = find(); console.log(JSON.stringify({ path, major: path === undefined ? 0 : major(path) }));`;
	const { stdout, success } = Bun.spawnSync([process.execPath, "-e", script], {
		cwd: ROOT,
		// The current environment: `--system-firefox` sets a variable in it.
		env: { ...process.env },
		stderr: "inherit",
	});
	if (!success) return { major: 0 };
	return JSON.parse(stdout.toString()) as { path?: string; major: number };
}

/** Passed tests per file of a JUnit report from `bun test`. */
export function passedPerFile(junit: string): Map<string, number> {
	const passed = new Map<string, number>();
	for (const m of junit.matchAll(
		/^ {2}<testsuite name="[^"]*" file="([^"]+)" tests="(\d+)" assertions="\d+" failures="(\d+)" skipped="(\d+)"/gm,
	)) {
		const file = (m[1] as string).replace(/^\.\//, "");
		passed.set(
			file,
			(passed.get(file) ?? 0) + Number(m[2]) - Number(m[3]) - Number(m[4]),
		);
	}
	return passed;
}

async function main(): Promise<number> {
	const args = process.argv.slice(2);
	if (args.includes("--sweep")) {
		// Under the lock, without waiting: a running run's own sweep is enough.
		try {
			await holdBrowserLock({ wait: false, filter: "--sweep" });
		} catch (error) {
			console.error(`not sweeping: ${(error as Error).message}`);
			return 1;
		}
		const plan = sweep({ dryRun: args.includes("--dry-run") });
		console.error(
			`sweep: ${plan.kill.length} process${plan.kill.length === 1 ? "" : "es"}, ${plan.remove.length} folder${plan.remove.length === 1 ? "" : "s"}${args.includes("--dry-run") ? " (dry run)" : ""}${plan.kept ? ", kept everything" : ""}`,
		);
		return plan.kept ? 1 : 0;
	}
	const without = new Set<Need>();
	if (args.includes("--no-chrome")) {
		without.add("chrome");
		without.add("chrome-for-testing");
	}
	if (args.includes("--no-firefox")) without.add("firefox");
	// The installed Firefox, asked for: the lookup and the run see it (test/browsers.ts).
	if (args.includes("--system-firefox"))
		process.env["TAB_MCP_SYSTEM_FIREFOX"] = "1";
	const filters = args.filter((a) => !a.startsWith("--"));
	const chosen = await browserTestFiles(ROOT, filters);
	if (chosen.length === 0) {
		console.error(`no browser test file matches ${filters.join(" ")}`);
		return 1;
	}

	const fileNeeds = new Map<string, Need[]>();
	for (const file of chosen)
		fileNeeds.set(file, needs(await Bun.file(join(ROOT, file)).text()));
	const files = chosen.filter(
		(f) => !(fileNeeds.get(f) ?? []).some((n) => without.has(n)),
	);
	const left = chosen.filter((f) => !files.includes(f));
	if (left.length > 0)
		console.error(
			`\nNOT TESTED (${[...without].join(", ")} left out on request):\n${left.map((f) => `  ${f}`).join("\n")}\n`,
		);
	if (files.length === 0) {
		console.error("no browser test file left to run");
		return 1;
	}

	let missing = false;
	for (const need of new Set(files.flatMap((f) => fileNeeds.get(f) ?? []))) {
		const { label, min } = LOOKUP[need];
		const { path, major } = lookUp(need);
		if (path !== undefined && major >= min) {
			console.log(`${label}: ${path} (${major})`);
			continue;
		}
		missing = true;
		const firefox = need === "firefox";
		console.error(
			[
				`${label} ${min} or newer is needed, ${path === undefined ? "none was found" : `${path} is ${major}`}. Never the installed one; once:`,
				`  ${firefox ? INSTALL.firefox : INSTALL.chrome}`,
				`or set ${firefox ? "FIREFOX_PATH" : "CHROME_PATH"}, or leave its files out with ${firefox ? "--no-firefox" : "--no-chrome"}${firefox ? " (an installed Firefox only with --system-firefox)" : ""}.`,
			].join("\n"),
		);
	}
	if (missing) return 1;

	// One browser run on this machine at a time; then what killed runs left.
	// The run's bun test inherits TAB_MCP_BROWSER_LOCK and holds it on.
	let run: ReturnType<typeof Bun.spawn> | undefined;
	for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const)
		process.on(signal, () => {
			if (run === undefined) process.exit(128 + constants.signals[signal]);
			run.kill(signal);
		});
	try {
		await holdBrowserLock({
			wait: !args.includes("--no-wait"),
			filter: filters.join(" "),
			signals: false,
		});
	} catch (error) {
		console.error((error as Error).message);
		return 1;
	}
	sweep();

	console.log(
		`browser tests: ${files.length} file${files.length === 1 ? "" : "s"}`,
	);
	const dir = mkdtempSync(join(tmpdir(), "tab-mcp-test-browser-"));
	const report = join(dir, "junit.xml");
	try {
		run = Bun.spawn(
			[
				process.execPath,
				"test",
				"--reporter=junit",
				`--reporter-outfile=${report}`,
				...files.map((f) => `./${f}`),
			],
			{
				cwd: ROOT,
				env: { ...process.env, TAB_MCP_BROWSER: "1" },
				stdio: ["inherit", "inherit", "inherit"],
			},
		);
		const code = await run.exited;
		// Its run folder (a harness's reap empties it at exit, after the
		// folder's own exit hook has run) and anything a crash left.
		sweep();
		const signal = run.signalCode;
		if (signal !== null)
			return (
				128 + (typeof signal === "number" ? signal : constants.signals[signal])
			);
		if (code !== 0) return code;
		const passed = passedPerFile(await Bun.file(report).text());
		const none = files.filter((f) => (passed.get(f) ?? 0) === 0);
		if (none.length > 0) {
			console.error(
				`no test passed in:\n${none.map((f) => `  ${f}`).join("\n")}\nevery test there was skipped: nothing was tested`,
			);
			return 1;
		}
		return 0;
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

if (import.meta.main) process.exit(await main());
