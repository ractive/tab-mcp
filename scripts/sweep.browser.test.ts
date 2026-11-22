/**
 * The sweep (test/browser-sweep.ts) against a real orphan: a test process
 * that started a Chrome is killed with SIGKILL, so its harness cannot reap;
 * the Chrome and its run folder stay. The next sweep must stop that Chrome
 * and remove the folder, and leave this run's own folder alone. One Chrome,
 * once. Runs with `bun run test:browser` only (test/browser-gate.ts).
 */
import { expect, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { findChrome } from "../packages/tab-mcp-client/test/cdp.ts";
import { runDir } from "../test/browser-dirs.ts";
import { browserTests } from "../test/browser-gate.ts";
import { listProcesses, profileFlag, sweep } from "../test/browser-sweep.ts";

const chrome = browserTests ? findChrome() : undefined;
if (browserTests && chrome === undefined && process.env["CI"])
	throw new Error("Chrome is needed for the sweep's browser test in CI");

/** The browsers whose profile flag has a folder of the run folder `folder` (from `ps`, no pattern of the path). */
function browsersOf(folder: string): number[] {
	const flag = profileFlag([dirname(folder)]);
	return listProcesses()
		.filter((p) => flag.exec(p.command)?.[1] === basename(folder))
		.map((p) => p.pid);
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
		let folder: string | undefined;
		try {
			const reader = holder.stdout.getReader();
			const { value } = await reader.read();
			folder = new TextDecoder().decode(value).trim();
			expect(folder).toContain("/runs/");
			expect(browsersOf(folder).length).toBeGreaterThan(0);

			holder.kill("SIGKILL");
			await holder.exited;
			// The harness could not reap: the Chrome outlives its test process.
			expect(browsersOf(folder).length).toBeGreaterThan(0);

			const plan = sweep();
			expect(plan.kept).toBeUndefined();
			expect(plan.remove.map((r) => r.path)).toContain(folder);
			expect(plan.remove.map((r) => r.path)).not.toContain(runDir());
			const stopped = folder;
			expect(await until(() => browsersOf(stopped).length === 0, 10_000)).toBe(
				true,
			);
			expect(existsSync(folder)).toBe(false);
		} finally {
			// Whatever failed above: the holder and its Chrome do not stay.
			holder.kill("SIGKILL");
			await holder.exited;
			if (folder !== undefined) {
				for (const pid of browsersOf(folder))
					try {
						process.kill(pid, "SIGKILL");
					} catch {
						// gone meanwhile
					}
				rmSync(folder, { recursive: true, force: true });
			}
		}
	},
	30_000,
);
