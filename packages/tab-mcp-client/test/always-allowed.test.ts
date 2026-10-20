import { describe, expect, test } from "bun:test";
import { AlwaysAllowed } from "../src/always-allowed.ts";

describe("AlwaysAllowed", () => {
	test("remembers a tool per grant only", () => {
		const always = new AlwaysAllowed();
		always.add("g1", "clear_memory");
		expect(always.has("g1", "clear_memory")).toBe(true);
		expect(always.has("g2", "clear_memory")).toBe(false);
		expect(always.has("g1", "store")).toBe(false);
	});

	test("a grant that goes is forgotten; the same grant id added again is asked again", () => {
		const always = new AlwaysAllowed();
		always.add("g1", "clear_memory");
		always.add("g2", "clear_memory");
		always.keepGrants(["g2"]);
		expect(always.has("g1", "clear_memory")).toBe(false);
		expect(always.has("g2", "clear_memory")).toBe(true);
		always.keepGrants(["g1", "g2"]);
		expect(always.has("g1", "clear_memory")).toBe(false);
	});

	test("an unregistered tool is forgotten, so a new tool with its name asks again", () => {
		const always = new AlwaysAllowed();
		always.add("g1", "delete_item");
		always.add("g1", "store");
		always.keepTools(["store"]);
		expect(always.has("g1", "delete_item")).toBe(false);
		expect(always.has("g1", "store")).toBe(true);
		always.keepTools(["store", "delete_item"]);
		expect(always.has("g1", "delete_item")).toBe(false);
	});
});
