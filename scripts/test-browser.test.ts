/**
 * The convention that keeps browsers out of plain `bun test`: a test file
 * that can launch a browser is named `*.browser.test.ts`, imports
 * test/browser-gate.ts, and looks for its browser only behind the gate.
 * `bun run test:browser` (scripts/test-browser.ts) runs exactly these files.
 *
 * - The harnesses are the modules that define a `static async launch(`
 *   (found in the code, outside node_modules; the four known ones must be
 *   among them).
 * - A test file (every name `bun test` discovers) can launch a browser when it
 *   reaches a harness through its relative imports, at any depth, and it or a
 *   module on the way that is not a harness finds or starts one: a
 *   `find…()` of a harness, a `launch(`, a `startStack(`, or a read of
 *   `CHROME_PATH` or `FIREFOX_PATH`. A relative import that resolves to no
 *   file fails the test. A file that takes only a pure helper from a harness
 *   (`cdp.test.ts`, `profilePattern`) launches nothing and stays in the fast
 *   suite.
 * - Limits: imports by package name are not followed (no package exports a
 *   harness); a browser binary taken from somewhere else entirely (a fixed
 *   path, `Bun.which`) is not seen by the static check. The last test covers
 *   that at run time: every browser file under plain `bun test`, with
 *   `CHROME_PATH` and `FIREFOX_PATH` pointing at a stand-in that records any
 *   start, must start nothing.
 */
import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { browserTestFiles, needs, passedPerFile } from "./test-browser.ts";

const ROOT = resolve(import.meta.dir, "..");
const GATE = join(ROOT, "test/browser-gate.ts");

const KNOWN_HARNESSES = [
	"packages/tab-mcp-client/test/cdp.ts",
	"packages/tab-mcp-extension/test/browser.ts",
	"packages/tab-mcp-extension/test/firefox.ts",
	"test/webmcp-spike/browser.ts",
].map((path) => join(ROOT, path));

const CODE = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"];

async function scan(pattern: string): Promise<string[]> {
	const files: string[] = [];
	for await (const file of new Bun.Glob(pattern).scan({
		cwd: ROOT,
		onlyFiles: true,
	}))
		if (
			!file
				.split("/")
				.some((part) => part === "node_modules" || part === "dist")
		)
			files.push(file);
	return files.sort();
}

