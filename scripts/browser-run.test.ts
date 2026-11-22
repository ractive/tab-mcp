/**
 * The machine-wide lock of the browser tests (test/browser-lock.ts) with real
 * processes in a lock folder of their own, and the sweep's choice
 * (test/browser-sweep.ts) on made-up process and folder lists.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseLstart, refuseBase, runId } from "../test/browser-dirs.ts";
import { GRACE_MS, parseOwner, waitMsFrom } from "../test/browser-lock.ts";
import {
	type Proc,
	planSweep,
	profileFlag,
	sweep,
} from "../test/browser-sweep.ts";

const LOCK = resolve(import.meta.dir, "../test/browser-lock.ts");
let base: string;

beforeAll(() => {
	base = mkdtempSync(join(tmpdir(), "tab-mcp-lock-test-"));
});
afterAll(() => rmSync(base, { recursive: true, force: true }));

/** A process that takes the lock (`filter` names it), says "taken" or "held", and keeps it `holdMs`. */
function holder(
	filter: string,
	holdMs: number,
	env: Record<string, string> = {},
) {
	const script = `
		import { holdBrowserLock } from ${JSON.stringify(LOCK)};
		try {
			console.log(await holdBrowserLock({ filter: ${JSON.stringify(filter)} }), Date.now());
		} catch (error) {
			console.log("failed", error.message);
			process.exit(1);
		}
		await Bun.sleep(${holdMs});
		console.log("done", Date.now());
	`;
	return Bun.spawn([process.execPath, "-e", script], {
		env: {
			...process.env,
			TAB_MCP_BROWSER_DIR: base,
			// Shorter than as shipped (2 s, 5 s), with the same rules.
			TAB_MCP_BROWSER_POLL_MS: "50",
			TAB_MCP_BROWSER_STALE_WAIT_MS: "500",
			...env,
		},
		stdout: "pipe",
		stderr: "pipe",
	});
}

async function firstLine(stream: ReadableStream<Uint8Array>): Promise<string> {
	const reader = stream.getReader();
	let text = "";
	while (!text.includes("\n")) {
		const { value, done } = await reader.read();
		if (done) break;
		text += new TextDecoder().decode(value);
	}
	reader.releaseLock();
	return text.split("\n")[0] as string;
}

test("a second run waits, says who holds the lock, and runs once it is free", async () => {
	const first = holder("first", 600);
	expect(await firstLine(first.stdout)).toStartWith("taken");
	const second = holder("second", 0, { TAB_MCP_BROWSER_WAIT_MS: "20000" });
	const [line, firstEnd] = await Promise.all([
		firstLine(second.stdout),
		first.exited.then(() => Date.now()),
	]);
	expect(line).toStartWith("taken");
	expect(Number(line.split(" ")[1])).toBeGreaterThanOrEqual(firstEnd - 50);
	const said = await new Response(second.stderr).text();
	expect(said).toContain(`browser tests of PID ${first.pid}`);
	expect(said).toContain("(first); waiting");
	expect(await second.exited).toBe(0);
}, 30_000);

test("--no-wait fails at once while another run holds the lock", async () => {
	const first = holder("first", 3_000);
	expect(await firstLine(first.stdout)).toStartWith("taken");
	const started = Date.now();
	const second = holder("second", 0, { TAB_MCP_BROWSER_NO_WAIT: "1" });
	const line = await firstLine(second.stdout);
	expect(line).toContain(`browser tests of PID ${first.pid}`);
	expect(line).toContain("not waiting");
	expect(await second.exited).toBe(1);
	expect(Date.now() - started).toBeLessThan(2_500);
	first.kill();
	await first.exited;
}, 30_000);

test("a waiting run gives up after its limit", async () => {
	const first = holder("first", 3_000);
	expect(await firstLine(first.stdout)).toStartWith("taken");
	const second = holder("second", 0, { TAB_MCP_BROWSER_WAIT_MS: "200" });
	expect(await firstLine(second.stdout)).toContain("giving up");
	expect(await second.exited).toBe(1);
	first.kill();
	await first.exited;
}, 30_000);

