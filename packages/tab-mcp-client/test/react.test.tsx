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
	useEffect,
	useState,
	version,
} from "react";
import { createRoot, type Root } from "react-dom/client";
import type { TabMcp } from "../src/index.ts";
import {
	type AllowedToolsSnapshot,
	BUTTON_TEXTS,
	ConnectButton,
	TabMcpProvider,
	type TabMcpSnapshot,
	type ToolCallRecord,
	useAllowedTools,
	useTabMcp,
	useTabMcpState,
	useTool,
	useToolCalls,
} from "../src/react.ts";
import { STRINGS } from "../src/strings.ts";
import type { Tool, ToolCaller } from "../src/types.ts";
import {
	connectClient,
	MemoryStorage,
	newTab,
	nextEvent,
	nextState,
	rpc,
	setTiming,
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

test("useTool registers again only when the tool changes, not for a new execute (CU 18)", () => {
	const t = tab();
	function Versioned(props: { version: number }) {
		useTool(addTool(() => props.version));
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
	expect(changes).toEqual([]);
});

test("useTool passes callers on to registerTool and registers again when they change", () => {
	const t = tab();
	const seen: unknown[] = [];
	const register = t.registerTool.bind(t);
	t.registerTool = (tool, options) => {
		seen.push(options?.callers);
		return register(tool, options);
	};
	function Mirrored(props: { callers?: ToolCaller[] }) {
		useTool(
			addTool(() => 1),
			props.callers === undefined ? {} : { callers: props.callers },
		);
		return null;
	}
	// A new array with the same callers on each render registers once.
	render(
		<TabMcpProvider client={t}>
			<Mirrored callers={["local", "webmcp"]} />
		</TabMcpProvider>,
	);
	render(
		<TabMcpProvider client={t}>
			<Mirrored callers={["local", "webmcp"]} />
		</TabMcpProvider>,
	);
	render(
		<TabMcpProvider client={t}>
			<Mirrored />
		</TabMcpProvider>,
	);
	expect(seen).toEqual([["local", "webmcp"], undefined]);
	expect(t.tools).toEqual(["add"]);
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
	// Identity binding's time for a sign-in (DEC-202).
	const until = new Date(Date.now() + 600_000).toISOString();
	await act(async () => {
		const open = nextEvent(t, "pairinguntil");
		stub.send({ type: "pairing.open", expiresAt: until });
		await open;
	});
	expect(snapshots.at(-1)?.pairingUntil).toBe(until);
	// The tab-mcp browser extension (DEC-207), as the mirror's chunk sets it.
	const extension = Object.freeze({
		name: "tab-mcp browser extension",
		version: "0.3.0",
		apps: Object.freeze([{ name: "Claude", host: "claude.ai" }]),
		whileInFront: true,
	});
	act(() => {
		Object.defineProperty(t, "extension", {
			get: () => extension,
			configurable: true,
		});
		t.dispatchEvent(
			new CustomEvent("extensionchange", { detail: { extension } }),
		);
	});
	expect(snapshots.at(-1)?.extension).toBe(extension);
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

test("useAllowedTools: the page's own switches as state, one object per change (DEC-200)", async () => {
	stub.grants = [
		{
			grantId: "g_1",
			client: { id: "https://c.example/c.json", name: "C", host: "c.example" },
			createdAt: new Date().toISOString(),
		},
	];
	const t = tab();
	await t.registerTool({
		name: "wipe",
		description: "Wipes",
		annotations: { consequentialHint: true, destructiveHint: true },
		execute: () => "ok",
	});
	const snapshots: AllowedToolsSnapshot[] = [];
	function Switches() {
		snapshots.push(useAllowedTools("g_1"));
		return null;
	}
	render(
		<TabMcpProvider client={t}>
			<Switches />
		</TabMcpProvider>,
	);
	expect(snapshots.at(-1)).toMatchObject({
		everything: false,
		tools: [
			{ name: "wipe", description: "Wipes", destructive: true, allowed: false },
		],
	});
	await act(async () => {
		await t.connect({ resume: true });
	});
	const renders = snapshots.length;
	act(() => snapshots.at(-1)?.allowedTools.allow("g_1", "wipe"));
	expect(snapshots.at(-1)?.tools[0]?.allowed).toBe(true);
	act(() => snapshots.at(-1)?.allowedTools.setEverything("g_1", true));
	expect(snapshots.at(-1)?.everything).toBe(true);
	expect(snapshots).toHaveLength(renders + 2);
	// No change, no render: the same object.
	act(() => snapshots.at(-1)?.allowedTools.setEverything("g_1", true));
	expect(snapshots).toHaveLength(renders + 2);
	// A tool registered later gets its switch.
	await act(async () => {
		await t.registerTool({
			name: "send",
			description: "Sends",
			annotations: { consequentialHint: true },
			execute: () => "ok",
		});
	});
	expect(snapshots.at(-1)?.tools.map((x) => [x.name, x.allowed])).toEqual([
		["wipe", true],
		["send", true],
	]);
});

test("useTabMcpState shows identity binding and reconnecting", async () => {
	stub.pairing = "oidc";
	const restore = setTiming({ reconnectDelaysMs: [600_000] });
	const t = tab({ identityAssertion: () => "a.b.c" });
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
		const reconnecting = nextState(t, "reconnecting");
		stub.close(4004, "shutdown");
		await reconnecting;
	});
	expect(latest?.state).toBe("reconnecting");
	expect(latest?.identity).toBe("none");
	expect(latest?.identityMessage).toBeUndefined();
	expect(latest?.reconnecting).toMatchObject({
		reason: "shutdown",
		attempt: 1,
	});
	const button = container.querySelector("button") as HTMLButtonElement;
	expect(button.textContent).toBe("Reconnecting…");
	expect(button.dataset["state"]).toBe("reconnecting");
	restore();
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
			await tokenFor(relay, session.address),
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

test("without a relay the provider's tools are served over a port, and ConnectButton renders nothing (iteration 28)", async () => {
	let mcp: TabMcp | undefined;
	function Tools() {
		mcp = useTabMcp();
		useTool({ name: "ping", description: "Ping", execute: () => "pong" });
		return <ConnectButton />;
	}
	render(
		<TabMcpProvider server={{ name: "no-relay", version: "1.0.0", icons: [] }}>
			<Tools />
		</TabMcpProvider>,
	);
	expect(container.querySelector("button")).toBeNull();
	expect(mcp?.hasRelay).toBe(false);
	expect(mcp?.tools).toEqual(["ping"]);
	const { port1, port2 } = new MessageChannel();
	const answered = new Promise<{ body: string }>((resolve) => {
		port2.onmessage = (event: MessageEvent) => resolve(event.data);
	});
	const served = await (mcp as TabMcp).serve(port1, {
		client: { id: "chat" },
	});
	port2.postMessage({
		type: "http.request",
		id: "r1",
		method: "POST",
		path: "/mcp",
		headers: {
			"content-type": "application/json",
			accept: "application/json, text/event-stream",
			"mcp-protocol-version": "2026-07-28",
			"mcp-method": "tools/list",
		},
		body: JSON.stringify(rpc(1, "tools/list")),
	});
	expect((await answered).body).toContain('"name":"ping"');
	served.close();
	port1.close();
	port2.close();
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
		await act(async () => {}); // disconnected a moment after (CU 24)
		expect(first.state).toBe("disconnected");
		expect(warnings).toHaveLength(1);
		await act(async () => {
			await second.connect({ resume: true });
		});
		act(() => root?.unmount());
		root = undefined;
		await Promise.resolve();
		expect(second.state).toBe("disconnected");
	} finally {
		console.warn = warn;
		await other.stop();
	}
});

test("StrictMode: a child's connect({ resume: true }) is not cancelled by the provider's simulated unmount (CU 24)", async () => {
	let instance: TabMcp | undefined;
	const results: string[] = [];
	function Resume() {
		const mcp = useTabMcp();
		instance = mcp;
		useEffect(() => {
			mcp.connect({ resume: true }).then(
				() => results.push("connected"),
				(error: Error) => results.push(error.message),
			);
		}, [mcp]);
		return null;
	}
	render(
		<StrictMode>
			<TabMcpProvider
				relay={stub.url}
				server={{ name: "resume", version: "1" }}
				storage={new MemoryStorage()}
			>
				<Resume />
			</TabMcpProvider>
		</StrictMode>,
	);
	await until(() => results.length >= 2);
	expect(results).toEqual(["connected", "connected"]);
	expect(instance?.state).toBe("connected");
	act(() => root?.unmount());
	root = undefined;
	await Promise.resolve();
	expect(instance?.state).toBe("disconnected");
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
			await tokenFor(relay, session.address),
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
			await tokenFor(relay, session.address),
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

test("the provider without the page's onConfirm warns about a tool that asks with exposedTo; with one it does not (DEC-215)", async () => {
	const g = globalThis as Record<string, unknown>;
	const savedDocument = g["Document"];
	const Doc = window.Document as unknown as { prototype: object };
	const registered: string[] = [];
	Object.defineProperty(Doc.prototype, "modelContext", {
		configurable: true,
		get: () => ({
			registerTool: (tool: { name: string }) => {
				registered.push(tool.name);
			},
		}),
	});
	g["Document"] = Doc;
	const warned: string[] = [];
	const quiet = console.warn;
	console.warn = (...args: unknown[]) => warned.push(String(args[0]));
	function Probe() {
		useTool(
			{
				name: "clear",
				description: "Clear everything",
				annotations: { consequentialHint: true },
				execute: () => "cleared",
			},
			{ exposedTo: ["https://embedder.example"] },
		);
		return null;
	}
	const exposed = () => warned.filter((w) => w.includes("(its exposedTo)"));
	try {
		render(
			<TabMcpProvider
				server={{ name: "bare", version: "1" }}
				storage={null}
				webmcp
			>
				<Probe />
			</TabMcpProvider>,
		);
		await until(() => exposed().length > 0);
		expect(exposed()).toHaveLength(1);
		act(() => root?.unmount());
		root = undefined;
		warned.length = 0;
		render(
			<TabMcpProvider
				server={{ name: "asks", version: "1" }}
				storage={null}
				webmcp
				onConfirm={() => false}
			>
				<Probe />
			</TabMcpProvider>,
		);
		// Mirrored by the second provider, and the step after the registration
		// (where the warning would be) has run.
		await until(() => registered.length === 2);
		await act(async () => {
			await Bun.sleep(5);
		});
		expect(registered).toEqual(["clear", "clear"]);
		expect(exposed()).toEqual([]);
	} finally {
		console.warn = quiet;
		delete (Doc.prototype as { modelContext?: unknown }).modelContext;
		if (savedDocument === undefined) delete g["Document"];
		else g["Document"] = savedDocument;
	}
});

test("an agent in the browser: a tool that asks runs without the library's dialog; an onConfirm added later decides (DEC-215)", async () => {
	interface Native {
		name: string;
		execute: (input: unknown, options: { signal: AbortSignal }) => unknown;
	}
	const native = new Map<string, Native>();
	const g = globalThis as Record<string, unknown>;
	const savedDocument = g["Document"];
	const Doc = window.Document as unknown as { prototype: object };
	Object.defineProperty(Doc.prototype, "modelContext", {
		configurable: true,
		get: () => ({
			registerTool: (tool: Native) => {
				native.set(tool.name, tool);
			},
		}),
	});
	g["Document"] = Doc;
	const asked: string[] = [];
	let setConfirm: ((on: boolean) => void) | undefined;
	function Probe() {
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
				server={{ name: "todo", version: "1" }}
				storage={null}
				webmcp
				{...(on
					? {
							onConfirm: () => {
								asked.push("page");
								return false;
							},
						}
					: {})}
			>
				<Probe />
			</TabMcpProvider>
		);
	}
	const call = () =>
		act(() =>
			native
				.get("clear")
				?.execute({}, { signal: new AbortController().signal }),
		);
	try {
		render(<App />);
		await until(() => native.has("clear"));
		// No onConfirm: the provider's default is the library's, which shows
		// an agent in the browser nothing.
		expect(await call()).toBe("cleared");
		expect(doc.querySelector("dialog")).toBeNull();
		act(() => setConfirm?.(true));
		expect(await call()).toEqual({
			error: "The user did not allow clear to run.",
		});
		expect(asked).toEqual(["page"]);
	} finally {
		delete (Doc.prototype as { modelContext?: unknown }).modelContext;
		if (savedDocument === undefined) delete g["Document"];
		else g["Document"] = savedDocument;
	}
});

test("game feedback 3: the default label says the connection is lost after three failed attempts", () => {
	const t = tab();
	let attempt = 1;
	// Reconnecting, attempt by attempt, without a relay to break.
	Object.defineProperty(t, "state", { get: () => "reconnecting" });
	Object.defineProperty(t, "reconnecting", {
		get: () => ({ reason: "network", attempt, at: 0 }),
	});
	render(
		<TabMcpProvider client={t}>
			<ConnectButton />
		</TabMcpProvider>,
	);
	const button = container.querySelector("button") as HTMLButtonElement;
	const labels: (string | null)[] = [];
	for (const next of [1, 3, 4]) {
		attempt = next;
		act(() => {
			t.dispatchEvent(
				new CustomEvent("statechange", { detail: { state: "reconnecting" } }),
			);
		});
		labels.push(button.textContent);
	}
	expect(labels).toEqual([
		"Reconnecting…",
		"Reconnecting…",
		"Connection lost. Reconnecting…",
	]);
	expect(button.dataset["state"]).toBe("reconnecting");
});

test("ConnectButton's inline English texts are those of the table (review of PR 181)", () => {
	const keys = Object.keys(BUTTON_TEXTS) as (keyof typeof BUTTON_TEXTS)[];
	expect(Object.fromEntries(keys.map((k) => [k, STRINGS[k]]))).toEqual(
		BUTTON_TEXTS,
	);
});

test("ConnectButton says what the TabMcp's ui.strings say, plural forms by its language (DEC-208)", () => {
	const t = tab({
		ui: {
			strings: {
				lang: "de",
				connectTitle: "KI-App verbinden",
				buttonConnected: {
					one: "KI-App verbunden",
					other: "{n} KI-Apps verbunden",
				},
			},
		},
	});
	let grants: { grantId: string }[] = [];
	Object.defineProperty(t, "grants", { get: () => grants });
	render(
		<TabMcpProvider client={t}>
			<ConnectButton />
		</TabMcpProvider>,
	);
	const button = container.querySelector("button") as HTMLButtonElement;
	expect(button.textContent).toBe("KI-App verbinden");
	Object.defineProperty(t, "state", { get: () => "connected" });
	const labels: (string | null)[] = [];
	for (const n of [1, 3]) {
		grants = Array.from({ length: n }, (_, i) => ({ grantId: `g_${i}` }));
		act(() => {
			t.dispatchEvent(new CustomEvent("grantschange", { detail: {} }));
		});
		labels.push(button.textContent);
	}
	expect(labels).toEqual(["KI-App verbunden", "3 KI-Apps verbunden"]);
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
	// review of PR 68: the input is always a JSON object, so a primitive is refused.
	// @ts-expect-error string does not satisfy `object`
	const wrong: Tool<string> | undefined = undefined;
	expect(wrong).toBeUndefined();
	expect(typeof Adder).toBe("function");
	expect(add.execute({ a: 1, b: 2 }, {} as never)).toBe(3);
});
