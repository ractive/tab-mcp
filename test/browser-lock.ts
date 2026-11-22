/**
 * One browser test run per machine at a time. The lock is the folder
 * `<base>/lock` (test/browser-dirs.ts), made with one `mkdir`, which either
 * makes it or finds it there; `owner.json` in it says who holds it.
 *
 * - `bun run test:browser` takes it before it starts anything, and so do
 *   test/browser-gate.ts (a browser file run with `TAB_MCP_BROWSER=1 bun test
 *   <file>`), `test:browser --sweep` and the scripts that start a browser by
 *   hand: nothing gets past it.
 * - The holder's processes take it again freely: the holder puts its id in
 *   `TAB_MCP_BROWSER_LOCK`, which its `bun test` inherits, and a process that
 *   holds it already (another file of the same run) holds it on. A child
 *   gets the variable only with `env: { ...process.env }`: without `env`,
 *   `Bun.spawn` passes the environment the process started with. Each such
 *   process leaves `<pid>-<start>.holder` in the lock, so a `kill -9` of
 *   `test:browser` alone does not free it while its `bun test` runs.
 * - A second run says who holds it and waits, polling, up to
 *   `TAB_MCP_BROWSER_WAIT_MS` (15 minutes), then fails; with `wait: false`
 *   (`--no-wait`, or `TAB_MCP_BROWSER_NO_WAIT=1`) it fails at once.
 * - Taken over only on proof: the holder and every process of its run are
 *   gone (test/browser-dirs.ts `runState`; "unknown" keeps), or `owner.json`
 *   is missing or not valid for longer than `GRACE_MS`. A takeover holds
 *   `<base>/lock.takeover` (one `mkdir`) and looks again inside it before it
 *   removes the lock, so of two takers only one removes it, and a fresh lock
 *   the other just made is never removed.
 * - Released at exit, and on SIGINT, SIGTERM and SIGHUP unless the caller
 *   handles those itself (scripts/test-browser.ts waits for its run first).
 */
import {
	mkdirSync,
	readdirSync,
	readFileSync,
	rmdirSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { browserTestsBase, runId, runState } from "./browser-dirs.ts";

export interface LockOwner {
	id: string;
	pid: number;
	worktree: string;
	filter: string;
	since: string;
}

export const lockDir = (): string => join(browserTestsBase(), "lock");
const takeoverDir = (): string => join(browserTestsBase(), "lock.takeover");

/** How long a lock may be without a valid `owner.json` (being made) before it counts as stale. */
export const GRACE_MS = 10_000;
const WAIT_MS = 15 * 60_000;

/** `owner.json` when it has the right shape; `undefined` for a missing or bad one. */
export function parseOwner(text: string): LockOwner | undefined {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		return undefined;
	}
	if (typeof value !== "object" || value === null) return undefined;
	const o = value as Record<string, unknown>;
	if (
		typeof o["id"] !== "string" ||
		!/^\d+-\d+$/.test(o["id"]) ||
		typeof o["pid"] !== "number" ||
		typeof o["worktree"] !== "string" ||
		typeof o["filter"] !== "string" ||
		typeof o["since"] !== "string"
	)
		return undefined;
	return o as unknown as LockOwner;
}

function readOwner(): LockOwner | undefined {
	try {
		return parseOwner(readFileSync(join(lockDir(), "owner.json"), "utf8"));
	} catch {
		return undefined;
	}
}

