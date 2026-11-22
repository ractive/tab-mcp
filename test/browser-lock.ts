/**
 * One browser test run per machine at a time. The lock is the folder
 * `<base>/lock` (test/browser-dirs.ts), made with one `mkdir`, which either
 * makes it or finds it there; `owner.json` in it says who holds it.
 *
 * - `bun run test:browser` takes it before it starts anything, and so does
 *   test/browser-gate.ts for a browser file run with `TAB_MCP_BROWSER=1 bun
 *   test <file>`: nothing gets past it.
 * - The holder's processes take it again freely: the holder puts its id in
 *   `TAB_MCP_BROWSER_LOCK`, which its `bun test` inherits, and a process that
 *   holds it already (another file of the same run) holds it on. A child
 *   gets the variable only with `env: { ...process.env }`: without `env`,
 *   `Bun.spawn` passes the environment the process started with.
 * - A second run says who holds it and waits, polling, up to
 *   `TAB_MCP_BROWSER_WAIT_MS` (15 minutes), then fails; with `wait: false`
 *   (`--no-wait`, or `TAB_MCP_BROWSER_NO_WAIT=1`) it fails at once.
 * - A lock whose holder is gone (its PID does not run, or runs a process
 *   that started at another time), and every process of its run too, is
 *   taken over.
 * - Released at exit, and on SIGINT, SIGTERM and SIGHUP unless the caller
 *   handles those itself (scripts/test-browser.ts waits for its run first).
 */
import {
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { browserTestsBase, runAlive, runId } from "./browser-dirs.ts";

export interface LockOwner {
	id: string;
	pid: number;
	worktree: string;
	filter: string;
	since: string;
}

export const lockDir = (): string => join(browserTestsBase(), "lock");

function readOwner(): LockOwner | undefined {
	try {
		return JSON.parse(
			readFileSync(join(lockDir(), "owner.json"), "utf8"),
		) as LockOwner;
	} catch {
		return undefined;
	}
}

/** How a waiting run names the holder. */
export function describeOwner(owner: LockOwner): string {
	const since = new Date(owner.since);
	// In UTC: bun test runs in UTC, a shell in local time; one way for both.
	const time = Number.isNaN(since.getTime())
		? owner.since
		: `${since.toISOString().slice(11, 16)} UTC`;
	return `browser tests of PID ${owner.pid} in ${owner.worktree} running since ${time}${owner.filter ? ` (${owner.filter})` : ""}`;
}

let held: LockOwner | undefined;

function release(): void {
	if (held === undefined) return;
	if (readOwner()?.id === held.id)
		rmSync(lockDir(), { recursive: true, force: true });
	held = undefined;
}

/** Whether the holder or a process of its run (a `<pid>-<start>.holder` file) still runs. */
function lockAlive(owner: LockOwner): boolean {
	if (runAlive(owner.id)) return true;
	let names: string[] = [];
	try {
		names = readdirSync(lockDir());
	} catch {
		return false;
	}
	return names.some(
		(name) =>
			name.endsWith(".holder") && runAlive(name.slice(0, -".holder".length)),
	);
}

/** Take the lock away from a holder that is gone: rename it first, so only one of two takers gets it. */
function takeOver(): void {
	const stale = `${lockDir()}.stale-${process.pid}`;
	try {
		renameSync(lockDir(), stale);
	} catch {
		return; // someone else took it over first
	}
	rmSync(stale, { recursive: true, force: true });
}

export interface LockOptions {
	wait?: boolean;
	/** What the run tests, for a run that waits. */
	filter?: string;
	/** Release on SIGINT, SIGTERM and SIGHUP, then exit (true). */
	signals?: boolean;
	log?: (line: string) => void;
}

/**
 * Hold the machine-wide lock of the browser tests: `"taken"` when this call
 * took it, `"held"` when this process or the run it belongs to holds it.
 */
export async function holdBrowserLock(
	options: LockOptions = {},
): Promise<"taken" | "held"> {
	const log = options.log ?? ((line: string) => console.error(line));
	const wait = options.wait ?? process.env["TAB_MCP_BROWSER_NO_WAIT"] !== "1";
	const waitMs = Number(process.env["TAB_MCP_BROWSER_WAIT_MS"] ?? 15 * 60_000);
	const poll = Math.min(2_000, Math.max(100, waitMs / 20));
	const deadline = Date.now() + waitMs;
	let told = false;
	mkdirSync(browserTestsBase(), { recursive: true });
	for (;;) {
		const owner = readOwner();
		if (owner !== undefined && owner.id === held?.id) return "held";
		if (
			owner !== undefined &&
			owner.id === process.env["TAB_MCP_BROWSER_LOCK"]
		) {
			// A process of the holder's run: it keeps the lock held should the
			// holder die first (a `kill -9` of `test:browser` leaves its bun test).
			try {
				writeFileSync(join(lockDir(), `${runId()}.holder`), "");
			} catch {
				// the lock went meanwhile
			}
			return "held";
		}
		try {
			mkdirSync(lockDir());
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			if (owner === undefined) {
				// Just made and owner.json not written yet, or left half made.
				const age = Date.now() - statSync(lockDir()).mtimeMs;
				if (age > 10_000) takeOver();
				else await Bun.sleep(100);
				continue;
			}
			if (!lockAlive(owner)) {
				log(`taking over the lock of ${describeOwner(owner)}: it is gone`);
				takeOver();
				continue;
			}
			if (!wait)
				throw new Error(`${describeOwner(owner)}; not waiting (--no-wait)`);
			if (Date.now() > deadline)
				throw new Error(
					`${describeOwner(owner)}; waited ${Math.round(waitMs / 1000)} s, giving up`,
				);
			if (!told) {
				log(
					`${describeOwner(owner)}; waiting (up to ${Math.round(waitMs / 60_000)} min)`,
				);
				told = true;
			}
			await Bun.sleep(poll);
			continue;
		}
		held = {
			id: runId(),
			pid: process.pid,
			worktree: process.cwd(),
			filter: options.filter ?? "",
			since: new Date().toISOString(),
		};
		writeFileSync(join(lockDir(), "owner.json"), JSON.stringify(held));
		process.env["TAB_MCP_BROWSER_LOCK"] = held.id;
		process.on("exit", release);
		if (options.signals ?? true)
			for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const)
				process.once(signal, () => {
					release();
					process.exit(
						128 + (signal === "SIGINT" ? 2 : signal === "SIGTERM" ? 15 : 1),
					);
				});
		return "taken";
	}
}

/** Release the lock now, if this process took it. */
export function releaseBrowserLock(): void {
	release();
}
