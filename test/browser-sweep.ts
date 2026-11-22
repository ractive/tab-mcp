/**
 * The sweep before a browser test run: the browsers and folders of test
 * runs that are gone. A harness reaps its own browsers when its process
 * ends (PR 204), but not after a `kill -9` or a crash; this is the rest.
 *
 * - A browser is this project's test browser only when its command line
 *   names a run folder (`<base>/runs/<pid>-<start>/`, test/browser-dirs.ts);
 *   it is stopped only when that run is gone. Never by a program's name, so
 *   the owner's own Chrome and Firefox, and anything else, are never chosen.
 * - Until every branch writes there: a browser whose profile is one of the
 *   old temp folders (`tab-mcp-chrome-XXXXXX` and the others in
 *   `OLD_PREFIXES`) is stopped when nothing outside its own processes is its
 *   parent but launchd (pid 1): its test process is gone.
 * - Folders: a run folder whose run is gone; an old temp folder older than an
 *   hour that no process names.
 *
 * `planSweep` decides from a process list and a folder list alone (tested on
 * made-up ones); `sweep` reads the real ones and carries the plan out.
 */
import { readdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PS_ENV, parseLstart, runsDir } from "./browser-dirs.ts";

export interface Proc {
	pid: number;
	ppid: number;
	/** Seconds since 1970. */
	start: number;
	command: string;
}

export interface Folder {
	path: string;
	mtimeMs: number;
}

export interface Plan {
	kill: { pid: number; command: string; why: string }[];
	remove: { path: string; why: string }[];
}

/** The temp folders the harnesses and browser tests made before the run folders. */
export const OLD_PREFIXES = [
	"tab-mcp-extension",
	"tab-mcp-ext",
	"tab-mcp-ext-profile",
	"tab-mcp-ext-build",
	"tab-mcp-chrome",
	"tab-mcp-firefox",
	"tab-mcp-firefox-ext",
	"tab-mcp-fill",
	"tab-mcp-firefox-fill",
	"tab-mcp-always-cert",
	"webmcp-spike",
];

/** A name `mkdtemp` made from one of the old prefixes. */
const OLD_NAME = new RegExp(`^(${OLD_PREFIXES.join("|")})-[A-Za-z0-9]{6}$`);
/** An old profile in a browser's command line (Chrome's flag, Firefox's). */
const OLD_PROFILE = new RegExp(
	`(?:--user-data-dir=|--profile )(\\S*/(?:${OLD_PREFIXES.join("|")})-[A-Za-z0-9]{6})(?=\\s|$)`,
);
const HOUR = 3_600_000;

const escapeRegExp = (text: string) =>
	text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function planSweep(input: {
	processes: Proc[];
	folders: Folder[];
	runsDir: string;
	now: number;
}): Plan {
	const { processes, folders, now } = input;
	const alive = (id: string) => {
		const m = /^(\d+)-(\d+)$/.exec(id);
		return processes.some(
			(p) =>
				m !== null &&
				p.pid === Number(m[1]) &&
				Math.abs(p.start - Number(m[2])) <= 1,
		);
	};
	const runIn = new RegExp(
		`${escapeRegExp(input.runsDir)}/(\\d+-\\d+)(?:/|\\s|$)`,
	);
	const plan: Plan = { kill: [], remove: [] };

	const old = new Map<string, Proc[]>();
	for (const p of processes) {
		const run = runIn.exec(p.command)?.[1];
		if (run !== undefined) {
			if (!alive(run))
				plan.kill.push({
					pid: p.pid,
					command: p.command,
					why: `its run ${run} is gone`,
				});
			continue;
		}
		const profile = OLD_PROFILE.exec(p.command)?.[1];
		if (profile !== undefined)
			old.set(profile, [...(old.get(profile) ?? []), p]);
	}
	for (const [profile, group] of old) {
		const pids = new Set(group.map((p) => p.pid));
		const owned = group.some((p) => p.ppid !== 1 && !pids.has(p.ppid));
		if (owned) continue;
		for (const p of group)
			plan.kill.push({
				pid: p.pid,
				command: p.command,
				why: `old profile ${profile}, no test process above it`,
			});
	}

	const named = (path: string) =>
		processes.some((p) => p.command.includes(path));
	for (const f of folders) {
		const name = f.path.slice(f.path.lastIndexOf("/") + 1);
		if (f.path.startsWith(`${input.runsDir}/`)) {
			if (/^\d+-\d+$/.test(name) && !alive(name))
				plan.remove.push({ path: f.path, why: `its run ${name} is gone` });
		} else if (OLD_NAME.test(name) && now - f.mtimeMs > HOUR && !named(f.path))
			plan.remove.push({ path: f.path, why: "old temp folder, unused" });
	}
	return plan;
}

