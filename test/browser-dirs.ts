/**
 * Where the browser tests keep their browsers' profiles and their builds:
 * one folder per test process, `<base>/runs/<pid>-<start>/`, so the sweep
 * (test/browser-sweep.ts) can tell from a folder, and from a browser's
 * profile flag that names it, whether the process that made it still runs.
 * `<pid>-<start>` is the process's PID and its start in seconds since 1970,
 * as `ps` gives it; a PID used again by another process has another start.
 *
 * `<base>` is `TAB_MCP_BROWSER_DIR`, else `~/.cache/tab-mcp/browser-tests`:
 * the same folder for every session on the machine (a sandboxed agent's
 * `TMPDIR` can differ from the owner's; its home does not), and where the
 * machine-wide lock lives too (test/browser-lock.ts).
 *
 * This code decides what the sweep kills and deletes, so when it cannot tell
 * it keeps: a process whose start cannot be read is never "gone", and a
 * browser run whose own start cannot be read does not start.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";

/** Why `dir` cannot be the base, or `undefined` when it can. */
export function refuseBase(dir: string): string | undefined {
	if (!isAbsolute(dir)) return "it is not an absolute path";
	if (/\s/.test(dir))
		return "it has white space (ps prints command lines unquoted)";
	const clean = resolve(dir);
	const parts = clean.split(sep).filter(Boolean);
	if (parts.length < 3)
		return "it is too short (at least three levels, as /a/b/c)";
	const roots = new Set<string>();
	for (const root of [
		homedir(),
		tmpdir(),
		"/tmp",
		"/private/tmp",
		"/var/tmp",
		"/var/folders",
	]) {
		roots.add(resolve(root));
		try {
			roots.add(realpathSync(root));
		} catch {
			// not on this system
		}
	}
	if (roots.has(clean)) return "it is a home or temp folder itself";
	return undefined;
}

/** The base folder, as given (refused when unsafe, see `refuseBase`). */
export function browserTestsBase(): string {
	const given = process.env["TAB_MCP_BROWSER_DIR"];
	if (!given) return join(homedir(), ".cache", "tab-mcp", "browser-tests");
	const why = refuseBase(given);
	if (why !== undefined)
		throw new Error(
			`TAB_MCP_BROWSER_DIR=${given} is refused: ${why}. The sweep kills and deletes in it.`,
		);
	return resolve(given);
}

export const runsDir = (): string => join(browserTestsBase(), "runs");

/**
 * The runs folder as given and as resolved (a home or `TAB_MCP_BROWSER_DIR`
 * through a symbolic link): a browser's command line has the path as it was
 * given to it, a resolved one has the other.
 */
export function runsDirs(): string[] {
	const given = runsDir();
	const all = new Set([given]);
	try {
		all.add(realpathSync(given));
	} catch {
		// not made yet: nothing in it to sweep either
	}
	return [...all];
}

/** `ps`'s environment for `lstart`: English names, times in UTC (`bun test` runs in UTC, other processes in local time). */
export const PS_ENV = { ...process.env, LC_ALL: "C", TZ: "UTC" };

const MONTHS = "JanFebMarAprMayJunJulAugSepOctNovDec";

/** `ps`'s `lstart` ("Sun Nov 22 06:36:28 2026", in UTC by `PS_ENV`) in seconds since 1970. */
export function parseLstart(text: string): number | undefined {
	const m = /^\w{3} (\w{3})\s+(\d+) (\d\d):(\d\d):(\d\d) (\d{4})$/.exec(
		text.trim(),
	);
	if (!m) return undefined;
	const month = MONTHS.indexOf(m[1] as string) / 3;
	if (!Number.isInteger(month) || month < 0) return undefined;
	return (
		Date.UTC(
			Number(m[6]),
			month,
			Number(m[2]),
			Number(m[3]),
			Number(m[4]),
			Number(m[5]),
		) / 1000
	);
}

/** The start of process `pid` in seconds since 1970, from `ps`; `undefined` when `ps` gives none. */
export function processStart(pid: number): number | undefined {
	try {
		const { stdout } = Bun.spawnSync(
			["ps", "-o", "lstart=", "-p", String(pid)],
			{ env: PS_ENV },
		);
		return parseLstart(stdout.toString());
	} catch {
		return undefined;
	}
}

/** Whether `pid` exists: `false` only on ESRCH (no such process); EPERM means it exists. */
export function pidExists(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as { code?: string }).code !== "ESRCH";
	}
}

export type RunState = "alive" | "gone" | "unknown";

/**
 * The state of the process of `<pid>-<start>`, on positive evidence only:
 * "gone" when no process has the PID, or `ps` reads another start for it (a
 * PID used again); "alive" when `ps` reads the same start (a second either
 * way); "unknown" when the PID exists and `ps` says nothing usable.
 */
export function runState(id: string): RunState {
	const m = /^(\d+)-(\d+)$/.exec(id);
	if (!m) return "unknown";
	const pid = Number(m[1]);
	if (!pidExists(pid)) return "gone";
	const start = processStart(pid);
	if (start === undefined) return pidExists(pid) ? "unknown" : "gone";
	return Math.abs(start - Number(m[2])) <= 1 ? "alive" : "gone";
}

let id: string | undefined;

/** This process's `<pid>-<start>`; throws when `ps` cannot give its start after a few tries. */
export function runId(): string {
	if (id !== undefined) return id;
	for (let attempt = 0; attempt < 5; attempt++) {
		const start = processStart(process.pid);
		if (start !== undefined) {
			id = `${process.pid}-${start}`;
			return id;
		}
		Bun.sleepSync(100);
	}
	throw new Error(
		`ps gives no start time for this process (${process.pid}): the browser tests do not run without one, as the lock and the sweep could not tell this run from a finished one`,
	);
}

let dir: string | undefined;

/** This process's folder, made on first use; removed at exit when it is empty. */
export function runDir(): string {
	if (dir !== undefined) return dir;
	const made = join(runsDir(), runId());
	mkdirSync(made, { recursive: true });
	process.on("exit", () => {
		try {
			rmdirSync(made);
		} catch {
			// not empty (a profile its harness keeps, or not reaped yet): the sweep's
		}
	});
	dir = made;
	return made;
}

/** A new folder for a profile or a build, `<run folder>/<prefix>XXXXXX`. */
export function browserTempDir(prefix: string): string {
	return mkdtempSync(join(runDir(), prefix));
}