/** The wait from `TAB_MCP_BROWSER_WAIT_MS`: a positive number of milliseconds, else 15 minutes. */
export function waitMsFrom(value: string | undefined): number {
	const ms = Number(value);
	return value !== undefined &&
		value.trim() !== "" &&
		Number.isFinite(ms) &&
		ms > 0
		? ms
		: WAIT_MS;
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

const lastResort = () =>
	`If no browser test runs on this machine and this does not clear, remove ${lockDir()} by hand.`;

let held: LockOwner | undefined;

function release(): void {
	if (held === undefined) return;
	if (readOwner()?.id === held.id)
		rmSync(lockDir(), { recursive: true, force: true });
	held = undefined;
}

/** Whether the holder or a process of its run (a `<pid>-<start>.holder` file) may still run: only "gone" for all counts. */
function lockAlive(owner: LockOwner): boolean {
	if (runState(owner.id) !== "gone") return true;
	let names: string[];
	try {
		names = readdirSync(lockDir());
	} catch {
		return true; // cannot look: keep
	}
	return names.some(
		(name) =>
			name.endsWith(".holder") &&
			runState(name.slice(0, -".holder".length)) !== "gone",
	);
}

/** The lock's age in milliseconds, `undefined` when it is not there. */
function lockAge(): number | undefined {
	try {
		return Date.now() - statSync(lockDir()).mtimeMs;
	} catch {
		return undefined;
	}
}

/**
 * Remove the lock if it is still the stale one judged so (`judged`: the
 * gone owner's id, or `undefined` for a lock without a valid owner), under
 * the takeover lock. Returns whether it removed it.
 */
function takeOver(judged: string | undefined): boolean {
	try {
		mkdirSync(takeoverDir());
	} catch {
		// another takeover runs, or one died in it
		try {
			if (Date.now() - statSync(takeoverDir()).mtimeMs > 30_000)
				rmdirSync(takeoverDir());
		} catch {
			// gone meanwhile
		}
		return false;
	}
	try {
		const owner = readOwner();
		const stillStale =
			judged === undefined
				? owner === undefined && (lockAge() ?? 0) > GRACE_MS
				: owner?.id === judged && !lockAlive(owner);
		if (!stillStale) return false;
		rmSync(lockDir(), { recursive: true, force: true });
		return true;
	} finally {
		try {
			rmdirSync(takeoverDir());
		} catch {
			// already gone
		}
	}
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
 * Throws when another run holds it and this one may not wait, or waited too
 * long.
 */
export async function holdBrowserLock(
	options: LockOptions = {},
): Promise<"taken" | "held"> {
	const log = options.log ?? ((line: string) => console.error(line));
	const wait = options.wait ?? process.env["TAB_MCP_BROWSER_NO_WAIT"] !== "1";
	const waitMs = waitMsFrom(process.env["TAB_MCP_BROWSER_WAIT_MS"]);
	const poll = Math.min(2_000, Math.max(100, waitMs / 20));
	// Without waiting for a holder, a stale lock still gets this long to clear.
	const deadline = Date.now() + (wait ? waitMs : 5_000);
	let told = false;
	// First: without a readable start of its own, a run does not start.
	const me = runId();
	mkdirSync(browserTestsBase(), { recursive: true });
	const retry = async (why: string) => {
		if (Date.now() > deadline)
			throw new Error(
				`could not take the browser test lock: ${why}. ${lastResort()}`,
			);
		await Bun.sleep(poll);
	};
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
				writeFileSync(join(lockDir(), `${me}.holder`), "");
			} catch {
				// the lock went meanwhile
			}
			return "held";
		}
		try {
			mkdirSync(lockDir());
		} catch (error) {
			if ((error as { code?: string }).code !== "EEXIST") throw error;
			if (owner === undefined) {
				const age = lockAge();
				if (age === undefined) continue; // released meanwhile: try again at once
				if (age > GRACE_MS && takeOver(undefined)) {
					log("took over a lock without a valid owner.json");
					continue;
				}
				await retry("the lock has no valid owner.json");
				continue;
			}
			if (!lockAlive(owner)) {
				if (takeOver(owner.id)) {
					log(`took over the lock of ${describeOwner(owner)}: it is gone`);
					continue;
				}
				await retry(
					`the lock of ${describeOwner(owner)} is stale and could not be taken over`,
				);
				continue;
			}
			if (!wait)
				throw new Error(`${describeOwner(owner)}; not waiting (--no-wait)`);
			if (Date.now() > deadline)
				throw new Error(
					`${describeOwner(owner)}; waited ${Math.round(waitMs / 1000)} s, giving up. ${lastResort()}`,
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
			id: me,
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
