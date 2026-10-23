/**
 * The React tests again with React 18.3 (the lowest version of the peer
 * range): a separate `bun test` whose preload maps `react` and `react-dom`
 * to the `react-18` and `react-dom-18` dev dependencies.
 */
import { expect, test } from "bun:test";
import { join } from "node:path";

test("the React bindings pass their tests with React 18.3", () => {
	const root = join(import.meta.dir, "..");
	const run = Bun.spawnSync(
		[
			"bun",
			"test",
			"--preload",
			"./test/react-18.preload.ts",
			"./test/react.test.tsx",
			"./test/react-server.test.tsx",
		],
		{ cwd: root, env: { ...process.env, TAB_MCP_REACT: "18" } },
	);
	const output = run.stdout.toString() + run.stderr.toString();
	if (run.exitCode !== 0) console.error(output);
	expect(run.exitCode).toBe(0);
	expect(output).toMatch(/\b0 fail\b/);
	expect(output).not.toContain("Warning:");
	const passed = Number(/(\d+) pass/.exec(output)?.[1] ?? 0);
	expect(passed).toBeGreaterThanOrEqual(14);
}, 60_000);
