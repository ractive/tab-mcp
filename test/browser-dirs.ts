/**
 * Where the browser tests keep their browsers' profiles and their builds:
 * one folder per test process, `<base>/runs/<pid>-<start>/`, so the sweep
 * (test/browser-sweep.ts) can tell from a folder, and from a browser's
 * command line that names it, whether the process that made it still runs.
 * `<pid>-<start>` is the process's PID and its start in seconds since 1970,
 * as `ps` gives it; a PID used again by another process has another start.
 *
 * `<base>` is `TAB_MCP_BROWSER_DIR`, else `~/.cache/tab-mcp/browser-tests`:
 * the same folder for every session on the machine (a sandboxed agent's
 * `TMPDIR` can differ from the owner's; its home does not), and where the
 * machine-wide lock lives too (test/browser-lock.ts).
 */
import { mkdirSync, mkdtempSync, rmdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function browserTestsBase(): string {
	return (
		process.env["TAB_MCP_BROWSER_DIR"] ||
		join(homedir(), ".cache", "tab-mcp", "browser-tests")
	);
}

export const runsDir = (): string => join(browserTestsBase(), "runs");

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

/** The start of process `pid` in seconds since 1970, from `ps`; `undefined` when it does not run. */
export function processStart(pid: number): number | undefined {
	try {
		const { stdout } = Bun.spawnSync(
			["ps", "-o", "lstart=", "-p", String(pid)],
			{
				env: PS_ENV,
			},
		);
		return parseLstart(stdout.toString());
	} catch {
		return undefined;
	}
}

/** Whether the process of `<pid>-<start>` still runs: the PID runs, and started then (a second either way). */
export function runAlive(id: string): boolean {
	const m = /^(\d+)-(\d+)$/.exec(id);
	if (!m) return false;
	const start = processStart(Number(m[1]));
	return start !== undefined && Math.abs(start - Number(m[2])) <= 1;
}

let id: string | undefined;

/** This process's `<pid>-<start>`. */
export function runId(): string {
	id ??= `${process.pid}-${processStart(process.pid) ?? Math.floor(Date.now() / 1000)}`;
	return id;
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
			// not empty (a profile its harness keeps, or not reaped): the sweep's
		}
	});
	dir = made;
	return made;
}

/** A new folder for a profile or a build, `<run folder>/<prefix>XXXXXX`. */
export function browserTempDir(prefix: string): string {
	return mkdtempSync(join(runDir(), prefix));
}
