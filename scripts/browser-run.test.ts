/**
 * The machine-wide lock of the browser tests (test/browser-lock.ts) with real
 * processes in a lock folder of their own, and the sweep's choice
 * (test/browser-sweep.ts) on made-up process and folder lists.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseLstart, runId } from "../test/browser-dirs.ts";
import { type Proc, planSweep } from "../test/browser-sweep.ts";

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
	`;
	return Bun.spawn([process.execPath, "-e", script], {
		env: { ...process.env, TAB_MCP_BROWSER_DIR: base, ...env },
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
	const first = holder("first", 1_500);
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
	const second = holder("second", 0, { TAB_MCP_BROWSER_WAIT_MS: "500" });
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

const RUNS = "/home/u/.cache/tab-mcp/browser-tests/runs";
const T = "/tmp/T";
const NOW = 1_800_000_000_000;

function proc(pid: number, ppid: number, command: string, start = 1_000): Proc {
	return { pid, ppid, start, command };
}

test("the sweep stops the browsers of runs that are gone, and only those", () => {
	const plan = planSweep({
		runsDir: RUNS,
		now: NOW,
		processes: [
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
			// A run that is gone (pid 200): its Chrome lives on under launchd.
			proc(201, 1, `chrome --user-data-dir=${RUNS}/200-1000/chrome-ghijkl`),
			proc(
				202,
				201,
				`chrome --type=gpu --user-data-dir=${RUNS}/200-1000/chrome-ghijkl`,
			),
			// Firefox of the gone run.
			proc(
				203,
				1,
				`firefox --headless --no-remote --profile ${RUNS}/200-1000/firefox-mnopqr`,
			),
			// The PID of a gone run used again by another process (another start).
			proc(300, 1, "some other program", 5_000),
			proc(301, 1, `chrome --user-data-dir=${RUNS}/300-1000/chrome-stuvwx`),
			// The owner's own browsers: never.
			proc(
				400,
				1,
				"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
			),
			proc(
				401,
				400,
				"Google Chrome Helper (Renderer) --type=renderer --user-data-dir=/Users/u/Library/Application Support/Google/Chrome",
			),
			proc(402, 1, "/Applications/Firefox.app/Contents/MacOS/firefox"),
		],
		folders: [],
	});
	expect(plan.kill.map((k) => k.pid).sort()).toEqual([201, 202, 203, 301]);
});

test("old temp profiles: a browser stops only when no test process is above it", () => {
	const plan = planSweep({
		runsDir: RUNS,
		now: NOW,
		processes: [
			// An old branch's live run: its Chrome's parent is the test process.
			proc(500, 60, "bun test e2e.test.ts"),
			proc(501, 500, `chrome --user-data-dir=${T}/tab-mcp-extension-aaaaaa`),
			proc(
				502,
				501,
				`chrome --type=renderer --user-data-dir=${T}/tab-mcp-extension-aaaaaa`,
			),
			proc(
				503,
				1,
				`chrome_crashpad --user-data-dir=${T}/tab-mcp-extension-aaaaaa`,
			),
			// An orphan: main and helpers under launchd only.
			proc(601, 1, `chrome --user-data-dir=${T}/tab-mcp-chrome-bbbbbb`),
			proc(
				602,
				601,
				`chrome --type=gpu --user-data-dir=${T}/tab-mcp-chrome-bbbbbb`,
			),
			// An orphaned Firefox with an old profile.
			proc(
				701,
				1,
				`firefox --headless --no-remote --profile ${T}/tab-mcp-firefox-cccccc --remote-debugging-port 0`,
			),
			// A profile in another place with a similar name: not one of ours.
			proc(801, 1, "chrome --user-data-dir=/tmp/my-tab-mcp-chrome"),
		],
		folders: [],
	});
	expect(plan.kill.map((k) => k.pid).sort()).toEqual([601, 602, 701]);
});

test("the sweep removes the folders of runs that are gone and old unused temp folders", () => {
	const hourAgo = NOW - 2 * 3_600_000;
	const plan = planSweep({
		runsDir: RUNS,
		now: NOW,
		processes: [
			proc(100, 50, "bun test"),
			proc(501, 1, `chrome --user-data-dir=${T}/tab-mcp-ext-dddddd`),
		],
		folders: [
			{ path: `${RUNS}/100-1000`, mtimeMs: hourAgo },
			{ path: `${RUNS}/200-1000`, mtimeMs: NOW },
			{ path: `${T}/tab-mcp-extension-eeeeee`, mtimeMs: hourAgo },
			{ path: `${T}/webmcp-spike-ffffff`, mtimeMs: hourAgo },
			// Too new: an old branch's run may be using it.
			{ path: `${T}/tab-mcp-fill-gggggg`, mtimeMs: NOW - 60_000 },
			// Named by a running browser.
			{ path: `${T}/tab-mcp-ext-dddddd`, mtimeMs: hourAgo },
			// Not one of the browser tests' prefixes.
			{ path: `${T}/tab-mcp-store-hhhhhh`, mtimeMs: hourAgo },
			{ path: `${T}/tab-mcp-extension-build-iiiiii`, mtimeMs: hourAgo },
		],
	});
	expect(plan.remove.map((r) => r.path).sort()).toEqual([
		`${RUNS}/200-1000`,
		`${T}/tab-mcp-extension-eeeeee`,
		`${T}/webmcp-spike-ffffff`,
	]);
	// The old Chrome above is an orphan (parent launchd): it stops, its folder goes next time.
	expect(plan.kill.map((k) => k.pid)).toEqual([501]);
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
