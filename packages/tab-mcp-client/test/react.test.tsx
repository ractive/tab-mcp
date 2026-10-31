/**
 * The React bindings in happy-dom with React's `act` (iteration 9). Runs
 * against React 19 here and against React 18.3 through react-18.test.ts.
 */

import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import {
	act,
	Component,
	type ReactNode,
	StrictMode,
	useState,
	version,
} from "react";
import { createRoot, type Root } from "react-dom/client";
import type { TabMcp } from "../src/index.ts";
import {
	ConnectButton,
	connectLabel,
	TabMcpProvider,
	type TabMcpSnapshot,
	type ToolCallRecord,
	useTabMcp,
	useTabMcpState,
	useTool,
	useToolCalls,
} from "../src/react.ts";
import type { Tool } from "../src/types.ts";
import {
	connectClient,
	MemoryStorage,
	newTab,
	nextEvent,
	startRelay,
	type TestRelay,
	tokenFor,
} from "./helpers.ts";
import { restoreGlobals, window } from "./react-env.ts";
import { StubRelay } from "./stub-relay.ts";

const doc = window.document as unknown as Document;
let container: HTMLElement;
let root: Root | undefined;
let stub: StubRelay;
const tabs: TabMcp[] = [];

beforeEach(() => {
	stub = new StubRelay();
	container = doc.createElement("div");
	doc.body.append(container);
});
afterEach(async () => {
	if (root !== undefined) act(() => root?.unmount());
	root = undefined;
	container.remove();
	for (const dialog of doc.querySelectorAll("dialog")) dialog.remove();
	for (const tab of tabs.splice(0)) tab.disconnect();
	await stub.stop();
});
afterAll(restoreGlobals);

function render(element: ReactNode): void {
	act(() => {
		root ??= createRoot(container);
		root.render(element);
	});
}

/**
 * Resolves once `check()` holds, polled every 5 ms with React's updates
 * flushed in between (each poll is its own `act`); fails after `timeoutMs`.
 */
async function until(check: () => boolean, timeoutMs = 5_000): Promise<void> {
	const end = Date.now() + timeoutMs;
	while (!check()) {
		if (Date.now() > end) throw new Error("timed out");
		await act(async () => {
			await Bun.sleep(5);
		});
	}
}

/** A tab on the stub relay that the test controls. */
function tab(options: Parameters<typeof newTab>[1] = {}): TabMcp {
	const t = newTab(stub.url, options);
	tabs.push(t);
	return t;
}

/** Every `toolschange` of a tab, as lists of names. */
function toolChanges(t: TabMcp): string[][] {
	const changes: string[][] = [];
	t.addEventListener("toolschange", (e) => changes.push([...e.detail.tools]));
	return changes;
}

const addTool = (
	execute: Tool["execute"],
	description = "Add two numbers",
): Tool => ({
	name: "add",
	description,
	inputSchema: {
		type: "object",
		properties: { a: { type: "number" }, b: { type: "number" } },
	},
	annotations: { readOnlyHint: true },
	execute,
});

function AddTool(props: { offset: number; description?: string }) {
	useTool(
		addTool(
			({ a, b }) => Number(a) + Number(b) + props.offset,
			props.description,
		),
	);
	return null;
}

test("runs against the React version under test", () => {
	expect(version.split(".")[0]).toBe(process.env["TAB_MCP_REACT"] ?? "19");
});

test("StrictMode registers each tool once at a time, without 'already registered'", () => {
	const t = tab();
	const changes = toolChanges(t);
	const errors: unknown[] = [];
	t.addEventListener("error", (e) => errors.push(e.detail.error));
	render(
		<StrictMode>
			<TabMcpProvider client={t}>
				<AddTool offset={0} />
			</TabMcpProvider>
		</StrictMode>,
	);
	expect(t.tools).toEqual(["add"]);
	// Mount, StrictMode's unmount, mount again: never two at once.
	expect(changes).toEqual([["add"], [], ["add"]]);
	expect(errors).toEqual([]);
});

