/**
 * The todo list: a small external store, so the AI app's tool calls and
 * the UI change the same list synchronously (a tool that adds a todo and a
 * `list_todos` right after it see the same state, before React renders).
 */

export interface Todo {
	id: string;
	text: string;
	done: boolean;
}

/** The longest text and the most todos; the tools' schemas say the same. */
export const MAX_TEXT = 200;
export const MAX_TODOS = 200;

export class TodoList {
	#items: readonly Todo[] = [];
	#next = 1;
	readonly #listeners = new Set<() => void>();

	readonly subscribe = (listener: () => void): (() => void) => {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	};

	readonly snapshot = (): readonly Todo[] => this.#items;

	add(text: string): Todo {
		const trimmed = text.trim().replace(/\s+/g, " ");
		if (trimmed === "") throw new Error("A todo needs a text");
		// Characters as JSON Schema's maxLength counts them (code points).
		if ([...trimmed].length > MAX_TEXT)
			throw new Error(`A todo has at most ${MAX_TEXT} characters`);
		if (this.#items.length >= MAX_TODOS)
			throw new Error(`The list holds at most ${MAX_TODOS} todos`);
		const todo: Todo = { id: `t${this.#next++}`, text: trimmed, done: false };
		this.#set([...this.#items, todo]);
		return todo;
	}

	complete(id: string, done = true): Todo {
		const todo = this.#find(id);
		const changed = { ...todo, done };
		this.#set(this.#items.map((t) => (t.id === id ? changed : t)));
		return changed;
	}

	remove(id: string): Todo {
		const todo = this.#find(id);
		this.#set(this.#items.filter((t) => t.id !== id));
		return todo;
	}

	/** Remove several at once (all or none): one confirmation for "delete all". */
	removeAll(ids: readonly string[]): Todo[] {
		const gone = [...new Set(ids)].map((id) => this.#find(id));
		const drop = new Set(gone.map((t) => t.id));
		this.#set(this.#items.filter((t) => !drop.has(t.id)));
		return gone;
	}

	#find(id: string): Todo {
		const todo = this.#items.find((t) => t.id === id);
		if (todo === undefined) throw new Error(`No todo with id ${id}`);
		return todo;
	}

	#set(items: readonly Todo[]): void {
		this.#items = items;
		for (const listener of [...this.#listeners]) listener();
	}
}