/** Every process, as `ps` lists it. */
export function listProcesses(): Proc[] {
	const { stdout } = Bun.spawnSync(
		["ps", "-axo", "pid=,ppid=,lstart=,command="],
		{
			env: PS_ENV,
		},
	);
	const list: Proc[] = [];
	for (const line of stdout.toString().split("\n")) {
		const m =
			/^\s*(\d+)\s+(\d+)\s+(\w{3} \w{3}\s+\d+ \d\d:\d\d:\d\d \d{4})\s+(.*)$/.exec(
				line,
			);
		const start = m === null ? undefined : parseLstart(m[3] as string);
		if (m === null || start === undefined) continue;
		list.push({
			pid: Number(m[1]),
			ppid: Number(m[2]),
			start,
			command: m[4] as string,
		});
	}
	return list;
}

/** The temp folders the old harnesses used, each once. */
export function tempRoots(): string[] {
	const roots = new Set<string>();
	for (const dir of [tmpdir(), process.env["TMPDIR"], "/tmp"]) {
		if (!dir) continue;
		try {
			roots.add(realpathSync(dir));
		} catch {
			// not there
		}
	}
	return [...roots];
}

/** The run folders, and the old temp folders in `roots`. */
export function listFolders(roots: string[] = tempRoots()): Folder[] {
	const folders: Folder[] = [];
	const add = (dir: string, keep: (name: string) => boolean) => {
		let names: string[];
		try {
			names = readdirSync(dir);
		} catch {
			return;
		}
		for (const name of names) {
			if (!keep(name)) continue;
			const path = join(dir, name);
			try {
				const stat = statSync(path);
				if (stat.isDirectory()) folders.push({ path, mtimeMs: stat.mtimeMs });
			} catch {
				// gone meanwhile
			}
		}
	};
	add(runsDir(), (name) => /^\d+-\d+$/.test(name));
	for (const root of roots) add(root, (name) => OLD_NAME.test(name));
	return folders;
}

/** Sweep, or with `dryRun` only say what would go. */
export function sweep(
	options: { dryRun?: boolean; log?: (line: string) => void } = {},
): Plan {
	const log = options.log ?? ((line: string) => console.error(line));
	const plan = planSweep({
		processes: listProcesses(),
		folders: listFolders(),
		runsDir: runsDir(),
		now: Date.now(),
	});
	const verb = options.dryRun ? "would stop" : "stopping";
	for (const k of plan.kill) {
		log(`sweep: ${verb} ${k.pid} (${k.why}): ${k.command.slice(0, 160)}`);
		if (!options.dryRun)
			try {
				process.kill(k.pid, "SIGKILL");
			} catch {
				// gone meanwhile
			}
	}
	// The stopped browsers out of their folders first (up to 3 s).
	const running = (pid: number) => {
		try {
			process.kill(pid, 0);
			return true;
		} catch {
			return false;
		}
	};
	if (!options.dryRun)
		for (
			const end = Date.now() + 3_000;
			Date.now() < end && plan.kill.some((k) => running(k.pid));
		)
			Bun.sleepSync(50);
	for (const r of plan.remove) {
		log(
			`sweep: ${options.dryRun ? "would remove" : "removing"} ${r.path} (${r.why})`,
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