test("a re-render with a new execute does not register again; unmount removes the tool", () => {
	const t = tab();
	render(
		<TabMcpProvider client={t}>
			<AddTool offset={0} />
		</TabMcpProvider>,
	);
	const changes = toolChanges(t);
	render(
		<TabMcpProvider client={t}>
			<AddTool offset={1} />
		</TabMcpProvider>,
	);
	expect(changes).toEqual([]);
	// A new description is a new tool for the AI app: registered again.
	render(
		<TabMcpProvider client={t}>
			<AddTool offset={1} description="Add two numbers, plus one" />
		</TabMcpProvider>,
	);
	expect(changes).toEqual([[], ["add"]]);
	act(() => root?.unmount());
	root = undefined;
	expect(t.tools).toEqual([]);
});

test("useTool's deps register again", () => {
	const t = tab();
	function Versioned(props: { version: number }) {
		useTool(
			addTool(() => props.version),
			[props.version],
		);
		return null;
	}
	render(
		<TabMcpProvider client={t}>
			<Versioned version={1} />
		</TabMcpProvider>,
	);
	const changes = toolChanges(t);
	render(
		<TabMcpProvider client={t}>
			<Versioned version={1} />
		</TabMcpProvider>,
	);
	expect(changes).toEqual([]);
	render(
		<TabMcpProvider client={t}>
			<Versioned version={2} />
		</TabMcpProvider>,
	);
	expect(changes).toEqual([[], ["add"]]);
});

class Boundary extends Component<
	{ children: ReactNode; onError: (error: unknown) => void },
	{ failed: boolean }
> {
	override state = { failed: false };
	static getDerivedStateFromError() {
		return { failed: true };
	}
	override componentDidCatch(error: unknown) {
		this.props.onError(error);
	}
	override render() {
		return this.state.failed ? "failed" : this.props.children;
	}
}

test("a duplicate tool name reaches the error boundary", async () => {
	const t = tab();
	const caught: unknown[] = [];
	const quiet = console.error;
	console.error = () => {}; // React logs the caught error
	try {
		render(
			<TabMcpProvider client={t}>
				<Boundary onError={(e) => caught.push(e)}>
					<AddTool offset={0} />
					<AddTool offset={1} />
				</Boundary>
			</TabMcpProvider>,
		);
		await until(() => container.textContent === "failed");
	} finally {
		console.error = quiet;
	}
	expect(container.textContent).toBe("failed");
	expect((caught[0] as DOMException).name).toBe("InvalidStateError");
});

test("useTabMcpState re-renders only when the state changes", async () => {
	const t = tab();
	const snapshots: TabMcpSnapshot[] = [];
	function Status() {
		snapshots.push(useTabMcpState());
		return null;
	}
	render(
		<TabMcpProvider client={t}>
			<Status />
		</TabMcpProvider>,
	);
	expect(snapshots).toHaveLength(1);
	expect(snapshots[0]).toMatchObject({
		state: "disconnected",
		grants: [],
		tools: [],
	});
	// An event without a change, and a change outside the snapshot: no render.
	act(() => {
		t.dispatchEvent(
			new CustomEvent("statechange", { detail: { state: "disconnected" } }),
		);
		t.startPairing();
	});
	expect(snapshots).toHaveLength(1);

	await act(async () => {
		await t.connect({ resume: true });
	});
	const last = snapshots.at(-1);
	expect(last?.state).toBe("connected");
	expect(last?.address).toBe(t.address as string);
	expect(last?.session).toBe(t.session as NonNullable<typeof t.session>);
	const renders = snapshots.length;
	// The same values again: the same object, no render.
	act(() => {
		t.dispatchEvent(
			new CustomEvent("grantschange", { detail: { grants: t.grants } }),
		);
	});
	expect(snapshots).toHaveLength(renders);
	// A pairing code (the dialog's), then a new grant.
	await act(async () => {
		const code = nextEvent(t, "pairingcode");
		stub.send({
			type: "pairing.code",
			code: "ABCD-EFGH",
			expiresAt: new Date(Date.now() + 60_000).toISOString(),
		});
		await code;
	});
	expect(snapshots.at(-1)?.pairingCode?.code).toBe("ABCD-EFGH");
	await act(async () => {
		const changed = nextEvent(t, "grantschange");
		stub.send({
			type: "grant.added",
			grant: {
				grantId: "g_1",
				client: {
					id: "https://c.example/c.json",
					name: "C",
					host: "c.example",
				},
				createdAt: new Date().toISOString(),
			},
		});
		await changed;
	});
	expect(snapshots.at(-1)?.grants.map((g) => g.grantId)).toEqual(["g_1"]);
});

