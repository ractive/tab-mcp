/**
 * The sweep (test/browser-sweep.ts) against a real orphan: a test process
 * that started a Chrome is killed with SIGKILL, so its harness cannot reap;
 * the Chrome and its run folder stay. The next sweep must stop that Chrome
 * and remove the folder, and leave this run's own folder alone. One Chrome,
 * once. Runs with `bun run test:browser` only (test/browser-gate.ts).
 */
import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { findChrome } from "../packages/tab-mcp-client/test/cdp.ts";
import { runDir } from "../test/browser-dirs.ts";
import { browserTests } from "../test/browser-gate.ts";
import { sweep } from "../test/browser-sweep.ts";

const chrome = browserTests ? findChrome() : undefined;
if (browserTests && chrome === undefined && process.env["CI"])
	throw new Error("Chrome is needed for the sweep's browser test in CI");

/** The processes whose command line names `folder`. */
function processesOf(folder: string): number[] {
	const { stdout } = Bun.spawnSync(["pgrep", "-f", folder]);
	return stdout.toString().trim().split("\n").filter(Boolean).map(Number);
}

async function until(check: () => boolean, ms: number): Promise<boolean> {
	for (const end = Date.now() + ms; Date.now() < end; await Bun.sleep(100))
		if (check()) return true;
	return check();
}

test.skipIf(chrome === undefined)(
	"a Chrome whose test process was killed with SIGKILL is stopped by the next sweep, and its folder goes",
	async () => {
		const holder = Bun.spawn(
			[
				process.execPath,
				join(import.meta.dir, "hold-chrome.ts"),
				chrome as string,
			],
			{ env: { ...process.env }, stdout: "pipe", stderr: "inherit" },
		);
		const reader = holder.stdout.getReader();
		const { value } = await reader.read();
		const folder = new TextDecoder().decode(value).trim();
		expect(folder).toContain("/runs/");
		expect(processesOf(folder).length).toBeGreaterThan(0);

		holder.kill("SIGKILL");
		await holder.exited;
		// The harness could not reap: the Chrome outlives its test process.
		expect(processesOf(folder).length).toBeGreaterThan(0);

		const plan = sweep();
		expect(plan.remove.map((r) => r.path)).toContain(folder);
		expect(plan.remove.map((r) => r.path)).not.toContain(runDir());
		expect(await until(() => processesOf(folder).length === 0, 10_000)).toBe(
			true,
		);
		expect(existsSync(folder)).toBe(false);
	},
	30_000,
);
