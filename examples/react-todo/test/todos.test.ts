import { expect, test } from "bun:test";
import { MAX_TEXT, MAX_TODOS, TodoList } from "../src/todos.ts";

test("a todo's text is trimmed and at most MAX_TEXT long; the list holds at most MAX_TODOS", () => {
	const list = new TodoList();
	expect(list.add("  water \n the   plants ").text).toBe("water the plants");
	expect(() => list.add("   ")).toThrow("A todo needs a text");
	expect(() => list.add("x".repeat(MAX_TEXT + 1))).toThrow(
		`at most ${MAX_TEXT} characters`,
	);
	// Counted as the schema's maxLength counts: code points, not UTF-16 units.
	expect(list.add("😀".repeat(MAX_TEXT)).text).toHaveLength(2 * MAX_TEXT);
	list.remove(list.snapshot().at(-1)?.id ?? "");
	for (let i = list.snapshot().length; i < MAX_TODOS; i++)
		list.add(`todo ${i}`);
	expect(() => list.add("one more")).toThrow(`at most ${MAX_TODOS} todos`);
	expect(list.snapshot()).toHaveLength(MAX_TODOS);
});

test("removeAll deletes several in one change, or none when an id is unknown", () => {
	const list = new TodoList();
	const a = list.add("a");
	const b = list.add("b");
	const c = list.add("c");
	expect(() => list.removeAll([a.id, "t99"])).toThrow("No todo with id t99");
	expect(list.snapshot()).toHaveLength(3);
	expect(list.removeAll([a.id, c.id, a.id])).toEqual([a, c]);
	expect(list.snapshot()).toEqual([b]);
});