/** The modules that launch a browser: they define a `static async launch(`. */
async function harnesses(): Promise<string[]> {
	const found: string[] = [];
	for (const file of await scan("**/*.{ts,tsx,js,mjs}"))
		if (/\bstatic async launch\(/.test(await Bun.file(join(ROOT, file)).text()))
			found.push(join(ROOT, file));
	return found;
}

const HARNESSES = await harnesses();

const transpilers = {
	ts: new Bun.Transpiler({ loader: "ts" }),
	tsx: new Bun.Transpiler({ loader: "tsx" }),
	js: new Bun.Transpiler({ loader: "js" }),
};

function transpiler(file: string) {
	const ext = extname(file);
	return ext === ".tsx" || ext === ".jsx"
		? transpilers.tsx
		: ext === ".ts" || ext === ".mts" || ext === ".cts"
			? transpilers.ts
			: transpilers.js;
}

const isFile = (path: string) => existsSync(path) && statSync(path).isFile();

/** A relative import of `from`, resolved to a script, `null` for a file that is no script (a page, a style sheet); throws when nothing is there. */
function resolveImport(from: string, specifier: string): string | null {
	const base = resolve(dirname(from), specifier.replace(/[?#].*$/, ""));
	if (isFile(base)) return CODE.includes(extname(base)) ? base : null;
	for (const candidate of [
		...CODE.map((ext) => base + ext),
		...CODE.map((ext) => join(base, `index${ext}`)),
	])
		if (isFile(candidate)) return candidate;
	throw new Error(`${from}: the import "${specifier}" resolves to no file`);
}

/** The scripts `file` imports with a relative path, resolved. */
async function imports(file: string): Promise<string[]> {
	const source = await Bun.file(file).text();
	return transpiler(file)
		.scanImports(source)
		.map((i) => i.path)
		.filter((path) => path.startsWith("."))
		.flatMap((path) => resolveImport(file, path) ?? []);
}

/** A harness's browser lookup or start, or a read of where a browser is. */
const STARTS =
	/\bfind(Chrome|ChromeForTesting|Firefox)\(|\blaunch\(|\bstartStack\(|\b(CHROME|FIREFOX)_PATH\b/;

/**
 * Whether `file` can launch a browser: it reaches a harness through its
 * relative imports, and it or a module it reaches that is not a harness
 * finds or starts a browser.
 */
async function launchesBrowser(file: string): Promise<boolean> {
	const seen = new Set<string>();
	const todo = [file];
	let harness = false;
	let starts = false;
	for (let next = todo.pop(); next !== undefined; next = todo.pop()) {
		if (seen.has(next)) continue;
		seen.add(next);
		if (HARNESSES.includes(next)) {
			harness = true;
			continue;
		}
		if (STARTS.test(await Bun.file(next).text())) starts = true;
		todo.push(...(await imports(next)));
	}
	return harness && starts;
}

/** Every test file `bun test` discovers, relative to the root. */
const testFiles = () =>
	scan(
		`**/*{.test,_test,.spec,_spec}.{${CODE.map((e) => e.slice(1)).join(",")}}`,
	);

test("the harnesses are found in the code, the known ones among them", () => {
	for (const harness of KNOWN_HARNESSES) expect(HARNESSES).toContain(harness);
	expect(existsSync(GATE)).toBe(true);
});

test("a test file that can launch a browser is named *.browser.test.ts, and only such a file", async () => {
	const launching: string[] = [];
	for (const file of await testFiles())
		if (await launchesBrowser(join(ROOT, file))) launching.push(file);
	expect(launching.length).toBeGreaterThan(0);
	expect(launching).toEqual(await browserTestFiles(ROOT));
});

test("a test of a harness's pure helper launches nothing and stays in the fast suite", async () => {
	const cdp = join(ROOT, "packages/tab-mcp-client/test/cdp.test.ts");
	expect((await imports(cdp)).filter((i) => HARNESSES.includes(i))).toEqual([
		join(ROOT, "packages/tab-mcp-client/test/cdp.ts"),
	]);
	expect(await launchesBrowser(cdp)).toBe(false);
});

test("a relative import that resolves to no file fails the check", () => {
	expect(() =>
		resolveImport(join(ROOT, "scripts/x.test.ts"), "./nowhere"),
	).toThrow("resolves to no file");
	expect(resolveImport(join(ROOT, "scripts/x.test.ts"), "./test-browser")).toBe(
		join(ROOT, "scripts/test-browser.ts"),
	);
});

test("every browser test file imports the gate and looks for a browser only behind it", async () => {
	for (const file of await browserTestFiles(ROOT)) {
		const path = join(ROOT, file);
		expect({ file, gate: (await imports(path)).includes(GATE) }).toEqual({
			file,
			gate: true,
		});
		const ungated = (await Bun.file(path).text())
			.split("\n")
			.filter(
				(line) =>
					/\bfind(Chrome|ChromeForTesting|Firefox)\(|\b(CHROME|FIREFOX)_PATH\b/.test(
						line,
					) &&
					!line.includes("browserTests") &&
					!/^\s*(\*|\/\/)/.test(line),
			);
		expect({ file, ungated }).toEqual({ file, ungated: [] });
	}
});

test("plain bun test starts no browser from any browser file", async () => {
	const dir = mkdtempSync(join(tmpdir(), "tab-mcp-no-browser-"));
	try {
		const marker = join(dir, "started");
		const standIn = join(dir, "browser");
		await Bun.write(standIn, `#!/bin/sh\necho "$0 $*" >> "${marker}"\n`);
		chmodSync(standIn, 0o755);
		const env: Record<string, string | undefined> = {
			...process.env,
			CHROME_PATH: standIn,
			FIREFOX_PATH: standIn,
		};
		delete env["TAB_MCP_BROWSER"];
		const files = await browserTestFiles(ROOT);
		const run = Bun.spawnSync(
			[process.execPath, "test", ...files.map((f) => `./${f}`)],
			{ cwd: ROOT, env, stdout: "pipe", stderr: "pipe" },
		);
		expect({
			exit: run.exitCode,
			started: existsSync(marker) ? await Bun.file(marker).text() : "",
		}).toEqual({ exit: 0, started: "" });
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}, 60_000);

interface Workflow {
	on: Record<string, Record<string, unknown> | null>;
	jobs: Record<
		string,
		{
			needs?: string[];
			if?: string;
			steps: { run?: string; env?: Record<string, string> }[];
		}
	>;
}

const workflow = async (name: string): Promise<Workflow> =>
	Bun.YAML.parse(
		await Bun.file(join(ROOT, ".github/workflows", name)).text(),
	) as Workflow;

const runs = (wf: Workflow, job: string): string[] =>
	(wf.jobs[job]?.steps ?? []).flatMap((s) => (s.run ? [s.run.trim()] : []));

test("CI: fast and browser run on every pull request, unfiltered, and verify (the required check) needs both", async () => {
	const ci = await workflow("ci.yml");
	expect(runs(ci, "fast")).toContain("bun run verify");
	expect(runs(ci, "browser")).toContain("bun run test:browser");
	for (const job of ["fast", "browser"])
		expect(runs(ci, job)[0]).toBe("bash scripts/ci-changes.sh");
	const verify = ci.jobs["verify"];
	expect(verify?.needs).toEqual(["fast", "browser"]);
	expect(verify?.if).toBe("always()");
	const check = verify?.steps.find((s) => s.run?.includes("test "));
	expect(Object.keys(check?.env ?? {})).toEqual(["FAST", "BROWSER"]);
	expect(check?.env?.["FAST"]).toMatch(/^\$\{\{ needs\.fast\.result \}\}$/);
	expect(check?.env?.["BROWSER"]).toMatch(
		/^\$\{\{ needs\.browser\.result \}\}$/,
	);
	expect(check?.run).toContain('test "$FAST" = success');
	expect(check?.run).toContain('test "$BROWSER" = success');
	for (const trigger of Object.values(ci.on)) {
		expect(trigger?.["paths"]).toBeUndefined();
		expect(trigger?.["paths-ignore"]).toBeUndefined();
	}
});

test("a release runs the browser tests too", async () => {
	const release = await workflow("release.yml");
	const extension = await workflow("extension-release.yml");
	for (const [wf, job] of [
		[release, "client-pack"],
		[release, "relay-pack"],
		[extension, "build"],
	] as const) {
		expect(runs(wf, job)).toContain("bun run verify:all");
		expect(runs(wf, job)).not.toContain("bun run verify");
	}
});

test("a filter narrows test:browser to the files whose name contains it", async () => {
	expect(await browserTestFiles(ROOT, ["fill"])).toEqual([
		"packages/tab-mcp-extension/test/fill.browser.test.ts",
		"packages/tab-mcp-extension/test/firefox-fill.browser.test.ts",
	]);
	expect(await browserTestFiles(ROOT, ["extension"])).toEqual([
		"packages/tab-mcp-extension/test/extension.browser.test.ts",
	]);
});

test("test:browser knows which browsers a file needs", async () => {
	const need = async (file: string) =>
		needs(await Bun.file(join(ROOT, file)).text());
	expect(
		await need("packages/tab-mcp-extension/test/firefox.browser.test.ts"),
	).toEqual(["firefox"]);
	expect(
		await need("packages/tab-mcp-client/test/page.browser.test.ts"),
	).toEqual(["chrome"]);
	expect(
		await need("packages/tab-mcp-extension/test/extension.browser.test.ts"),
	).toEqual(["chrome-for-testing"]);
	for (const file of await browserTestFiles(ROOT))
		expect({ file, needs: (await need(file)).length > 0 }).toEqual({
			file,
			needs: true,
		});
});

test("test:browser counts the passed tests per file of bun's JUnit report", () => {
	const junit = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="bun test" tests="5" assertions="5" failures="0" skipped="3" time="1">
  <testsuite name="a.browser.test.ts" file="a.browser.test.ts" tests="3" assertions="2" failures="0" skipped="1" time="1" hostname="h">
    <testsuite name="inner" file="a.browser.test.ts" line="3" tests="1" assertions="1" failures="0" skipped="0" time="0" hostname="h">
  </testsuite>
  <testsuite name="b.browser.test.ts" file="b.browser.test.ts" tests="2" assertions="0" failures="0" skipped="2" time="0" hostname="h">
</testsuites>`;
	expect(passedPerFile(junit)).toEqual(
		new Map([
			["a.browser.test.ts", 2],
			["b.browser.test.ts", 0],
		]),
	);
});

test("test:browser fails before any run when a browser is missing", () => {
	const run = Bun.spawnSync(
		[process.execPath, join(ROOT, "scripts/test-browser.ts"), "firefox-fill"],
		{
			cwd: ROOT,
			env: {
				...process.env,
				FIREFOX_PATH: "/nonexistent/firefox",
				CHROME_PATH: "/nonexistent/chrome",
			},
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	expect(run.exitCode).toBe(1);
	expect(run.stderr.toString()).toContain(
		"Firefox 128 or newer is needed, none was found",
	);
	expect(run.stdout.toString()).not.toContain("browser tests:");
});
