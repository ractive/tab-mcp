"use client";
/**
 * `@ractive-ch/tab-mcp-client/react`: React bindings for single-page apps
 * (iteration 9). One `TabMcp` per `<TabMcpProvider>`, hooks for its state,
 * its tools and the calls of AI apps, and a button that opens the connect
 * dialog. `react` (18.3 or 19) is an optional peer dependency; the core
 * entry stays free of it.
 */

import {
	type ButtonHTMLAttributes,
	createContext,
	createElement,
	type DependencyList,
	type MouseEvent,
	type ReactElement,
	type ReactNode,
	useContext,
	useEffect,
	useInsertionEffect,
	useMemo,
	useRef,
	useState,
	useSyncExternalStore,
} from "react";
import {
	type ConfirmRequest,
	type ConnectionState,
	type Grant,
	type IdentityAssertionRequest,
	type IdentityState,
	type PairingCode,
	type ReconnectingInfo,
	type SessionInfo,
	TabMcp,
	type TabMcpEventMap,
	type TabMcpOptions,
	type Tool,
	type ToolCallEnd,
	type ToolCallStart,
} from "./index.ts";

/** What `useTabMcpState()` returns: one object per change, the same object otherwise. */
export interface TabMcpSnapshot {
	state: ConnectionState;
	/** The MCP address to give to AI apps, while connected. */
	address: string | undefined;
	session: SessionInfo | undefined;
	/** The AI apps connected to this address. */
	grants: readonly Grant[];
	/** The pairing code to show, while the connect dialog is open. */
	pairingCode: PairingCode | undefined;
	/** Who the relay knows as the page's user (identity binding). */
	identity: IdentityState;
	/** Why the relay refused the identity (`identity: "refused"`). */
	identityMessage: string | undefined;
	/** While the library connects again by itself after the connection broke. */
	reconnecting: ReconnectingInfo | undefined;
	/** Names of the registered tools. */
	tools: readonly string[];
}

const EMPTY: readonly never[] = Object.freeze([]);

/** What the server renders, and what hydration starts from. */
const SERVER_SNAPSHOT: TabMcpSnapshot = Object.freeze({
	state: "disconnected",
	address: undefined,
	session: undefined,
	grants: EMPTY,
	pairingCode: undefined,
	identity: "none",
	identityMessage: undefined,
	reconnecting: undefined,
	tools: EMPTY,
});

const STATE_EVENTS = [
	"statechange",
	"connected",
	"disconnected",
	"grantschange",
	"pairingcode",
	"identitychange",
	"reconnecting",
	"toolschange",
] as const satisfies readonly (keyof TabMcpEventMap)[];

/** The external store of one `TabMcp`: a snapshot that changes only with the instance. */
class Store {
	readonly #mcp: TabMcp;
	readonly #listeners = new Set<() => void>();
	#snapshot: TabMcpSnapshot;
	#identityMessage: string | undefined;