test("the lock of a run that is gone is taken over", async () => {
	const gone = Bun.spawn(["true"]);
	await gone.exited;
	mkdirSync(join(base, "lock"), { recursive: true });
	writeFileSync(
		join(base, "lock", "owner.json"),
		JSON.stringify({
			id: `${gone.pid}-1700000000`,
			pid: gone.pid,
			worktree: "/somewhere",
			filter: "",
			since: new Date().toISOString(),
		}),
	);
	const next = holder("next", 0, { TAB_MCP_BROWSER_NO_WAIT: "1" });
	expect(await firstLine(next.stdout)).toStartWith("taken");
	expect(await new Response(next.stderr).text()).toContain("it is gone");
	expect(await next.exited).toBe(0);
}, 30_000);

test("a lock whose holder is gone but whose run still has a process is not taken over", async () => {
	const gone = Bun.spawn(["true"]);
	await gone.exited;
	rmSync(join(base, "lock"), { recursive: true, force: true });
	mkdirSync(join(base, "lock"), { recursive: true });
	writeFileSync(
		join(base, "lock", "owner.json"),
		JSON.stringify({
			id: `${gone.pid}-1700000000`,
			pid: gone.pid,
			worktree: "/somewhere",
			filter: "",
			since: new Date().toISOString(),
		}),
	);
	// This test process stands for the run's bun test, still at work.
	writeFileSync(join(base, "lock", `${runId()}.holder`), "");
	const next = holder("next", 0, { TAB_MCP_BROWSER_NO_WAIT: "1" });
	expect(await firstLine(next.stdout)).toContain("not waiting");
	expect(await next.exited).toBe(1);
	rmSync(join(base, "lock"), { recursive: true, force: true });
}, 30_000);

test("the holder's own processes hold it on: no deadlock in a run", async () => {
	const script = `
		import { holdBrowserLock } from ${JSON.stringify(LOCK)};
		console.log(await holdBrowserLock(), await holdBrowserLock());
		const child = Bun.spawnSync([process.execPath, "-e",
			"import { holdBrowserLock } from " + ${JSON.stringify(JSON.stringify(LOCK))} + "; console.log(await holdBrowserLock({ wait: false }));"],
			{ env: { ...process.env } });
		console.log(child.stdout.toString().trim());
	`;
	const run = Bun.spawnSync([process.execPath, "-e", script], {
		env: { ...process.env, TAB_MCP_BROWSER_DIR: base },
	});
	expect(run.stdout.toString().trim().split("\n")).toEqual([
		"taken held",
		"held",
	]);
	expect(run.exitCode).toBe(0);
}, 30_000);

/** A lock folder as a run that is gone left it, its `owner.json` given as text. */
async function staleLock(ownerJson: string, ageMs = 0) {
	rmSync(join(base, "lock"), { recursive: true, force: true });
	mkdirSync(join(base, "lock"), { recursive: true });
	writeFileSync(join(base, "lock", "owner.json"), ownerJson);
	if (ageMs > 0) {
		const then = (Date.now() - ageMs) / 1000;
		utimesSync(join(base, "lock"), then, then);
	}
}

async function goneOwner(): Promise<string> {
	const gone = Bun.spawn(["true"]);
	await gone.exited;
	return JSON.stringify({
		id: `${gone.pid}-1700000000`,
		pid: gone.pid,
		worktree: "/somewhere",
		filter: "",
		since: new Date().toISOString(),
	});
}

/** The lines a holder printed, as [word, time]. */
async function lines(proc: ReturnType<typeof holder>) {
	const text = await new Response(proc.stdout).text();
	return text
		.trim()
		.split("\n")
		.map((l) => l.split(" ") as [string, string]);
}

test("two runs taking over the same stale lock: one wins, the other waits for it", async () => {
	await staleLock(await goneOwner());
	const env = { TAB_MCP_BROWSER_WAIT_MS: "20000" };
	const a = holder("a", 300, env);
	const b = holder("b", 300, env);
	const [la, lb] = await Promise.all([lines(a), lines(b)]);
	expect(await a.exited).toBe(0);
	expect(await b.exited).toBe(0);
	const span = (l: [string, string][]) => {
		expect(l.map((x) => x[0])).toEqual(["taken", "done"]);
		return [Number(l[0]?.[1]), Number(l[1]?.[1])] as const;
	};
	const [as, ae] = span(la);
	const [bs, be] = span(lb);
	// Never both at once: one holds it from taking to done, then the other.
	expect(ae <= bs || be <= as).toBe(true);
}, 30_000);

