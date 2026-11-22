/**
 * `bun run test:browser [filter…]`: the browser tests, the files named
 * `*.browser.test.ts`, which plain `bun test` loads and skips
 * (test/browser-gate.ts). A filter narrows the run to the files whose path
 * contains it: `bun run test:browser fill` runs the extension's two fill
 * files. One `bun test` process, `TAB_MCP_BROWSER=1`.
 */

const ROOT = new URL("..", import.meta.url).pathname;

/** The browser test files under `root`, relative to it and sorted; with filters, those whose path contains one. */
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
		if (filters.length > 0 && !filters.some((f) => file.includes(f))) continue;
		files.push(file);
	}
	return files.sort();
}

async function main(): Promise<number> {
	const filters = process.argv.slice(2);
	const files = await browserTestFiles(ROOT, filters);
	if (files.length === 0) {
		console.error(`no browser test file matches ${filters.join(" ")}`);
		return 1;
	}
	// The next steps go here, around the run: the machine-wide lock (one
	// browser run at a time) and the sweep of browsers a killed run left.
	console.log(
		`browser tests: ${files.length} file${files.length === 1 ? "" : "s"}`,
	);
	const run = Bun.spawn(["bun", "test", ...files.map((f) => `./${f}`)], {
		cwd: ROOT,
		env: { ...process.env, TAB_MCP_BROWSER: "1" },
		stdio: ["inherit", "inherit", "inherit"],
	});
	return await run.exited;
}

if (import.meta.main) process.exit(await main());
