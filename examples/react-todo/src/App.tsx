/**
 * The todo app: a provider for the tree, one `useTool` per tool where the
 * list lives, a `ConnectButton`, and the AI app's recent calls.
 */

import {
	ConnectButton,
	TabMcpProvider,
	useTabMcpState,
	useTool,
	useToolCalls,
} from "@ractive-ch/tab-mcp-client/react";
import { type FormEvent, useState, useSyncExternalStore } from "react";
import type { TodoList } from "./todos.ts";

const SERVER = {
	name: "todo",
	version: "1.0.0",
	instructions:
		"A todo list in the user's browser tab. list_todos first to get the ids; complete_todo takes one, delete_todos one or more (delete several in one call).",
};

export function App(props: { relay: string; todos: TodoList }) {
	return (
		// alwaysAllow: the confirmation offers "Always allow" (off by default).
		<TabMcpProvider
			relay={props.relay}
			server={SERVER}
			appName="Todo"
			alwaysAllow
		>
			<main>
				<header>
					<h1>Todo</h1>
					<ConnectButton className="connect" />
				</header>
				<p className="intro">
					A tab-mcp example with React: connect your AI app and it can read and
					change this list while the tab is open.
				</p>
				<Status />
				<Todos todos={props.todos} />
				<Activity />
			</main>
		</TabMcpProvider>
	);
}

function Status() {
	const { state, grants, reconnecting } = useTabMcpState();
	let text = "Not connected.";
	if (reconnecting !== undefined) text = "Connection lost, reconnecting…";
	else if (state === "connecting") text = "Connecting…";
	else if (state === "connected")
		text =
			grants.length === 0
				? "Connected, no AI app yet."
				: `${grants.length} AI app${grants.length === 1 ? "" : "s"} connected: ${grants.map((g) => g.client.name).join(", ")}.`;
	return (
		<p className="status" data-state={state}>
			{text}
		</p>
	);
}

const ID = {
	type: "object",
	properties: { id: { type: "string", description: "The todo's id" } },
	required: ["id"],
	additionalProperties: false,
};

function Todos({ todos }: { todos: TodoList }) {
	const items = useSyncExternalStore(todos.subscribe, todos.snapshot);
	const [draft, setDraft] = useState("");

	useTool({
		name: "list_todos",
		description: "List the todos with their ids and whether they are done",
		annotations: { readOnlyHint: true },
		execute: () => ({ todos: todos.snapshot() }),
	});
	useTool({
		name: "add_todo",
		description: "Add a todo item",
		inputSchema: {
			type: "object",
			properties: { text: { type: "string", minLength: 1 } },
			required: ["text"],
			additionalProperties: false,
		},
		execute: ({ text }) => todos.add(String(text)),
	});
	useTool({
		name: "complete_todo",
		description: "Mark a todo as done",
		inputSchema: ID,
		annotations: { idempotentHint: true },
		execute: ({ id }) => todos.complete(String(id)),
	});
	useTool({
		name: "delete_todos",
		description:
			"Delete one or more todos by their ids, in one call; the user confirms it in the page once",
		inputSchema: {
			type: "object",
			properties: {
				ids: {
					type: "array",
					items: { type: "string" },
					minItems: 1,
					maxItems: 200,
				},
			},
			required: ["ids"],
			additionalProperties: false,
		},
		annotations: { consequentialHint: true, destructiveHint: true },
		execute: ({ ids }) => ({
			deleted: todos.removeAll((ids as unknown[]).map(String)),
		}),
	});

	const submit = (event: FormEvent) => {
		event.preventDefault();
		if (draft.trim() === "") return;
		todos.add(draft);
		setDraft("");
	};

	return (
		<section aria-label="Todos">
			<form onSubmit={submit}>
				<input
					aria-label="New todo"
					placeholder="What needs doing?"
					value={draft}
					onChange={(e) => setDraft(e.target.value)}
				/>
				<button type="submit">Add</button>
			</form>
			{items.length === 0 ? (
				<p className="empty">Nothing to do.</p>
			) : (
				<ul className="todos">
					{items.map((todo) => (
						<li
							key={todo.id}
							data-id={todo.id}
							className={todo.done ? "done" : ""}
						>
							<label>
								<input
									type="checkbox"
									checked={todo.done}
									onChange={(e) => todos.complete(todo.id, e.target.checked)}
								/>
								<span>{todo.text}</span>
							</label>
							<button
								type="button"
								aria-label={`Delete ${todo.text}`}
								onClick={() => todos.remove(todo.id)}
							>
								×
							</button>
						</li>
					))}
				</ul>
			)}
		</section>
	);
}

function Activity() {
	const calls = useToolCalls({ limit: 8 });
	if (calls.length === 0) return null;
	return (
		<section aria-label="The AI's calls" className="activity">
			<h2>The AI's calls</h2>
			<ol>
				{calls.map((call) => (
					<li key={call.id} data-outcome={call.end?.outcome ?? "running"}>
						<code>{call.tool}</code> by {call.client.name ?? call.client.host}
						{call.end === undefined ? " …" : ` · ${call.end.outcome}`}
					</li>
				))}
			</ol>
		</section>
	);
}
