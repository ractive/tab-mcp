/**
 * `step()` of the browser tests' harness (test/browser.ts), without a
 * browser: a failing step is named, also for a thrown value that is no
 * `Error`, and a step past its deadline fails as such.
 */

import { expect, test } from "bun:test";
import { step } from "./browser.ts";

test("a failing step is named, for an Error and for any other thrown value", async () => {
	await expect(
		step("the first step", async () => {
			throw new Error("it broke");
		}),
	).rejects.toThrow("[the first step] it broke");
	await expect(
		step("the second step", async () => {
			throw "a string";
		}),
	).rejects.toThrow("[the second step] a string");
	// A passing step passes.
	await step("the third step", async () => {});
});

test("a step past its deadline fails as such, named, before the test's timeout", async () => {
	const started = Date.now();
	await expect(step("a slow step", () => Bun.sleep(1_000), 50)).rejects.toThrow(
		"[a slow step] took longer than 50 ms",
	);
	expect(Date.now() - started).toBeLessThan(500);
});
