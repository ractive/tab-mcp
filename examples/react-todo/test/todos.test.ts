import { expect, test } from "bun:test";
import { TodoList } from "../src/todos.ts";

test("removeAll deletes several in one change, or none when an id is unknown", () => {
	const list = new TodoList();
	const [a, b, c] = ["a", "b", "c"].map((t) => list.add(t));
	expect(() => list.removeAll([a!.id, "t99"])).toThrow("No todo with id t99");
	expect(list.snapshot()).toHaveLength(3);
	expect(list.removeAll([a!.id, c!.id, a!.id])).toEqual([a!, c!]);
	expect(list.snapshot()).toEqual([b!]);
});
