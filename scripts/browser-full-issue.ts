/**
 * The full browser run's report (.github/workflows/browser-full.yml, on main
 * only): a red run opens an issue labelled `browser-full` with the failing
 * tests, or comments them on the one open already; a green run closes it.
 * Nothing else is sent: GitHub's own mail for a failed scheduled run stays
 * as it is.
 *
 * Environment: `RESULT` (success or failure, the browser job's), `LOG` (the
 * run's output; may be missing when the job failed before the tests),
 * `RUN_URL`, `EVENT`, `SHA`, and `GH_TOKEN` for `gh`.
 */

export const LABEL = "browser-full";
export const TITLE = "The full browser run fails on main";

/** The names of the tests `bun test` reported as failed in `log`, once each, in order. */
export function failedTests(log: string): string[] {
	const names: string[] = [];
	for (const line of Bun.stripANSI(log).split("\n")) {
		const m = /^\s*\(fail\) (.+?)(?: \[[0-9.]+m?s\])?\s*$/.exec(line);
		if (m && !names.includes(m[1] as string)) names.push(m[1] as string);
	}
	return names;
}

/** What a red run says: in a new issue's body, or a comment on the open one. */
export function redText(run: {
	url: string;
	event: string;
	sha: string;
	failed: string[];
}): string {
	const what =
		run.failed.length > 0
			? `Failing tests:\n\n${run.failed.map((n) => `- ${n}`).join("\n")}`
			: "No test reported a failure: the run failed before or after the tests (install, a browser missing, a file with no passed test). Its log says which.";
	return `The full browser run (${run.event}, ${run.sha.slice(0, 12)}) failed: ${run.url}\n\n${what}\n\nThe next green run on main closes this issue.`;
}

async function gh(...args: string[]): Promise<string> {
	const run = Bun.spawnSync(["gh", ...args], {
		stdout: "pipe",
		stderr: "pipe",
	});
	if (!run.success)
		throw new Error(`gh ${args[0]} ${args[1]}: ${run.stderr.toString()}`);
	return run.stdout.toString();
}

async function main(): Promise<void> {
	const env = (name: string) => {
		const value = process.env[name];
		if (value === undefined || value === "")
			throw new Error(`${name} is not set`);
		return value;
	};
	const result = env("RESULT");
	const url = env("RUN_URL");
	const open = JSON.parse(
		await gh(
			"issue",
			"list",
			"--label",
			LABEL,
			"--state",
			"open",
			"--json",
			"number",
			"--limit",
			"1",
		),
	) as { number: number }[];
	const issue = open[0]?.number;
	if (result === "success") {
		if (issue === undefined) return;
		await gh(
			"issue",
			"close",
			String(issue),
			"--comment",
			`Green again: ${url}`,
		);
		console.log(`closed #${issue}`);
		return;
	}
	if (result !== "failure") throw new Error(`RESULT is ${result}`);
	const log = Bun.file(process.env["LOG"] ?? "browser-full.log");
	const text = redText({
		url,
		event: env("EVENT"),
		sha: env("SHA"),
		failed: (await log.exists()) ? failedTests(await log.text()) : [],
	});
	if (issue !== undefined) {
		await gh("issue", "comment", String(issue), "--body", text);
		console.log(`commented on #${issue}`);
		return;
	}
	await gh(
		"label",
		"create",
		LABEL,
		"--force",
		"--color",
		"B60205",
		"--description",
		"The full browser run (browser-full.yml) fails on main",
	);
	console.log(
		await gh(
			"issue",
			"create",
			"--title",
			TITLE,
			"--label",
			LABEL,
			"--body",
			text,
		),
	);
}

if (import.meta.main) await main();