test("useTabMcpState shows identity binding and reconnecting", async () => {
	stub.pairing = "oidc";
	const t = tab({
		identityAssertion: () => "a.b.c",
		reconnect: { delaysMs: [600_000] },
	});
	let latest: TabMcpSnapshot | undefined;
	function Status() {
		latest = useTabMcpState();
		return <ConnectButton />;
	}
	render(
		<TabMcpProvider client={t}>
			<Status />
		</TabMcpProvider>,
	);
	await act(async () => {
		await t.connect({ resume: true });
	});
	const sent = await stub.next("identity");
	expect(latest?.identity).toBe("pending");
	await act(async () => {
		const answered = nextEvent(t, "identitychange");
		stub.send({
			type: "error",
			code: "identity_refused",
			message: "not this user",
			round: sent["round"],
		});
		await answered;
	});
	expect(latest).toMatchObject({
		identity: "refused",
		identityMessage: "not this user",
	});
	await act(async () => {
		const reconnecting = nextEvent(t, "reconnecting");
		stub.close(4004, "shutdown");
		await reconnecting;
	});
	expect(latest?.state).toBe("disconnected");
	expect(latest?.identity).toBe("none");
	expect(latest?.identityMessage).toBeUndefined();
	expect(latest?.reconnecting).toMatchObject({
		reason: "shutdown",
		attempt: 1,
	});
	const button = container.querySelector("button") as HTMLButtonElement;
	expect(button.textContent).toBe("Reconnecting…");
	expect(button.dataset["state"]).toBe("reconnecting");
});

test("a tool call reaches the latest execute; useToolCalls lists it with its end", async () => {
	const relay: TestRelay = startRelay();
	const t = newTab(relay.url);
	tabs.push(t);
	let calls: readonly ToolCallRecord[] = [];
	function Activity() {
		calls = useToolCalls({ limit: 5 });
		return null;
	}
	try {
		render(
			<TabMcpProvider client={t}>
				<AddTool offset={0} />
				<Activity />
			</TabMcpProvider>,
		);
		render(
			<TabMcpProvider client={t}>
				<AddTool offset={100} />
				<Activity />
			</TabMcpProvider>,
		);
		const session = await act(() => t.connect({ resume: true }));
		const client = await connectClient(
			session.address,
			await tokenFor(relay.store, session.address),
		);
		const ended = nextEvent(t, "toolcallend");
		const result = await act(() =>
			client.callTool({ name: "add", arguments: { a: 1, b: 2 } }),
		);
		expect(result.content).toEqual([{ type: "text", text: "103" }]);
		await act(async () => {
			await ended;
		});
		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatchObject({
			tool: "add",
			arguments: { a: 1, b: 2 },
			end: { outcome: "ok" },
		});
		await client.close();
	} finally {
		t.disconnect();
		await relay.stop();
	}
});

test("ConnectButton opens the connect dialog and takes a label function", async () => {
	const t = tab();
	render(
		<TabMcpProvider client={t}>
			<ConnectButton className="ai">
				{(s) => (s.state === "connected" ? "Connected" : "Connect")}
			</ConnectButton>
		</TabMcpProvider>,
	);
	const button = container.querySelector("button") as HTMLButtonElement;
	expect(button.textContent).toBe("Connect");
	expect(button.className).toBe("ai");
	expect(button.type).toBe("button");
	await act(async () => {
		button.click();
		await stub.next("hello");
	});
	await until(
		() =>
			button.textContent === "Connected" &&
			doc.querySelector("dialog")?.hasAttribute("open") === true,
	);
	expect(button.textContent).toBe("Connected");
	expect(doc.querySelector("dialog")?.hasAttribute("open")).toBe(true);
});

