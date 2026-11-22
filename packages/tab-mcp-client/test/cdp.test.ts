/**
 * The CDP helper's reap: its pkill pattern is one Chrome's `--user-data-dir`
 * and nothing more (as in `test/webmcp-spike/browser.test.ts`).
 */
import { expect, test } from "bun:test";
import { profilePattern } from "./cdp.ts";

test("reap's pattern matches only the profile's own Chrome", async () => {
	// Stand-ins for Chromes, as pgrep sees them: the profile's own, one whose
	// profile only starts the same, one that names it in another argument.
	// A dot, to check that it stands for itself.
	const profile = `/tmp/reap-check-${process.pid}/tab-mcp-chrome-a.b`;
	const args = [
		[`--user-data-dir=${profile}`, "--type=renderer"],
		[`--user-data-dir=${profile}x`],
		[`--user-data-dir=/tmp/reap-check-${process.pid}/tab-mcp-chrome-aXb`],
		["--user-data-dir=/tmp/other", `--note=${profile}`],
	];
	const procs = args.map((a) =>
		Bun.spawn([process.execPath, "-e", "await Bun.sleep(30_000)", ...a], {
			stdout: "ignore",
			stderr: "ignore",
		}),
	);
	try {
		await Bun.sleep(300);
		const { stdout } = Bun.spawnSync(["pgrep", "-f", profilePattern(profile)]);
		const found = stdout
			.toString()
			.trim()
			.split("\n")
			.filter(Boolean)
			.map(Number);
		expect(found).toEqual(procs.slice(0, 1).map((p) => p.pid));
	} finally {
		for (const p of procs) p.kill("SIGKILL");
	}
});
