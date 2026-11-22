/**
 * The sweep before and after a browser test run: the browsers and folders of
 * test runs that are gone. A harness reaps its own browsers when its process
 * ends (PR 204), but not after a `kill -9` or a crash; this is the rest.
 *
 * It kills and deletes on the owner's machine, so it acts only on what it can
 * prove is this project's and dead, and when anything is uncertain it keeps:
 *
 * - It touches nothing outside its own parent folder (`<base>/runs`,
 *   test/browser-dirs.ts). A process is chosen only when a browser profile
 *   flag of it, as a whole argument, has a run folder as its value
 *   (`--user-data-dir=<runs>/<pid>-<start>/…`, Firefox's `--profile` or
 *   `-profile <runs>/<pid>-<start>/…`): never by a program's name, and never
 *   an editor, a pager or a shell that names such a folder.
 * - A run is gone only when the process listing proves it: the listing was
 *   read and parsed whole, it has the sweeping process itself with the start
 *   it knows, and the run's PID is not in it or has another start. Before
 *   acting, each run is asked again (`process.kill(pid, 0)` and `ps`); only
 *   "gone" both times counts. A listing that fails, is empty, has a line that
 *   does not parse or lacks the sweeper keeps everything and says why.
 * - Folders are listed before processes, so a folder in the list existed
 *   when the processes were listed: a live creator is in that listing.
 * - The sweep holds the machine-wide lock (test/browser-lock.ts): from
 *   `test:browser`, the gate, or `test:browser --sweep`.
 *
 * `planSweep` decides from a folder list and a process list alone (tested on
 * made-up ones); `sweep` reads the real ones and carries the plan out.
 */
import { readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import {
	PS_ENV,
	parseLstart,
	pidExists,
	runId,
	runState,
	runsDirs,
} from "./browser-dirs.ts";

export interface Proc {
	pid: number;
	ppid: number;
	/** Seconds since 1970. */
	start: number;
	command: string;
}

export interface Plan {
	kill: { pid: number; run: string; command: string }[];
	remove: { path: string; run: string }[];
	/** Why nothing is done, when the listing could not prove anything. */
	kept?: string;
}

const RUN_ID = /^\d+-\d+$/;

const escapeRegExp = (text: string) =>
	text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A browser profile flag, a whole argument, whose value is in a run folder: the run's id is group 1. */
export function profileFlag(runsDirs: string[]): RegExp {
	const runs = runsDirs.map(escapeRegExp).join("|");
	return new RegExp(
		`(?:^|\\s)(?:--user-data-dir=|--?profile\\s+)(?:${runs})/(\\d+-\\d+)(?:/\\S*)?(?=\\s|$)`,
	);
}

export function planSweep(input: {
	/** The run folders, listed before the processes. */
	folders: string[];
	processes: Proc[];
	runsDirs: string[];
	/** The sweeping process, which the listing must contain. */
	self: { pid: number; start: number };
}): Plan {
	const { processes, self } = input;
	if (processes.length === 0)
		return { kill: [], remove: [], kept: "the process listing is empty" };
	if (
		!processes.some(
			(p) => p.pid === self.pid && Math.abs(p.start - self.start) <= 1,
		)
	)
		return {
			kill: [],
			remove: [],
			kept: `the process listing lacks this process (${self.pid}) with its start: it cannot be trusted`,
		};
	const gone = (run: string) => {
		const [pid, start] = run.split("-").map(Number) as [number, number];
		if (pid === self.pid) return false;
		const listed = processes.filter((p) => p.pid === pid);
		return listed.every((p) => Math.abs(p.start - start) > 1);
	};
	const flag = profileFlag(input.runsDirs);
	const plan: Plan = { kill: [], remove: [] };
	for (const p of processes) {
		const run = flag.exec(p.command)?.[1];
		if (run !== undefined && gone(run))
			plan.kill.push({ pid: p.pid, run, command: p.command });
	}
	for (const path of input.folders) {
		const run = path.slice(path.lastIndexOf("/") + 1);
		if (
			RUN_ID.test(run) &&
			input.runsDirs.some((dir) => path === `${dir}/${run}`) &&
			gone(run)
		)
			plan.remove.push({ path, run });
	}
	return plan;
}

/** Every process, as `ps` lists it; throws when `ps` fails or a line does not parse. */
export function listProcesses(): Proc[] {
	const run = Bun.spawnSync(["ps", "-axo", "pid=,ppid=,lstart=,command="], {
		env: PS_ENV,
	});
	if (!run.success)
		throw new Error(
			`ps failed (${run.exitCode}): ${run.stderr.toString().trim()}`,
		);
	const list: Proc[] = [];
	for (const line of run.stdout.toString().split("\n")) {
		if (line.trim() === "") continue;
		const m =
			/^\s*(\d+)\s+(\d+)\s+(\w{3} \w{3}\s+\d+ \d\d:\d\d:\d\d \d{4})\s+(.*)$/.exec(
				line,
			);
		const start = m === null ? undefined : parseLstart(m[3] as string);
		if (m === null || start === undefined)
			throw new Error(
				`ps printed a line this does not understand: ${line.slice(0, 120)}`,
			);
		list.push({
			pid: Number(m[1]),
			ppid: Number(m[2]),
			start,
			command: m[4] as string,
		});
	}
	return list;
}

/** The run folders. */
export function listFolders(dirs: string[] = runsDirs()): string[] {
	const folders: string[] = [];
	for (const dir of dirs) {
		let names: string[];
		try {
			names = readdirSync(dir);
		} catch {
			continue;
		}
		for (const name of names) {
			if (!RUN_ID.test(name)) continue;
			const path = join(dir, name);
			try {
				if (statSync(path).isDirectory()) folders.push(path);
			} catch {
				// gone meanwhile
			}
		}
	}
	return folders;
}

export interface SweepOptions {
	dryRun?: boolean;
	log?: (line: string) => void;
	/** For tests: where the listings come from. */
	listFolders?: () => string[];
	listProcesses?: () => Proc[];
	/** For tests: the second witness, asked before acting on a run. */
	confirmGone?: (run: string) => boolean;
	runsDirs?: string[];
	self?: { pid: number; start: number };
}

/** Sweep, or with `dryRun` only say what would go. Never throws: in doubt it keeps everything. */
export function sweep(options: SweepOptions = {}): Plan {
	const log = options.log ?? ((line: string) => console.error(line));
	let plan: Plan;
	try {
		const dirs = options.runsDirs ?? runsDirs();
		// Folders first: a folder listed here existed when the processes were listed.
		const folders = (options.listFolders ?? (() => listFolders(dirs)))();
		const processes = (options.listProcesses ?? listProcesses)();
		const self = options.self ?? {
			pid: process.pid,
			start: Number(runId().split("-")[1]),
		};
		plan = planSweep({ folders, processes, runsDirs: dirs, self });
	} catch (error) {
		plan = { kill: [], remove: [], kept: (error as Error).message };
	}
	if (plan.kept !== undefined) {
		log(`sweep: keeping everything: ${plan.kept}`);
		return plan;
	}
	// The second witness: each run asked again; only "gone" both times counts.
	const confirm =
		options.confirmGone ?? ((run: string) => runState(run) === "gone");
	const confirmed = new Map<string, boolean>();
	const isGone = (run: string) => {
		if (!confirmed.has(run)) {
			const yes = confirm(run);
			confirmed.set(run, yes);
			if (!yes)
				log(`sweep: keeping run ${run}: not proven gone on a second look`);
		}
		return confirmed.get(run) as boolean;
	};
	plan = {
		kill: plan.kill.filter((k) => isGone(k.run)),
		remove: plan.remove.filter((r) => isGone(r.run)),
	};
	for (const k of plan.kill) {
		log(
			`sweep: ${options.dryRun ? "would stop" : "stopping"} ${k.pid} (its run ${k.run} is gone): ${k.command.slice(0, 160)}`,
		);
		if (!options.dryRun)
			try {
				process.kill(k.pid, "SIGKILL");
			} catch {
				// gone meanwhile
			}
	}
	// The stopped browsers out of their folders first (up to 3 s).
	if (!options.dryRun)
		for (
			const end = Date.now() + 3_000;
			Date.now() < end && plan.kill.some((k) => pidExists(k.pid));
		)
			Bun.sleepSync(50);
	for (const r of plan.remove) {
		log(
			`sweep: ${options.dryRun ? "would remove" : "removing"} ${r.path} (its run ${r.run} is gone)`,
		);
		if (!options.dryRun)
			try {
				rmSync(r.path, { recursive: true, force: true });
			} catch (error) {
				log(`sweep: could not remove ${r.path}: ${(error as Error).message}`);
			}
	}
	return plan;
}
