/**
 * The full browser run's issue (scripts/browser-full-issue.ts): which tests
 * it names, how, what it says, and which issues it touches.
 */
import { expect, test } from "bun:test";
import {
	codeSpan,
	failedTests,
	MARKER,
	MAX_BODY,
	MAX_NAMED,
	ownIssues,
	plan,
	redText,
} from "./browser-full-issue.ts";

const RUN = {
	url: "https://github.com/o/r/actions/runs/1",
	event: "schedule",
	sha: "0123456789abcdef0123",
	timedOut: false,
};

test("the failing tests are bun's (fail) lines, without their time, once each", () => {
	const log = [
		"packages/tab-mcp-extension/test/firefox-full.browser.test.ts:",
		"(pass) the event page > with the panel open, the connection outlasts the idle timeout [10020.00ms]",
		"(fail) the event page > with the panel closed too [10031.52ms]",
		"\x1b[31m(fail)\x1b[0m a page > colours from a terminal [1.20s]",
		"  (fail) an extension reload or update > indented",
		"(fail) the event page > with the panel closed too [12.00ms]",
		"error: expect(received).toEqual(expected)",
		" 2 pass",
		" 3 fail",
	].join("\n");
	expect(failedTests(log)).toEqual([
		"the event page > with the panel closed too",
		"a page > colours from a terminal",
		"an extension reload or update > indented",
	]);
	expect(failedTests("(pass) all fine [1.00ms]\n 1 pass\n")).toEqual([]);
});

test("a test's name is a code span on one line: no mention, link, HTML or comment of its own", () => {
	expect(codeSpan("with @mcp-b/global over native WebMCP")).toBe(
		"`with @mcp-b/global over native WebMCP`",
	);
	expect(codeSpan("a `b` c")).toBe("``a `b` c``");
	expect(codeSpan("``x")).toBe("``` ``x ```");
	expect(codeSpan("<!-- hidden\nline [a](https://x.example)")).toBe(
		"`<!-- hidden line [a](https://x.example)`",
	);
	const text = redText({
		...RUN,
		failed: ["@x > a `b`", "<!-- c\nd", "[e](https://x.example)"],
	});
	expect(text).toContain(
		"- `` @x > a `b` ``\n- `<!-- c d`\n- `[e](https://x.example)`",
	);
	// Outside the code spans, none of it.
	const outside = text.replace(/(`+)[\s\S]*?\1/g, "");
	expect(outside).not.toContain("@x");
	expect(outside).not.toContain("<!-- c");
	expect(outside).not.toContain("](https://x.example)");
});

test("a red run names its run, its commit, the marker and its failing tests, capped; or says none failed, or that it timed out", () => {
	const named = redText({ ...RUN, failed: ["a > b", "c"] });
	expect(named.startsWith(MARKER)).toBe(true);
	expect(named).toContain(
		"(schedule, 0123456789ab) failed: https://github.com/o/r/actions/runs/1",
	);
	expect(named).toContain("Failing tests:\n\n- `a > b`\n- `c`\n");
	expect(named).toContain(
		"A green run of main's current head closes this issue.",
	);
	expect(redText({ ...RUN, failed: [] })).toContain(
		"No test reported a failure",
	);
	const hung = redText({ ...RUN, failed: [], timedOut: true });
	expect(hung).toContain(") timed out: https://");
	expect(hung).toContain("stopped after 25 minutes");
	expect(hung).not.toContain("No test reported a failure");
	const many = redText({
		...RUN,
		failed: Array.from({ length: MAX_NAMED + 7 }, (_, i) => `t${i}`),
	});
	expect(many).toContain(`- \`t${MAX_NAMED - 1}\`\n- and 7 more`);
	expect(many).not.toContain(`\`t${MAX_NAMED}\``);
	const long = redText({ ...RUN, failed: ["x".repeat(MAX_BODY * 2)] });
	expect(long.length).toBeLessThan(MAX_BODY + 100);
	expect(long).toEndWith("(cut: see the run)");
});

test("only its own issues, all of them; a green run closes them only for main's current head", () => {
	expect(
		ownIssues([
			{ number: 1, body: `${MARKER}\nred` },
			{ number: 2, body: "someone's own issue with the label" },
			{ number: 3, body: `x ${MARKER}` },
		]),
	).toEqual([1, 3]);
	const at = { sha: "aaa", head: "aaa" };
	expect(plan({ ...at, result: "failure", open: [] })).toEqual({
		kind: "create",
	});
	expect(plan({ ...at, result: "failure", open: [1, 3] })).toEqual({
		kind: "comment",
		issues: [1, 3],
	});
	expect(plan({ ...at, result: "success", open: [1, 3] })).toEqual({
		kind: "close",
		issues: [1, 3],
	});
	expect(
		plan({ sha: "old", head: "aaa", result: "success", open: [1] }),
	).toEqual({ kind: "green-elsewhere", issues: [1] });
	expect(plan({ ...at, result: "success", open: [] })).toEqual({
		kind: "none",
		issues: [],
	});
	expect(() => plan({ ...at, result: "cancelled", open: [] })).toThrow(
		"RESULT is cancelled",
	);
});
