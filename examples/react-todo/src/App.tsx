/**
 * The todo app: a provider for the tree, one `useTool` per tool where the
 * list lives, a `ConnectButton`, and the AI app's recent calls.
 */

import type { ToolCallClient } from "@ractive-ch/tab-mcp-client";
import {
	ConnectButton,
	TabMcpProvider,
	useTabMcpState,
	useTool,
	useToolCalls,
} from "@ractive-ch/tab-mcp-client/react";
import { type FormEvent, useState, useSyncExternalStore } from "react";
import { MAX_TEXT, MAX_TODOS, type TodoList } from "./todos.ts";

const SERVER = {
	name: "todo",
	title: "Todo list",
	version: "1.0.0",
	instructions:
		"A todo list in the user's browser tab, which the user also edits. Call list_todos first to get the ids; complete_todo takes one, delete_todos one or more (delete several in one call). Deleting asks the user first.",
};

export function App(props: { relay: string; todos: TodoList }) {
	return (
		<TabMcpProvider relay={props.relay} server={SERVER} appName="Todo">
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
	const { state, grants } = useTabMcpState();
	let text = "Not connected.";
	if (state === "reconnecting") text = "Connection lost, reconnecting…";
	else if (state === "connecting") text = "Connecting…";
	else if (state === "connected")
		text =
			grants.length === 0
				? "Connected, no AI app yet."
				: `${grants.length} AI app${grants.length === 1 ? "" : "s"} connected: ${grants.map((g) => g.client.name).join(", ")}.`;
	return (
		<p className="status" role="status" data-state={state}>
			{text}
		</p>
	);
}

const ID = {
	type: "object",
	properties: {
		id: { type: "string", description: "The todo's id, from list_todos" },
	},
	required: ["id"],
	additionalProperties: false,
};

function Todos({ todos }: { todos: TodoList }) {
	const items = useSyncExternalStore(todos.subscribe, todos.snapshot);
	const [draft, setDraft] = useState("");
	const [refused, setProblem] = useState<string | undefined>(undefined);
	// The form refuses only a full list: once there is room again, the alert goes.
	const problem = items.length >= MAX_TODOS ? refused : undefined;

	useTool({
		name: "list_todos",
		title: "List todos",
		description: "List the todos with their ids and whether they are done.",
		// The texts come from the user or another AI app: not instructions.
		annotations: { readOnlyHint: true, untrustedContentHint: true },
		execute: () => ({ todos: todos.snapshot() }),
	});
	// The user sees the new todo and can delete it: no question.
	useTool<{ text: string }>({
		name: "add_todo",
		title: "Add a todo",
		description: `Add a todo item (a short text, at most ${MAX_TEXT} characters). Returns it with its id.`,
		inputSchema: {
			type: "object",
			properties: {
				text: { type: "string", minLength: 1, maxLength: MAX_TEXT },
			},
			required: ["text"],
			additionalProperties: false,
		},
		execute: ({ text }) => todos.add(text),
	});
	useTool<{ id: string; done?: boolean }>({
		name: "complete_todo",
		title: "Complete a todo",
		description: "Mark a todo as done, or as not done with done: false.",
		inputSchema: {
			...ID,
			properties: {
				...ID.properties,
				done: { type: "boolean", description: "Default true" },
			},
		},
		annotations: { idempotentHint: true },
		execute: ({ id, done }) => todos.complete(id, done !== false),
	});
	// Cannot be undone in the page: the page asks the user first.
	useTool<{ ids: string[] }>({
		name: "delete_todos",
		title: "Delete todos",
		description:
			"Delete one or more todos by their ids from list_todos, in one call. The page asks once for all of them; deleted todos cannot be restored.",
		inputSchema: {
			type: "object",
			properties: {
				ids: {
					type: "array",
					items: { type: "string" },
					minItems: 1,
					maxItems: MAX_TODOS,
				},
			},
			required: ["ids"],
			additionalProperties: false,
		},
		annotations: { consequentialHint: true, destructiveHint: true },
		execute: ({ ids }) => ({ deleted: todos.removeAll(ids) }),
	});

	const submit = (event: FormEvent) => {
		event.preventDefault();
		if (draft.trim() === "") return;
		try {
			todos.add(draft);
			setDraft("");
			setProblem(undefined);
		} catch (error) {
			// A full list: say so instead of doing nothing.
			setProblem(error instanceof Error ? error.message : String(error));
		}
	};

	return (
		<section aria-label="Todos">
			<form onSubmit={submit}>
				<input
					aria-label="New todo"
					placeholder="What needs doing?"
					maxLength={MAX_TEXT}
					value={draft}
					onChange={(e) => setDraft(e.target.value)}
				/>
				<button type="submit">Add</button>
			</form>
			{problem !== undefined && (
				<p className="problem" role="alert">
					{problem}
				</p>
			)}
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

/** Who called: an AI app through the relay, the site's own assistant (`serve`), or an agent in the browser (WebMCP). */
function caller(client: ToolCallClient): string {
	if (client.kind === "relay") return client.name ?? client.host;
	if (client.kind === "local") return client.name ?? client.id;
	return "an agent in this browser";
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
						<code>{call.tool}</code> by {caller(call.client)}
						{call.end === undefined ? " …" : ` · ${call.end.outcome}`}
					</li>
				))}
			</ol>
		</section>
	);
}