test("ConnectButton: preventDefault in onClick keeps the dialog closed", async () => {
	const t = tab();
	render(
		<TabMcpProvider client={t}>
			<ConnectButton onClick={(e) => e.preventDefault()} />
		</TabMcpProvider>,
	);
	const button = container.querySelector("button") as HTMLButtonElement;
	expect(button.textContent).toBe("Connect your AI app");
	act(() => button.click());
	await Bun.sleep(30);
	expect(t.state).toBe("disconnected");
	expect(doc.querySelector("dialog")).toBeNull();
});

test("the provider makes one instance; a new relay makes a new one, its own is disconnected on unmount", async () => {
	const seen: TabMcp[] = [];
	function Probe() {
		seen.push(useTabMcp());
		return null;
	}
	const storage = new MemoryStorage();
	function App(props: { relay: string; version: string }) {
		return (
			<TabMcpProvider
				relay={props.relay}
				server={{ name: "todo", version: props.version }}
				storage={storage}
			>
				<Probe />
			</TabMcpProvider>
		);
	}
	render(
		<StrictMode>
			<App relay={stub.url} version="1" />
		</StrictMode>,
	);
	render(
		<StrictMode>
			<App relay={stub.url} version="2" />
		</StrictMode>,
	);
	const first = seen.at(-1) as TabMcp;
	expect(new Set(seen.slice(-2)).size).toBe(1); // a new version is ignored
	await act(async () => {
		await first.connect({ resume: true });
	});
	expect(first.state).toBe("connected");

	const other = new StubRelay();
	const warn = console.warn;
	const warnings: unknown[] = [];
	console.warn = (...args: unknown[]) => warnings.push(args[0]);
	try {
		render(
			<StrictMode>
				<App relay={other.url} version="2" />
			</StrictMode>,
		);
		const second = seen.at(-1) as TabMcp;
		expect(second).not.toBe(first);
		expect(first.state).toBe("disconnected");
		expect(warnings).toHaveLength(1);
		await act(async () => {
			await second.connect({ resume: true });
		});
		act(() => root?.unmount());
		root = undefined;
		expect(second.state).toBe("disconnected");
	} finally {
		console.warn = warn;
		await other.stop();
	}
});

test("the provider uses the latest onConfirm", async () => {
	const relay: TestRelay = startRelay();
	const asked: string[] = [];
	let instance: TabMcp | undefined;
	function Probe() {
		instance = useTabMcp();
		useTool({
			name: "clear",
			description: "Clear everything",
			annotations: { consequentialHint: true },
			execute: () => "cleared",
		});
		return null;
	}
	function App() {
		const [who, setWho] = useState("first");
		return (
			<TabMcpProvider
				relay={relay.url}
				server={{ name: "todo", version: "1" }}
				storage={new MemoryStorage()}
				onConfirm={() => {
					asked.push(who);
					return true;
				}}
			>
				<button type="button" onClick={() => setWho("second")}>
					next
				</button>
				<Probe />
			</TabMcpProvider>
		);
	}
	try {
		render(<App />);
		act(() => (container.querySelector("button") as HTMLElement).click());
		const t = instance as TabMcp;
		const session = await act(() => t.connect({ resume: true }));
		const client = await connectClient(
			session.address,
			await tokenFor(relay.store, session.address),
		);
		await act(() => client.callTool({ name: "clear", arguments: {} }));
		expect(asked).toEqual(["second"]);
		await client.close();
	} finally {
		await relay.stop();
	}
});

test("useTabMcp outside a provider says what is missing", () => {
	function Lost() {
		useTabMcp();
		return null;
	}
	const quiet = console.error;
	console.error = () => {};
	try {
		expect(() => render(<Lost />)).toThrow(/no <TabMcpProvider>/);
	} finally {
		console.error = quiet;
		root = undefined; // React discarded the tree
	}
});

