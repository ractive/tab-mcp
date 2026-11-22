/**
 * The full browser run's issue (scripts/browser-full-issue.ts): which tests
 * it names, and what it says.
 */
import { expect, test } from "bun:test";
import { failedTests, redText } from "./browser-full-issue.ts";

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

test("a red run names its run, its commit and its failing tests, or says none failed", () => {
	const run = {
		url: "https://github.com/o/r/actions/runs/1",
		event: "schedule",
		sha: "0123456789abcdef0123",
	};
	const named = redText({ ...run, failed: ["a > b", "c"] });
	expect(named).toContain(
		"(schedule, 0123456789ab) failed: https://github.com/o/r/actions/runs/1",
	);
	expect(named).toContain("Failing tests:\n\n- a > b\n- c\n");
	expect(named).toContain("The next green run on main closes this issue.");
	expect(redText({ ...run, failed: [] })).toContain(
		"No test reported a failure",
	);
});