test("owner.json must have its shape; a bad one is taken over after the grace time", async () => {
	for (const bad of [
		"",
		"null",
		"{}",
		'{"id":"x"}',
		'{"pid":1,"id":"1-2"}',
		"[1]",
	])
		expect({ bad, owner: parseOwner(bad) }).toEqual({ bad, owner: undefined });
	expect(parseOwner(await goneOwner())).toBeDefined();
	// Fresh: being made, perhaps; a run with --no-wait gives up after a short while.
	await staleLock("null");
	const fresh = holder("fresh", 0, { TAB_MCP_BROWSER_NO_WAIT: "1" });
	expect(await firstLine(fresh.stdout)).toContain("no valid owner.json");
	expect(await fresh.exited).toBe(1);
	for (const bad of ["null", '{"pid": 1}', "not json"]) {
		// Older than the grace time: stale, taken over.
		await staleLock(bad, GRACE_MS + 5_000);
		const next = holder("next", 0, { TAB_MCP_BROWSER_NO_WAIT: "1" });
		expect(await firstLine(next.stdout)).toStartWith("taken");
		expect(await next.exited).toBe(0);
	}
}, 60_000);

test("a wait that is not a positive number of milliseconds is the default", () => {
	for (const value of [undefined, "", "10m", "NaN", "-5", "0", "Infinity"])
		expect(waitMsFrom(value)).toBe(15 * 60_000);
	expect(waitMsFrom("500")).toBe(500);
});

const RUNS = "/home/u/.cache/tab-mcp/browser-tests/runs";
/** The same folder through a symbolic link of the home. */
const REAL = "/Volumes/data/u/.cache/tab-mcp/browser-tests/runs";
const SELF = { pid: 42, start: 1_000 };

function proc(pid: number, ppid: number, command: string, start = 1_000): Proc {
	return { pid, ppid, start, command };
}

/** A listing with the sweeper in it, as the real one has. */
const listing = (...processes: Proc[]) => [
	proc(SELF.pid, 1, "bun scripts/test-browser.ts"),
	...processes,
];

const plan = (processes: Proc[], folders: string[] = []) =>
	planSweep({ processes, folders, runsDirs: [RUNS, REAL], self: SELF });

test("the sweep stops a gone run's browsers by their profile flag, and nothing else", () => {
	const { kill } = plan(
		listing(
			// A live run (pid 100) and its Chrome with a helper.
			proc(100, 50, "bun test ./a.browser.test.ts"),
			proc(
				101,
				100,
				`chrome --user-data-dir=${RUNS}/100-1000/chrome-abcdef --headless`,
			),
			proc(
				102,
				101,
				`chrome --type=renderer --user-data-dir=${RUNS}/100-1000/chrome-abcdef`,
			),
			// A run that is gone (pid 200): its Chrome, a helper, a Firefox.
			proc(201, 1, `chrome --user-data-dir=${RUNS}/200-1000/chrome-ghijkl`),
			proc(
				202,
				201,
				`chrome --type=gpu --user-data-dir=${RUNS}/200-1000/chrome-ghijkl`,
			),
			proc(
				203,
				1,
				`firefox --headless --no-remote --profile ${RUNS}/200-1000/firefox-mnopqr --remote-debugging-port 0`,
			),
			proc(204, 1, `firefox -profile ${RUNS}/200-1000/firefox-stuvwx`),
			// Not browsers: an editor, a pager, a shell naming the gone run's folder.
			proc(301, 1, `vim ${RUNS}/200-1000/chrome-ghijkl/Default/Preferences`),
			proc(302, 1, `less ${RUNS}/200-1000/log.txt`),
			proc(303, 1, `zsh -c tail -f ${RUNS}/200-1000/x --user-data-dir`),
			proc(
				304,
				1,
				`node tool.js --note=--user-data-dir=${RUNS}/200-1000/chrome-ghijkl`,
			),
			// A run folder elsewhere with the same shape: not ours.
			proc(305, 1, "chrome --user-data-dir=/tmp/runs/200-1000/chrome-xyz"),
			proc(
				306,
				1,
				`chrome --user-data-dir=/elsewhere${RUNS}/200-1000/chrome-xyz`,
			),
			// The owner's own browsers: never.
			proc(
				400,
				1,
				"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
			),
			proc(
				401,
				400,
				"Google Chrome Helper --type=renderer --user-data-dir=/Users/u/Library/Application Support/Google/Chrome",
			),
			proc(402, 1, "/Applications/Firefox.app/Contents/MacOS/firefox"),
		),
	);
	expect(kill.map((k) => k.pid).sort()).toEqual([201, 202, 203, 204]);
});