test("an identity refused before the provider mounted shows its message (review of PR #20)", async () => {
	stub.pairing = "oidc";
	const t = tab({ identityAssertion: () => "a.b.c" });
	await t.connect({ resume: true });
	const sent = await stub.next("identity");
	const refused = nextEvent(t, "identitychange");
	stub.send({
		type: "error",
		code: "identity_refused",
		message: "someone else",
		round: sent["round"],
	});
	await refused;
	expect(t.identityMessage).toBe("someone else");
	let latest: TabMcpSnapshot | undefined;
	function Status() {
		latest = useTabMcpState();
		return null;
	}
	render(
		<TabMcpProvider client={t}>
			<Status />
		</TabMcpProvider>,
	);
	expect(latest).toMatchObject({
		identity: "refused",
		identityMessage: "someone else",
	});
});

test("an onConfirm added after the first render is used; without one, the page's dialog asks (review of PR #20)", async () => {
	const relay: TestRelay = startRelay();
	const asked: string[] = [];
	let instance: TabMcp | undefined;
	let setConfirm: ((on: boolean) => void) | undefined;
	function Probe() {
		instance = useTabMcp();
		useTool({
			name: "clear",
			description: "Clear everything",
			annotations: { consequentialHint: true },
			execute: () => "cleared",
		});
		return null;
	}
	function App() {
		const [on, setOn] = useState(false);
		setConfirm = setOn;
		return (
			<TabMcpProvider
				relay={relay.url}
				server={{ name: "todo", version: "1" }}
				storage={new MemoryStorage()}
				{...(on
					? {
							onConfirm: () => {
								asked.push("page");
								return true;
							},
						}
					: {})}
			>
				<Probe />
			</TabMcpProvider>
		);
	}
	try {
		render(<App />);
		const t = instance as TabMcp;
		const session = await act(() => t.connect({ resume: true }));
		const client = await connectClient(
			session.address,
			await tokenFor(relay.store, session.address),
		);
		// No onConfirm yet: the library's dialog asks; "Don't allow" declines.
		const first = client.callTool({ name: "clear", arguments: {} });
		await until(() => doc.querySelector("dialog.tab-mcp-confirm") !== null);
		const deny = [
			...doc.querySelectorAll("dialog.tab-mcp-confirm button"),
		].find((b) => b.textContent === "Don't allow") as HTMLButtonElement;
		act(() => deny.click());
		expect((await first).isError).toBe(true);
		act(() => setConfirm?.(true));
		const second = await act(() =>
			client.callTool({ name: "clear", arguments: {} }),
		);
		expect(second.isError).toBeFalsy();
		expect(asked).toEqual(["page"]);
		await client.close();
	} finally {
		await relay.stop();
	}
});

test("game feedback 3: the default label says the connection is lost after three failed attempts", () => {
	const snapshot = (attempt: number): TabMcpSnapshot => ({
		state: "disconnected",
		address: undefined,
		session: undefined,
		grants: [],
		pairingCode: undefined,
		identity: "none",
		identityMessage: undefined,
		reconnecting: { reason: "network", attempt, at: 0 },
		tools: [],
	});
	expect(connectLabel(snapshot(1))).toBe("Reconnecting…");
	expect(connectLabel(snapshot(3))).toBe("Reconnecting…");
	expect(connectLabel(snapshot(4))).toBe("Connection lost, retrying…");
});

test("game feedback 8: useTool and registerTool take the input's type", () => {
	const add: Tool<{ a: number; b: number }> = {
		name: "add",
		description: "Add two numbers",
		inputSchema: {
			type: "object",
			properties: { a: { type: "number" }, b: { type: "number" } },
			required: ["a", "b"],
		},
		execute: ({ a, b }) => a + b,
	};
	function Adder() {
		useTool(add);
		useTool<{ text: string }>({
			name: "echo",
			description: "Echo the text",
			execute: ({ text }) => text.toUpperCase(),
		});
		return null;
	}
	expect(typeof Adder).toBe("function");
	expect(add.execute({ a: 1, b: 2 }, {} as never)).toBe(3);
});
