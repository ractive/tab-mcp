/**
 * The convention that keeps browsers out of plain `bun test`: a test file
 * that can launch a browser is named `*.browser.test.ts`, imports
 * test/browser-gate.ts, and looks for its browser only behind the gate.
 * `bun run test:browser` runs exactly these files.
 *
 * A file can launch a browser when it reaches a harness through its imports
 * (at any depth) and finds a browser: it, or a module on the way that is not
 * a harness, calls a harness's `find…()` or reads `CHROME_PATH` or
 * `FIREFOX_PATH`. Every harness launches only the binary it is given, so a
 * file that takes a pure helper from a harness and finds no browser
 * (`cdp.test.ts`, its `profilePattern`) launches none and stays in the fast
 * suite.
 */
import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { browserTestFiles } from "./test-browser.ts";

const ROOT = resolve(import.meta.dir, "..");

/** The modules that launch a browser. */
const HARNESSES = [
	"packages/tab-mcp-client/test/cdp.ts",
	"packages/tab-mcp-extension/test/browser.ts",
	"packages/tab-mcp-extension/test/firefox.ts",
	"test/webmcp-spike/browser.ts",
].map((path) => join(ROOT, path));

const GATE = join(ROOT, "test/browser-gate.ts");

const transpilers = {
	ts: new Bun.Transpiler({ loader: "ts" }),
	tsx: new Bun.Transpiler({ loader: "tsx" }),
};

/** The scripts `file` imports with a relative path, resolved. */
async function imports(file: string): Promise<string[]> {
	const source = await Bun.file(file).text();
	return transpilers[file.endsWith(".tsx") ? "tsx" : "ts"]
		.scanImports(source)
		.map((i) => i.path)
		.filter((path) => path.startsWith(".") && /\.(ts|tsx)$/.test(path))
		.map((path) => resolve(dirname(file), path))
		.filter((path) => existsSync(path));
}

/** A call of a harness's browser discovery, or a read of where a browser is. */
const FINDS =
	/\bfind(Chrome|ChromeForTesting|Firefox)\(|\b(CHROME|FIREFOX)_PATH\b/;

/**
 * Whether `file` can launch a browser: it reaches a harness through its
 * relative imports, and it or a module it reaches that is not a harness
 * finds a browser.
 */
async function launchesBrowser(file: string): Promise<boolean> {
	const seen = new Set<string>();
	const todo = [file];
	let harness = false;
	let finds = false;
	for (let next = todo.pop(); next !== undefined; next = todo.pop()) {
		if (seen.has(next)) continue;
		seen.add(next);
		if (HARNESSES.includes(next)) {
			harness = true;
			continue;
		}
		if (FINDS.test(await Bun.file(next).text())) finds = true;
		todo.push(...(await imports(next)));
	}
	return harness && finds;
}

async function testFiles(): Promise<string[]> {
	const files: string[] = [];
	for await (const file of new Bun.Glob("**/*.test.{ts,tsx}").scan({
		cwd: ROOT,
		onlyFiles: true,
	}))
		if (!file.split("/").includes("node_modules")) files.push(file);
	return files.sort();
}

test("the harnesses exist", () => {
	for (const harness of [...HARNESSES, GATE])
		expect(existsSync(harness)).toBe(true);
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
					/\bfind(Chrome|ChromeForTesting|Firefox)\(/.test(line) &&
					!line.includes("browserTests"),
			);
		expect({ file, ungated }).toEqual({ file, ungated: [] });
	}
});

interface Workflow {
	on: Record<string, Record<string, unknown> | null>;
	jobs: Record<string, { steps: { run?: string }[] }>;
}

const workflow = async (name: string): Promise<Workflow> =>
	Bun.YAML.parse(
		await Bun.file(join(ROOT, ".github/workflows", name)).text(),
	) as Workflow;

const runs = (wf: Workflow, job: string): string[] =>
	(wf.jobs[job]?.steps ?? []).flatMap((s) => (s.run ? [s.run.trim()] : []));

test("CI runs verify (the required check) and the browser tests on every pull request, unfiltered", async () => {
	const ci = await workflow("ci.yml");
	expect(runs(ci, "verify")).toContain("bun run verify");
	expect(runs(ci, "browser")).toContain("bun run test:browser");
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

test("a filter narrows test:browser to the files whose path contains it", async () => {
	const fill = await browserTestFiles(ROOT, ["fill"]);
	expect(fill).toEqual([
		"packages/tab-mcp-extension/test/fill.browser.test.ts",
		"packages/tab-mcp-extension/test/firefox-fill.browser.test.ts",
	]);
});