test("a PID used again by another process counts as gone; its own run never", () => {
	const { kill } = plan(
		listing(
			proc(300, 1, "some other program", 5_000),
			proc(301, 1, `chrome --user-data-dir=${RUNS}/300-1000/chrome-aaaaaa`),
			proc(
				302,
				1,
				`chrome --user-data-dir=${RUNS}/${SELF.pid}-${SELF.start}/chrome-bbbbbb`,
			),
		),
	);
	expect(kill.map((k) => k.pid)).toEqual([301]);
});

test("a path through a symbolic link is the same folder: given and resolved both match", () => {
	const { kill, remove } = plan(
		listing(
			proc(201, 1, `chrome --user-data-dir=${REAL}/200-1000/chrome-cccccc`),
		),
		[`${REAL}/200-1000`, `${RUNS}/200-1000`],
	);
	expect(kill.map((k) => k.pid)).toEqual([201]);
	expect(remove.map((r) => r.path)).toEqual([
		`${REAL}/200-1000`,
		`${RUNS}/200-1000`,
	]);
});

test("folders: those of gone runs go, a live run's and anything else stay", () => {
	const { remove } = plan(listing(proc(100, 50, "bun test")), [
		`${RUNS}/100-1000`,
		`${RUNS}/200-1000`,
		`${RUNS}/${SELF.pid}-${SELF.start}`,
		`${RUNS}/notes`,
		"/tmp/T/200-1000",
	]);
	expect(remove.map((r) => r.path)).toEqual([`${RUNS}/200-1000`]);
});

test("an empty listing, or one without the sweeper, keeps everything", () => {
	for (const processes of [
		[],
		[proc(100, 1, "bun test")],
		[proc(SELF.pid, 1, "bun", SELF.start + 60)],
	]) {
		const result = plan(processes, [`${RUNS}/200-1000`]);
		expect(result.kill).toEqual([]);
		expect(result.remove).toEqual([]);
		expect(result.kept).toBeString();
	}
});

test("sweep(): a failing or unparsable listing keeps everything, and says why", () => {
	const lines: string[] = [];
	for (const listProcesses of [
		() => {
			throw new Error("ps failed (1)");
		},
		() => {
			throw new Error("ps printed a line this does not understand: ???");
		},
	]) {
		const result = sweep({
			runsDirs: [RUNS],
			self: SELF,
			listFolders: () => [`${RUNS}/200-1000`],
			listProcesses,
			confirmGone: () => true,
			log: (line) => lines.push(line),
			dryRun: true,
		});
		expect(result.remove).toEqual([]);
	}
	expect(
		lines.every((l) => l.startsWith("sweep: keeping everything: ps")),
	).toBe(true);
});

test("sweep(): folders are listed before processes, so a run made in between is kept", () => {
	// The new run 500 makes its folder after the folder listing and before the process
	// listing: the folder is not in the plan, though its process is in the listing.
	const order: string[] = [];
	const result = sweep({
		runsDirs: [RUNS],
		self: SELF,
		listFolders: () => {
			order.push("folders");
			return [`${RUNS}/200-1000`];
		},
		listProcesses: () => {
			order.push("processes");
			return listing(proc(500, 1, "bun test"));
		},
		confirmGone: () => true,
		log: () => {},
		dryRun: true,
	});
	expect(order).toEqual(["folders", "processes"]);
	expect(result.remove.map((r) => r.path)).toEqual([`${RUNS}/200-1000`]);
});

