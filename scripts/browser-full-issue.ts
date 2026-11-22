/**
 * The full browser run's report (.github/workflows/browser-full.yml, on main
 * only): a red run opens an issue labelled `browser-full` with the failing
 * tests, or comments them on the ones open already; a green run of main's
 * current head closes them (a green rerun of an older commit only says so).
 * Its issues are the open ones with the label and `MARKER` in their body;
 * another issue with the label is left alone. Nothing else is sent:
 * GitHub's own mail for a failed scheduled run stays as it is.
 *
 * Environment: `RESULT` (success or failure, the browser job's), `LOG` (the
 * run's output; may be missing when the job failed before the tests),
 * `RUN_URL`, `EVENT`, `SHA` (the commit the run tested), `REPO`
 * (owner/name), and `GH_TOKEN` for `gh`.
 */

export const LABEL = "browser-full";
export const TITLE = "The full browser run fails on main";
/** In the body of every issue this script opens: how it finds its own. */
export const MARKER = "<!-- browser-full-report -->";
/** What the workflow's test step prints when `timeout` stopped the run. */
export const TIMED_OUT = "browser-full: timed out after";
/** The most failing tests named; the rest are counted. */
export const MAX_NAMED = 50;
/** Well below GitHub's 65,536 characters for a body or a comment. */
export const MAX_BODY = 60_000;

/** The names of the tests `bun test` reported as failed in `log`, once each, in order. */
export function failedTests(log: string): string[] {
	const names: string[] = [];
	for (const line of Bun.stripANSI(log).split("\n")) {
		const m = /^\s*\(fail\) (.+?)(?: \[[0-9.]+m?s\])?\s*$/.exec(line);
		if (m && !names.includes(m[1] as string)) names.push(m[1] as string);
	}
	return names;
}

/**
 * `text` as a Markdown code span on one line: nothing in it is a mention, a
 * link, HTML or a comment. The fence is longer than any run of backticks in
 * it; a space pads a text that starts or ends with one.
 */
export function codeSpan(text: string): string {
	const flat = text.replace(/[\r\n]+/g, " ");
	const longest = Math.max(
		0,
		...[...flat.matchAll(/`+/g)].map((m) => m[0].length),
	);
	const fence = "`".repeat(longest + 1);
	const pad = /^`|`$/.test(flat) || flat === "" ? " " : "";
	return `${fence}${pad}${flat}${pad}${fence}`;
}

/** What a red run says: in a new issue's body, or a comment on the open ones. */
export function redText(run: {
	url: string;
	event: string;
	sha: string;
	failed: string[];
	timedOut: boolean;
}): string {
	const named = run.failed.slice(0, MAX_NAMED).map((n) => `- ${codeSpan(n)}`);
	if (run.failed.length > MAX_NAMED)
		named.push(`- and ${run.failed.length - MAX_NAMED} more`);
	const parts = [
		`${MARKER}\nThe full browser run (${run.event}, ${run.sha.slice(0, 12)}) ${run.timedOut ? "timed out" : "failed"}: ${run.url}`,
	];
	if (run.timedOut)
		parts.push(
			"It was stopped after 25 minutes: a test or a browser hung. Its log ends where it hung.",
		);
	if (named.length > 0) parts.push(`Failing tests:\n\n${named.join("\n")}`);
	else if (!run.timedOut)
		parts.push(
			"No test reported a failure: the run failed before or after the tests (install, a browser missing, a file with no passed test). Its log says which.",
		);
	parts.push("A green run of main's current head closes this issue.");
	let text = parts.join("\n\n");
	if (text.length > MAX_BODY)
		text = `${text.slice(0, MAX_BODY)}\n\n(cut: see the run)`;
	return text;
}

export type Plan =
	| { kind: "create" }
	| {
			kind: "comment" | "close" | "green-elsewhere" | "none";
			issues: number[];
	  };

/** What a run does with the issues: from its result, its commit and main's head. */
export function plan(input: {
	result: string;
	sha: string;
	head: string;
	open: number[];
}): Plan {
	if (input.result === "success") {
		if (input.open.length === 0) return { kind: "none", issues: [] };
		return input.sha === input.head
			? { kind: "close", issues: input.open }
			: { kind: "green-elsewhere", issues: input.open };
	}
	if (input.result !== "failure") throw new Error(`RESULT is ${input.result}`);
	return input.open.length === 0
		? { kind: "create" }
		: { kind: "comment", issues: input.open };
}

/** The open issues of `listed` that this script opened (the marker in the body). */
export const ownIssues = (listed: { number: number; body: string }[]) =>
	listed.filter((i) => i.body.includes(MARKER)).map((i) => i.number);

function gh(...args: string[]): string {
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
	const sha = env("SHA");
	const repo = env("REPO");
	const open = ownIssues(
		JSON.parse(
			gh(
				"issue",
				"list",
				"--repo",
				repo,
				"--label",
				LABEL,
				"--state",
				"open",
				"--json",
				"number,body",
				"--limit",
				"100",
			),
		) as { number: number; body: string }[],
	);
	const head = gh("api", `repos/${repo}/commits/main`, "--jq", ".sha").trim();
	const todo = plan({ result, sha, head, open });
	if (todo.kind === "none") return;
	if (todo.kind === "close" || todo.kind === "green-elsewhere") {
		for (const issue of todo.issues)
			if (todo.kind === "close")
				gh(
					"issue",
					"close",
					String(issue),
					"--repo",
					repo,
					"--comment",
					`Green again on ${sha.slice(0, 12)}: ${url}`,
				);
			else
				gh(
					"issue",
					"comment",
					String(issue),
					"--repo",
					repo,
					"--body",
					`Green on ${sha.slice(0, 12)}, which is not main's head (${head.slice(0, 12)}): left open. ${url}`,
				);
		console.log(`${todo.kind}: ${todo.issues.join(", ")}`);
		return;
	}
	const log = Bun.file(process.env["LOG"] ?? "browser-full.log");
	const text = (await log.exists()) ? await log.text() : "";
	const body = redText({
		url,
		event: env("EVENT"),
		sha,
		failed: failedTests(text),
		timedOut: text.includes(TIMED_OUT),
	});
	if (todo.kind === "comment") {
		for (const issue of todo.issues)
			gh("issue", "comment", String(issue), "--repo", repo, "--body", body);
		console.log(`comment: ${todo.issues.join(", ")}`);
		return;
	}
	gh(
		"label",
		"create",
		LABEL,
		"--repo",
		repo,
		"--force",
		"--color",
		"B60205",
		"--description",
		"The full browser run (browser-full.yml) fails on main",
	);
	console.log(
		gh(
			"issue",
			"create",
			"--repo",
			repo,
			"--title",
			TITLE,
			"--label",
			LABEL,
			"--body",
			body,
		),
	);
}

if (import.meta.main) await main();