	constructor(mcp: TabMcp) {
		this.#mcp = mcp;
		this.#snapshot = this.#read(SERVER_SNAPSHOT);
		const update = () => {
			const next = this.#read(this.#snapshot);
			if (next === this.#snapshot) return;
			this.#snapshot = next;
			for (const listener of [...this.#listeners]) listener();
		};
		mcp.addEventListener("identitychange", (event) => {
			this.#identityMessage = event.detail.message;
		});
		for (const type of STATE_EVENTS) mcp.addEventListener(type, update);
	}

	readonly subscribe = (listener: () => void): (() => void) => {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	};

	readonly getSnapshot = (): TabMcpSnapshot => this.#snapshot;

	/** The current values; `previous` itself when none changed. */
	#read(previous: TabMcpSnapshot): TabMcpSnapshot {
		const mcp = this.#mcp;
		const tools = mcp.tools;
		const next: TabMcpSnapshot = {
			state: mcp.state,
			address: mcp.address,
			session: mcp.session,
			grants: mcp.grants,
			pairingCode: mcp.pairingCode,
			identity: mcp.identity,
			identityMessage:
				mcp.identity === "refused" ? this.#identityMessage : undefined,
			reconnecting: mcp.reconnecting,
			tools:
				tools.length === previous.tools.length &&
				tools.every((t, i) => t === previous.tools[i])
					? previous.tools
					: tools,
		};
		const same = (Object.keys(next) as (keyof TabMcpSnapshot)[]).every(
			(key) => next[key] === previous[key],
		);
		return same ? previous : next;
	}
}

const stores = new WeakMap<TabMcp, Store>();

function storeOf(mcp: TabMcp): Store {
	let store = stores.get(mcp);
	if (store === undefined) {
		store = new Store(mcp);
		stores.set(mcp, store);
	}
	return store;
}

const Context = createContext<TabMcp | undefined>(undefined);

/** Props of `TabMcpProvider`: the `TabMcp` options, or an instance of your own. */
export type TabMcpProviderProps = (
	| (TabMcpOptions & { client?: undefined })
	| { client: TabMcp }
) & { children?: ReactNode };

/**
 * Makes one `TabMcp` for its tree from the props of its first render. A
 * changed `relay` or `server.name` makes a new instance (and warns); other
 * changes are ignored, but `onConfirm` and `identityAssertion` are always
 * the latest ones. Pass `client` to use an instance of your own instead. The
 * provider's own instance is disconnected when the provider unmounts; it
 * never connects on the server.
 */
export function TabMcpProvider(props: TabMcpProviderProps): ReactElement {
	const latest = useRef(props);
	useInsertionEffect(() => {
		latest.current = props;
	});
	const own = props.client === undefined ? props : undefined;
	const relay = own?.relay;
	const serverName = own?.server?.name;
	// biome-ignore lint/correctness/useExhaustiveDependencies: only the relay and the server name make a new instance
	const mcp = useMemo((): TabMcp => {
		if (props.client !== undefined) return props.client;
		const {
			children: _,
			client: __,
			...options
		} = props as TabMcpOptions & {
			children?: ReactNode;
			client?: undefined;
		};
		const handlers = () => latest.current as Partial<TabMcpOptions>;
		if (options.onConfirm !== undefined) {
			const first = options.onConfirm;
			options.onConfirm = (request: ConfirmRequest) =>
				(handlers().onConfirm ?? first)(request);
		}
		if (options.identityAssertion !== undefined) {
			const first = options.identityAssertion;
			options.identityAssertion = (request: IdentityAssertionRequest) =>
				(handlers().identityAssertion ?? first)(request);
		}
		return new TabMcp(options);
	}, [props.client, relay, serverName]);

	const previous = useRef<TabMcp | undefined>(undefined);
	useEffect(() => {
		if (
			previous.current !== undefined &&
			previous.current !== mcp &&
			props.client === undefined
		) {
			console.warn(
				"TabMcpProvider: relay or server.name changed, so the page has a new TabMcp; its tools and connection start over",
			);
		}
		previous.current = mcp;
		if (props.client !== undefined) return;
		return () => mcp.disconnect();
	}, [mcp, props.client]);

	return createElement(Context.Provider, { value: mcp }, props.children);
}

/** The provider's `TabMcp`, for everything the hooks do not cover. */
export function useTabMcp(): TabMcp {
	const mcp = useContext(Context);
	if (mcp === undefined)
		throw new Error("useTabMcp: no <TabMcpProvider> above this component");
	return mcp;
}

/**
 * The connection state, address, grants, pairing code, identity and
 * reconnecting of the provider's `TabMcp`. Re-renders only when one of them
 * changes; the server and hydration see `disconnected`.
 */
export function useTabMcpState(): TabMcpSnapshot {
	const store = storeOf(useTabMcp());
	return useSyncExternalStore(
		store.subscribe,
		store.getSnapshot,
		() => SERVER_SNAPSHOT,
	);
}

/**
 * Registers a tool while the component is mounted (with an `AbortSignal`,
 * aborted on unmount). `execute` is always the latest one, so a new closure
 * on each render does not register again; the tool is registered again only
 * when its name, title, description, input schema or annotations change, or
 * one of `deps`. A duplicate name or an invalid tool is thrown from the
 * component's next render, for an error boundary.
 */
export function useTool(tool: Tool, deps: DependencyList = EMPTY): void {
	const mcp = useTabMcp();
	const latest = useRef(tool);
	useInsertionEffect(() => {
		latest.current = tool;
	});
	const [failure, setFailure] = useState<{ error: unknown } | undefined>();
	if (failure !== undefined) throw failure.error;
	const shape = JSON.stringify([
		tool.name,
		tool.title,
		tool.description,
		tool.inputSchema,
		tool.annotations,
	]);
	// biome-ignore lint/correctness/useExhaustiveDependencies: `shape` and `deps` stand for the tool; `execute` is read through the ref
	useEffect(() => {
		const controller = new AbortController();
		const { execute: _, ...fields } = latest.current;
		mcp
			.registerTool(
				{
					...fields,
					execute: (input, options) => latest.current.execute(input, options),
				},
				{ signal: controller.signal },
			)
			.catch((error: unknown) => {
				if (!controller.signal.aborted) setFailure({ error });
			});
		return () => controller.abort();
	}, [mcp, shape, ...deps]);
}

/** A tool call of an AI app, as `useToolCalls()` lists it. */
export interface ToolCallRecord extends ToolCallStart {
	/** When it started, `Date.now()`. */
	startedAt: number;
	/** How it ended; missing while it runs. */
	end?: ToolCallEnd;
}

export interface UseToolCallsOptions {
	/** How many calls to keep; default 20. */
	limit?: number;
}

/**
 * The recent tool calls of AI apps since the component mounted, newest
 * first, each with its end once it is over: for an activity view.
 */
export function useToolCalls(
	options: UseToolCallsOptions = {},
): readonly ToolCallRecord[] {
	const mcp = useTabMcp();
	const limit = Math.max(0, options.limit ?? 20);
	const [calls, setCalls] = useState<readonly ToolCallRecord[]>(EMPTY);
	useEffect(() => {
		const started = (event: TabMcpEventMap["toolcall"]) => {
			const record: ToolCallRecord = { ...event.detail, startedAt: Date.now() };
			setCalls((list) => [record, ...list].slice(0, limit));
		};
		const ended = (event: TabMcpEventMap["toolcallend"]) => {
			const end = event.detail;
			setCalls((list) =>
				list.some((r) => r.id === end.id)
					? list.map((r) => (r.id === end.id ? { ...r, end } : r))
					: list,
			);
		};
		mcp.addEventListener("toolcall", started);
		mcp.addEventListener("toolcallend", ended);
		setCalls((list) => (list.length > limit ? list.slice(0, limit) : list));
		return () => {
			mcp.removeEventListener("toolcall", started);
			mcp.removeEventListener("toolcallend", ended);
		};
	}, [mcp, limit]);
	return calls;
}

/** Props of `ConnectButton`: a button's, with `children` that may depend on the state. */
export interface ConnectButtonProps
	extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children" | "type"> {
	/** The label; default: the state ("Connect your AI app", "AI app connected"). */
	children?: ReactNode | ((state: TabMcpSnapshot) => ReactNode);
}

/** The default label of `ConnectButton`. */
export function connectLabel(state: TabMcpSnapshot): string {
	if (state.state === "connected" && state.grants.length > 0)
		return state.grants.length === 1
			? "AI app connected"
			: `${state.grants.length} AI apps connected`;
	if (state.reconnecting !== undefined) return "Reconnecting…";
	if (state.state === "connecting") return "Connecting…";
	return "Connect your AI app";
}

/**
 * A button that opens the library's "Connect your AI app" dialog
 * (`showConnectDialog()`), labelled with the state. `data-state` is
 * `disconnected`, `connecting`, `connected` or `reconnecting`, for styling.
 * An `onClick` that calls `event.preventDefault()` keeps the dialog closed.
 */
export function ConnectButton({
	children,
	onClick,
	...rest
}: ConnectButtonProps): ReactElement {
	const mcp = useTabMcp();
	const state = useTabMcpState();
	const label =
		children === undefined
			? connectLabel(state)
			: typeof children === "function"
				? children(state)
				: children;
	return createElement(
		"button",
		{
			type: "button",
			"data-state":
				state.reconnecting !== undefined && state.state !== "connected"
					? "reconnecting"
					: state.state,
			...rest,
			onClick: (event: MouseEvent<HTMLButtonElement>) => {
				onClick?.(event);
				if (event.defaultPrevented) return;
				mcp.showConnectDialog().catch((error: unknown) => {
					console.error(error);
				});
			},
		},
		label,
	);
}