test("sweep(): a run the second witness does not see as gone is kept", () => {
	const result = sweep({
		runsDirs: [RUNS],
		self: SELF,
		listFolders: () => [`${RUNS}/200-1000`, `${RUNS}/300-1000`],
		listProcesses: () => listing(),
		confirmGone: (run) => run === "300-1000",
		log: () => {},
		dryRun: true,
	});
	expect(result.remove.map((r) => r.path)).toEqual([`${RUNS}/300-1000`]);
});

test("a profile flag counts only as a whole argument with a run folder as its value", () => {
	const flag = profileFlag([RUNS]);
	expect(flag.exec(`x --user-data-dir=${RUNS}/1-2/p y`)?.[1]).toBe("1-2");
	expect(flag.exec(`x --profile ${RUNS}/1-2/p`)?.[1]).toBe("1-2");
	expect(flag.exec(`x -profile ${RUNS}/1-2`)?.[1]).toBe("1-2");
	expect(flag.exec(`x --user-data-dir=${RUNS}/1-2x/p`)).toBeNull();
	expect(flag.exec(`x --user-data-dir=${RUNS}x/1-2/p`)).toBeNull();
	expect(flag.exec(`x a--user-data-dir=${RUNS}/1-2/p`)).toBeNull();
	expect(flag.exec(`cat ${RUNS}/1-2/p`)).toBeNull();
});

test("an unsafe TAB_MCP_BROWSER_DIR is refused", () => {
	for (const dir of [
		"tmp",
		"./x/y/z",
		"/",
		"/tmp",
		"/private/tmp",
		homedir(),
		tmpdir(),
		"/a",
		"/var/tmp",
		"/a b/c/d",
	])
		expect({ dir, refused: refuseBase(dir) !== undefined }).toEqual({
			dir,
			refused: true,
		});
	expect(refuseBase("/Users/u/.cache/tab-mcp/x")).toBeUndefined();
	expect(refuseBase(join(tmpdir(), "tab-mcp-x"))).toBeUndefined();
	const run = Bun.spawnSync(
		[
			process.execPath,
			"-e",
			`import { runsDir } from ${JSON.stringify(resolve(import.meta.dir, "../test/browser-dirs.ts"))}; runsDir();`,
		],
		{ env: { ...process.env, TAB_MCP_BROWSER_DIR: "/tmp" }, stderr: "pipe" },
	);
	expect(run.exitCode).not.toBe(0);
	expect(run.stderr.toString()).toContain(
		"TAB_MCP_BROWSER_DIR=/tmp is refused",
	);
});

test("the runs folder through a symbolic link is known by both paths", () => {
	const real = mkdtempSync(join(tmpdir(), "tab-mcp-real-"));
	const link = `${real}-link`;
	try {
		symlinkSync(real, link);
		mkdirSync(join(real, "runs"));
		const run = Bun.spawnSync(
			[
				process.execPath,
				"-e",
				`import { runsDirs } from ${JSON.stringify(resolve(import.meta.dir, "../test/browser-dirs.ts"))}; console.log(JSON.stringify(runsDirs()));`,
			],
			{ env: { ...process.env, TAB_MCP_BROWSER_DIR: link } },
		);
		expect(JSON.parse(run.stdout.toString())).toEqual([
			join(link, "runs"),
			join(realpathSync(real), "runs"),
		]);
	} finally {
		rmSync(link, { force: true });
		rmSync(real, { recursive: true, force: true });
	}
});

test("a process's start is the same in every time zone: ps runs in UTC", () => {
	expect(parseLstart("Sun Nov 22 06:36:28 2026")).toBe(
		Date.UTC(2026, 10, 22, 6, 36, 28) / 1000,
	);
	expect(parseLstart("Mon Feb  2 09:05:00 2026")).toBe(
		Date.UTC(2026, 1, 2, 9, 5, 0) / 1000,
	);
	expect(parseLstart("")).toBeUndefined();
	// bun test runs in UTC, a process outside it in local time: the same start.
	const outside = Bun.spawnSync(
		[
			process.execPath,
			"-e",
			`import { processStart } from ${JSON.stringify(resolve(import.meta.dir, "../test/browser-dirs.ts"))}; console.log(processStart(${process.pid}))`,
		],
		{ env: { ...process.env, TZ: "Europe/Zurich" } },
	);
	expect(Number(outside.stdout.toString())).toBe(Number(runId().split("-")[1]));
});
