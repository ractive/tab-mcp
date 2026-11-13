import { describe, expect, test } from "bun:test";
import { AlwaysAllowed, allowedFor } from "../src/always-allowed.ts";
import { TabMcp } from "../src/tab-mcp.ts";

const tool = (name: string, description = `Does ${name}`) => ({
	name,
	description,
});

describe("AlwaysAllowed", () => {
	test("remembers a tool per grant only", () => {
		const always = new AlwaysAllowed();
		always.add("g1", tool("clear_memory"));
		expect(always.has("g1", tool("clear_memory"))).toBe(true);
		expect(always.has("g2", tool("clear_memory"))).toBe(false);
		expect(always.has("g1", tool("store"))).toBe(false);
		expect(always.list("g1")).toEqual(["clear_memory"]);
	});

	test("a grant that goes is forgotten; the same grant id added again is asked again", () => {
		const always = new AlwaysAllowed();
		always.add("g1", tool("clear_memory"));
		always.add("g2", tool("clear_memory"));
		always.keepGrants(["g2"]);
		expect(always.has("g1", tool("clear_memory"))).toBe(false);
		expect(always.has("g2", tool("clear_memory"))).toBe(true);
		always.keepGrants(["g1", "g2"]);
		expect(always.has("g1", tool("clear_memory"))).toBe(false);
	});

	test("an unregistered tool is forgotten, so a new tool with its name asks again", () => {
		const always = new AlwaysAllowed();
		always.add("g1", tool("delete_item"));
		always.add("g1", tool("store"));
		always.keepTools(["store"]);
		expect(always.has("g1", tool("delete_item"))).toBe(false);
		expect(always.has("g1", tool("store"))).toBe(true);
		always.keepTools(["store", "delete_item"]);
		expect(always.has("g1", tool("delete_item"))).toBe(false);
	});

	test("a tool whose title or description changed is asked again and no longer listed (CU 11)", () => {
		const always = new AlwaysAllowed();
		always.add("g1", tool("delete_item"));
		expect(always.has("g1", tool("delete_item", "Deletes all"))).toBe(false);
		expect(always.list("g1")).toEqual([]);
		always.add("g1", tool("delete_item"));
		expect(
			always.has("g1", { ...tool("delete_item"), title: "Delete everything" }),
		).toBe(false);
	});

	test("forget, the connect dialog's Ask again, takes a grant's tools back and says so", () => {
		const always = new AlwaysAllowed();
		let changes = 0;
		const stop = always.onChange(() => changes++);
		always.add("g1", tool("a"));
		always.add("g1", tool("b"));
		always.forget("g1");
		expect(always.list("g1")).toEqual([]);
		expect(always.has("g1", tool("a"))).toBe(false);
		expect(changes).toBe(3);
		stop();
		always.add("g1", tool("a"));
		expect(changes).toBe(3);
	});
});

describe("allowedFor", () => {
	test("a tool unregistered and registered again in the same task keeps its entry (useTool, CU 11)", async () => {
		const mcp = new TabMcp({ server: { name: "t", version: "1" } });
		const allowed = allowedFor(mcp);
		expect(allowedFor(mcp)).toBe(allowed);
		const make = () => ({
			name: "delete_item",
			description: "Deletes an item",
			execute: () => "ok",
		});
		let controller = new AbortController();
		await mcp.registerTool(make(), { signal: controller.signal });
		allowed.add("g1", make());
		// What React does when a component's effect runs again.
		controller.abort();
		controller = new AbortController();
		await mcp.registerTool(make(), { signal: controller.signal });
		await Promise.resolve();
		expect(allowed.has("g1", make())).toBe(true);
		// Gone for good: the entry goes after the task.
		controller.abort();
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(allowed.list("g1")).toEqual([]);
	});
});
