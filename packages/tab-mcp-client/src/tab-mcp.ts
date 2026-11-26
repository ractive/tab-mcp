/**
 * `TabMcp`: the eagerly loaded core (DEC-035). It holds the tool registry, the
 * events, the pairing state and the address secret; `connect()` loads the
 * connection and the MCP handler with a dynamic `import()`.
 */

import type { CallHost, ConnectionHandle, ConnectionHost } from "./internal.ts";
import type { GrantRef, SessionMessage, TabMessage } from "./protocol.ts";
import { ToolRegistry } from "./registry.ts";
import { SecretStore } from "./secret.ts";
import type {
	BrowserExtension,
	ConfirmAnswer,
	ConfirmHandler,
	ConfirmRequest,
	ConnectionState,
	ConnectOptions,
	DialogOptions,
	DisconnectReason,
	Grant,
	IdentityAssertionHandler,
	IdentityState,
	ModelContextRegisterToolOptions,
	ModelContextTool,
	PairingCode,
	ReconnectingInfo,
	RelayClient,
	RelayMessages,
	ServeHandle,
	ServeOptions,
	ServerInfo,
	SessionInfo,
	TabMcpEventMap,
	TabMcpOptions,
	ToolCallClient,
	TunnelPort,
} from "./types.ts";
import { LIBRARY_NAME, VERSION } from "./version.ts";
import type { ModelContext } from "./webmcp.ts";

/**
 * The browser's own `ModelContext` of this document, read when a `TabMcp` is
 * made, through `Document.prototype`'s getter: never an own
 * `document.modelContext` (a polyfill such as `@mcp-b/global`, or any page
 * script; DEC-115). `undefined` without native WebMCP or a document. In the
 * core; the mirror itself is a chunk of its own (DEC-171).
 */
function nativeContext(): ModelContext | undefined {
	try {
		return Object.getOwnPropertyDescriptor(
			Document.prototype,
			"modelContext",
		)?.get?.call(document);
	} catch {
		return undefined; // no document
	}
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * How long a replaced tab that heard no `claimed` yet waits for one before it
 * reports `replaced`: the sibling's session and this tab's `bye` leave the
 * relay at about the same time, so the message usually comes after the `bye`.
 */
export const SIBLING_GRACE_MS = 1_000;

/**
 * The library's waits, in milliseconds: constants for pages (CU 17), which
 * only tests change. `reconnectDelaysMs`: before each reconnect attempt,
 * the last one repeating. `answerTimeoutMs`: for an identity assertion and
 * the relay's answer to it, and for the relay's answer to `revoke()` and
 * `signOut()`. `siblingGraceMs`: {@link SIBLING_GRACE_MS}, passed to the
 * connection.
 */
export const timing: {
	reconnectDelaysMs: number[];
	answerTimeoutMs: number;
	siblingGraceMs: number;
} = {
	reconnectDelaysMs: [5_000, 10_000, 20_000, 40_000, 60_000],
	answerTimeoutMs: 15_000,
	siblingGraceMs: SIBLING_GRACE_MS,
};
/** Reasons after which the library connects again by itself. */
const RECONNECT_REASONS = new Set<DisconnectReason>([
	"network",
	"heartbeat",
	"shutdown",
]);

/** A grant as the page sees it: frozen, so a page cannot change what decides Always allow. */
function frozenGrant(grant: Grant): Grant {
	return Object.freeze({
		...grant,
		client: Object.freeze({ ...grant.client }),
	});
}

/** What the relay accepts as `hello.app.name` (protocol: session). */
function isAppName(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.trim().length > 0 &&
		value.length <= 64 &&
		![...value].some((ch) => {
			const c = ch.codePointAt(0) ?? 0;
			return c < 0x20 || (c >= 0x7f && c <= 0x9f);
		})
	);
}

/** An app id as the relay takes it (DEC-196). */
const APP_ID = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;

/**
 * The app id a server name gives: lower case, letters without their marks,
 * each run of anything but a-z and 0-9 as one `-`, none at either end, at
 * most 32 characters; `""` when nothing is left.
 */
export function appIdOf(name: string): string {
	return name
		.normalize("NFKD")
		.replace(/\p{M}/gu, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "")
		.slice(0, 32)
		.replace(/-$/, "");
}

/** `wss://host/tab` for a relay given as `https://host`, `wss://host` or with `/tab`. */
export function tabUrl(relay: string): { url: string; origin: string } {
	let u: URL;
	try {
		u = new URL(relay);
	} catch {
		throw new TypeError(`TabMcp: relay is not a URL: ${relay}`);
	}
	const secure = u.protocol === "https:" || u.protocol === "wss:";
	if (!secure && u.protocol !== "http:" && u.protocol !== "ws:") {
		throw new TypeError(
			`TabMcp: relay must be an https: or wss: URL: ${relay}`,
		);
	}
	// The secret travels in hello: never in clear text beyond this machine.
	if (!secure && !LOOPBACK.has(u.hostname)) {
		throw new TypeError(
			`TabMcp: relay must use https: or wss: (http: only for localhost): ${relay}`,
		);
	}
	const origin = `${secure ? "https:" : "http:"}//${u.host}`;
	const path = u.pathname.replace(/\/+$/, "");
	u.protocol = secure ? "wss:" : "ws:";
	u.pathname = path.endsWith("/tab") ? path : `${path}/tab`;
	u.search = "";
	u.hash = "";
	return { url: u.href, origin };
}

function hostOf(url: string): string {
	try {
		return new URL(url).host;
	} catch {
		return "";
	}
}

function sessionInfo(m: SessionMessage): SessionInfo {
	const info: SessionInfo = {
		sessionId: m.sessionId,
		address: m.address,
		origin: m.origin,
		pairing: m.pairing === "oidc" ? "oidc" : "code",
		expiresAt: m.expiresAt,
		limits: m.limits,
	};
	if (m.appName !== undefined) info.appName = m.appName;
	return info;
}

/** What `connect()`, `showConnectDialog()` and `disconnectAll()` reject with without a relay. */
function noRelay(): Promise<never> {
	return Promise.reject(new TypeError("TabMcp: this TabMcp has no relay"));
}

/**
 * A rejection of `disconnectAll()`: `secretChanged` says whether the apps
 * were disconnected and the secret is new (only connecting with it failed)
 * or not (the old one could not be taken back and is kept, with its grants).
 */
function changed(error: unknown, secretChanged: boolean): unknown {
	return Object.assign(Object(error), { secretChanged });
}

/** What a method that asks the relay rejects with while it cannot. */
function notConnected(): Promise<never> {
	return Promise.reject(
		new DOMException("TabMcp: not connected", "InvalidStateError"),
	);
}

/** The lazy chunk (`connection.ts`). */
type Lazy = typeof import("./connection.ts");

type Listener<K extends keyof TabMcpEventMap> = (
	event: TabMcpEventMap[K],
) => void;

/**
 * Offers a page's tools to AI apps through a tab-mcp relay (and, without
 * `relay`, only through `serve` and WebMCP).
 *
 * ```ts
 * const mcp = new TabMcp({ relay: "https://relay.example", server: { name: "Calculator", version: "1.0.0" } });
 * await mcp.registerTool({ name: "add", description: "Add two numbers", execute: ({ a, b }) => Number(a) + Number(b) });
 * button.onclick = () => mcp.showConnectDialog();
 * ```
 */
export class TabMcp extends EventTarget {
	readonly #registry = new ToolRegistry();
	/**
	 * Unless `webmcp: false`: the tab-mcp browser extension while it serves this
	 * page, with the AI apps that reach the page's tools through it (DEC-207);
	 * `extensionchange` says when it changes. `undefined` without it, while
	 * its AI access is off, and without WebMCP. Declared only: the mirror's
	 * chunk defines it on the instance once it hears the extension, so that
	 * the core carries no bytes for it (until then it is `undefined`).
	 */
	declare readonly extension: BrowserExtension | undefined;
	readonly #server: ServerInfo;
	readonly #app: string;
	readonly #appName: string | undefined;
	readonly #onConfirm: ConfirmHandler | undefined;
	readonly #alwaysAllow: TabMcpOptions["alwaysAllow"];
	readonly #ui: DialogOptions | undefined;
	/** `undefined` without a relay: tools only through `serve` and WebMCP. */
	readonly #relayUrl: string | undefined;
	readonly #secrets: SecretStore | undefined;
	/** The channel of the tabs that share the secret (DEC-095). */
	readonly #tabs: string | undefined;
	/**
	 * The page was on when a takeover ended its session (or when a
	 * `disconnectAll()` failed), and nothing was ended since: the next
	 * `disconnectAll()` connects with the new secret. Only that; whether it
	 * takes the old address back does not depend on it (DEC-136).
	 */
	#stayOn = false;
	/** The running `disconnectAll()`: a second call returns it, `connect()` waits for it. */
	#renewing: Promise<void> | undefined;
	readonly #identityAssertion: IdentityAssertionHandler | undefined;
	/** A browser extension's own messages of the protocol (DEC-233). */
	readonly #extra: RelayMessages | undefined;
	#identity: IdentityState = "none";
	#identityMessage: string | undefined;
	/** Incremented per identity request, so a late answer of an older one is dropped. */
	#identityRound = 0;
	#state: ConnectionState = "disconnected";
	#session: SessionInfo | undefined;
	#grants: readonly Grant[] = Object.freeze([]);
	#pairing = false;
	#pairingCode: PairingCode | undefined;
	#pairingUntil: string | undefined;
	/** The last `pairing.start` went to an `oidc` session (DEC-202). */
	#asked = false;
	/** `connect()` from a click while reconnecting: that session asks again. */
	#clicked = false;
	#connection: ConnectionHandle | undefined;
	#connecting: Promise<SessionInfo> | undefined;
	/** Incremented when a connection ends or is cancelled. */
	#generation = 0;
	readonly #reconnect: boolean;
	#reconnecting: ReconnectingInfo | undefined;
	#reconnectTimer: ReturnType<typeof setTimeout> | undefined;
	#unwatch: (() => void) | undefined;
	/** The lazy chunk, once `#load()` loaded it. */
	#lazy: Lazy | undefined;
	/** The open "Connect your AI app" dialog: one at a time. */
	#connectDialog: { doc: Document; shown: Promise<void> } | undefined;
	/**
	 * What a tool call needs, through the relay and WebMCP alike. The events
	 * always, even from a connection that is no longer current: a call that
	 * started must end, and every end has its start.
	 */
	readonly #calls: CallHost = {
		registry: this.#registry,
		confirm: (request) => this.#confirm(request),
		onConfirm: () => this.#onConfirm,
		toolCallStarted: (call) => this.#emit("toolcall", call),
		toolCallEnded: (call) => this.#emit("toolcallend", call),
	};

	constructor(options: TabMcpOptions) {
		super();
		const { server, appName } = options;
		const relay =
			options.relay === undefined ? undefined : tabUrl(options.relay);
		if (
			typeof server?.name !== "string" ||
			typeof server.version !== "string"
		) {
			throw new TypeError("TabMcp: server needs a name and a version");
		}
		if (appName !== undefined && !isAppName(appName)) {
			throw new TypeError(
				"TabMcp: appName must be 1-64 characters without control characters",
			);
		}
		const app = options.app ?? appIdOf(server.name);
		if (
			options.app !== undefined
				? typeof app !== "string" || !APP_ID.test(app)
				: relay && app === ""
		) {
			throw new TypeError(
				options.app !== undefined
					? "TabMcp: app must be 1-32 characters of a-z, 0-9 and -, not starting or ending with -"
					: "TabMcp: server.name has no letter a-z and no digit to make the address of: set app",
			);
		}
		this.#app = app;
		this.#relayUrl = relay?.url;
		this.#server = { ...server };
		this.#appName = appName;
		this.#onConfirm = options.onConfirm;
		this.#alwaysAllow = options.alwaysAllow;
		this.#ui = options.ui;
		this.#identityAssertion = options.identityAssertion;
		this.#extra = options.relayMessages;
		this.#reconnect = options.reconnect !== false;
		if (relay !== undefined) {
			// One address per relay and page (server name, DEC-083).
			const key =
				options.storageKey ??
				`tab-mcp:secret:${relay.origin}:${encodeURIComponent(server.name)}`;
			this.#secrets = new SecretStore(options.storage, key);
			// Tabs that share the secret share this channel; with `storage: null`
			// every tab has a secret of its own (DEC-095).
			this.#tabs = options.storage === null ? undefined : `${key}#tabs`;
		}
		this.#registry.onChange(() =>
			this.#emit("toolchange", { tools: this.tools }),
		);
		// Also through the browser's own WebMCP, where it has it (DEC-115):
		// every tool whose `callers` do not leave "webmcp" out (DEC-209). The getter
		// is read now (WM 10); the mirror loads only then (DEC-171), with the
		// handshake with the tab-mcp browser extension (DEC-207). Without it,
		// read again when `document` hears "tab-mcp-webmcp" (`WEBMCP_EVENT` of
		// `./extension`, spelt out here so the core imports nothing of it): the
		// tab-mcp browser extension installed its own late, at a click on its
		// icon (DEC-223). Only the getter counts then too; the first time it
		// gives an object, the mirror starts and the listener goes.
		if (options.webmcp === false) return;
		const look = (): void => {
			const context = nativeContext();
			if (context === undefined) return;
			globalThis.document?.removeEventListener("tab-mcp-webmcp", look);
			mirrorIn(context);
		};
		globalThis.document?.addEventListener("tab-mcp-webmcp", look);
		const mirrorIn = (context: ModelContext) =>
			import("./webmcp.ts").then(
				(m) =>
					m.mirror(
						this.#registry,
						context,
						(tool, input, signal, by) =>
							this.#load().then((lazy) =>
								lazy.callFromWebMcp(this.#calls, tool, input, signal, by),
							),
						this,
						app,
						options,
						// Passed, not imported there: a chunk shared with the core
						// would cost the core more.
						VERSION,
					),
				// Like a failed registration: warned, the relay unaffected.
				(error: unknown) =>
					console.warn("tab-mcp: no tools are offered through WebMCP:", error),
			);
		look();
	}

	/**
	 * Register a tool, as the WebMCP draft's `registerTool` (DEC-227).
	 * Allowed before and after `connect()`; aborting `options.signal`
	 * unregisters it. Rejects as the draft does: a `TypeError` for what is no
	 * tool (no name, description or `execute`) and for a schema or hint
	 * tab-mcp refuses, an `InvalidStateError` for a taken or invalid name and
	 * an empty description, a `SecurityError` for an `exposedTo` entry that
	 * is no potentially trustworthy origin. The tool is registered, or
	 * refused, before it returns; await it or catch the rejection (DEC-010).
	 */
	registerTool<Input extends object = Record<string, unknown>>(
		tool: ModelContextTool<Input>,
		options: ModelContextRegisterToolOptions = {},
	): Promise<void> {
		try {
			// The arguments are checked against `inputSchema` before `execute` runs.
			this.#registry.register(tool as unknown as ModelContextTool, options);
		} catch (error) {
			return Promise.reject(error);
		}
		return Promise.resolve();
	}

	/** Names of the registered tools. */
	get tools(): readonly string[] {
		return this.#registry.list().map((t) => t.name);
	}

	get state(): ConnectionState {
		return this.#state;
	}

	/** The current session, while connected: its `address` is the one to give to AI apps. */
	get session(): SessionInfo | undefined {
		return this.#session;
	}

	/** The AI apps connected to this address (frozen; a new array when they change). */
	get grants(): readonly Grant[] {
		return this.#grants;
	}

	/**
	 * While `state` is `reconnecting`: the next (or running) attempt and when
	 * it starts. `undefined` otherwise.
	 */
	get reconnecting(): ReconnectingInfo | undefined {
		return this.#reconnecting;
	}

	/** Who the relay knows as the page's user (identity binding). */
	get identity(): IdentityState {
		return this.#identity;
	}

	/** Why the relay refused the identity, while `identity` is `refused`. */
	get identityMessage(): string | undefined {
		return this.#identityMessage;
	}

	/**
	 * Ask the `identityAssertion` hook again and send the result, e.g. after
	 * the user signed in without a page load. Resolves with the outcome, the
	 * new `identity`: `bound` once the relay accepted it, `refused`, or `none`
	 * when nobody is signed in or no answer came in time. Rejects with an
	 * `InvalidStateError` while not connected, and with a `TypeError` without
	 * the hook.
	 */
	refreshIdentity(): Promise<IdentityState> {
		const session = this.#session;
		const ask = this.#identityAssertion;
		if (ask === undefined)
			return Promise.reject(new TypeError("TabMcp: no identityAssertion"));
		if (session === undefined) return notConnected();
		const round = ++this.#identityRound;
		const connection = this.#connection;
		this.#setIdentity("pending");
		// No answer in time, from the hook or the relay (an old relay, a lost
		// message, a hook that never settles): give up.
		const timer = setTimeout(() => {
			if (round !== this.#identityRound || this.#identity !== "pending") return;
			this.#identityRound++; // a late answer is dropped
			this.#setIdentity("none");
		}, timing.answerTimeoutMs);
		return new Promise<IdentityState>((resolve) => {
			const settle = (event: TabMcpEventMap["identitychange"]) => {
				const { identity } = event.detail;
				if (identity === "pending") return;
				this.removeEventListener("identitychange", settle);
				clearTimeout(timer);
				resolve(identity);
			};
			this.addEventListener("identitychange", settle);
			Promise.resolve()
				.then(() =>
					ask({ address: session.address, sessionId: session.sessionId }),
				)
				.then(
					(assertion) => {
						if (
							round !== this.#identityRound ||
							this.#connection !== connection
						) {
							// Superseded (a newer request, a sign-out, a new connection): that one settles the state.
							return;
						}
						if (typeof assertion !== "string" || assertion === "") {
							this.#setIdentity("none");
							return;
						}
						if (
							connection?.send({ type: "identity", assertion, round }) !== true
						)
							this.#setIdentity("none");
					},
					(error: unknown) => {
						if (round !== this.#identityRound) return;
						this.#emit("error", {
							error: error instanceof Error ? error : new Error(String(error)),
						});
						this.#setIdentity("none");
					},
				);
		});
	}

	/**
	 * The page's user signed out: the relay ends every AI connection of this
	 * address at once (identity binding). Call it from the web app's logout.
	 * `identity` goes to `none` at once. Resolves once the relay removed the
	 * grants; rejects with an `InvalidStateError` while not connected to a
	 * relay that pairs by sign-in (`session.pairing` is `oidc`), and with a
	 * `NetworkError` when the session ends first. Grants that stay work only while a page signed in
	 * as the same person is open.
	 */
	signOut(): Promise<void> {
		this.#identityRound++;
		this.#setIdentity("none");
		return this.#session?.pairing === "oidc"
			? this.#ask({ type: "identity.logout" }, () => !this.#grants.length)
			: notConnected();
	}

	/** The pairing code to show, if the relay sent one. */
	get pairingCode(): PairingCode | undefined {
		return this.#pairingCode;
	}

	/**
	 * Identity binding: until when a sign-in pairs this page (ISO time, on
	 * the page's clock: the relay's duration counted from its answer to the
	 * last `startPairing()`, DEC-202). A reconnect the library makes by
	 * itself does not start it anew: it is the time of the reconnect then.
	 * `undefined` while pairing is off, until the relay answers, after the
	 * session ended, and from relays up to 0.12.1, which do not say.
	 */
	get pairingUntil(): string | undefined {
		return this.#pairingUntil;
	}

	/**
	 * Connect to the relay: loads the connection and MCP handler, opens the
	 * WebSocket, resolves with the session. Call it from a user action (a
	 * click): where browsers track user activation it is refused otherwise,
	 * unless `options.resume` says the user already chose to keep AI access on.
	 * While `reconnecting`, it makes the next attempt at once.
	 */
	connect(options: ConnectOptions = {}): Promise<SessionInfo> {
		if (this.#relayUrl === undefined) return noRelay();
		if (this.#state === "connected" && this.#session !== undefined) {
			return Promise.resolve(this.#session);
		}
		if (this.#reconnecting !== undefined) {
			this.#clicked ||= options.resume !== true;
			return this.#attemptReconnect();
		}
		if (this.#connecting !== undefined) return this.#connecting;
		const activation = (
			globalThis.navigator as
				| { userActivation?: { isActive: boolean } }
				| undefined
		)?.userActivation;
		if (
			options.resume !== true &&
			activation !== undefined &&
			!activation.isActive
		) {
			return Promise.reject(
				new DOMException(
					"connect() must be called from a user action, such as a click",
					"NotAllowedError",
				),
			);
		}
		// While `disconnectAll()` runs: afterwards, with the new secret.
		return this.#renewing
			? this.#renewing.then(() => this.connect({ resume: true }))
			: this.#start();
	}

	/** Open the page's connection; a reconnect attempt stays `reconnecting`. */
	#start(): Promise<SessionInfo> {
		if (!this.#reconnecting) this.#setState("connecting");
		const connecting = this.#open(this.#generation);
		this.#connecting = connecting;
		connecting.then(
			() => {
				if (this.#connecting === connecting) this.#connecting = undefined;
			},
			() => {
				if (this.#connecting !== connecting) return; // superseded
				this.#connecting = undefined;
				this.#connection = undefined;
				// A failed attempt: the next one is scheduled, or it stops.
				if (!this.#reconnecting) this.#setState("disconnected");
			},
		);
		return connecting;
	}

	/**
	 * The lazy chunk (on `connect()` or the first WebMCP call). The validator
	 * is loaded with it: it checks the schemas from now on (DEC-086).
	 */
	async #load(): Promise<Lazy> {
		const lazy = await import("./connection.ts");
		for (const error of lazy.compileRegistry(this.#registry))
			this.#emit("error", { error });
		this.#lazy = lazy;
		return lazy;
	}

	/**
	 * Open a connection. `takeBack`: the secret of an address to take back
	 * (`hello.revokeAll`, DEC-095); that connection is never current, so its
	 * session and events stay unseen, but `#end` closes it.
	 */
	async #open(generation: number, takeBack?: string): Promise<SessionInfo> {
		const { openConnection, addressIdOf } = await this.#load();
		const relayUrl = this.#relayUrl;
		if (relayUrl === undefined || this.#secrets === undefined) return noRelay();
		const secret =
			takeBack ?? this.#secrets.current() ?? this.#secrets.rotate();
		const address = await addressIdOf(secret);
		if (generation !== this.#generation) {
			throw new DOMException("The connection was cancelled", "AbortError");
		}
		const ref: { connection?: ConnectionHandle } = {};
		const connection = openConnection(this.#host(ref), relayUrl, secret, {
			address,
			revokeAll: !!takeBack,
			siblingGraceMs: timing.siblingGraceMs,
		});
		if (!takeBack) ref.connection = connection;
		this.#connection = connection;
		return connection.ready;
	}

	/** Whether this `TabMcp` has a relay; without one, `connect()` rejects. */
	get hasRelay(): boolean {
		return this.#relayUrl !== undefined;
	}

	/**
	 * Serve the tools over a port, without a relay: for this site's own
	 * assistant, e.g. a chat in an iframe whose backend calls the tools through
	 * `createTunnelFetch` (`@ractive-ch/tab-mcp-client/tunnel`). The port
	 * carries the relay's `http.*` messages as plain objects; a `MessagePort`
	 * fits. Whoever holds the other end calls the tools without pairing, as
	 * `options.client` (`kind: "local"`): hand it out only to a frame whose
	 * origin you checked. Consequential tools still ask: `options.onConfirm`
	 * for this port's calls (in the site's chat, say), else the page's
	 * `onConfirm` or dialog. Each request may take `options.requestTimeoutMs`
	 * (300 s). Only tools whose `callers` include `"local"` (by default all)
	 * are listed and callable. Resolves once the port
	 * is served; may be called for several ports. Rejects with a `TypeError`
	 * for options it cannot use.
	 */
	serve(port: TunnelPort, options: ServeOptions): Promise<ServeHandle> {
		return this.#load().then((lazy) =>
			lazy.servePort(
				{
					...this.#calls,
					server: this.#server,
					error: (error) => this.#emit("error", { error }),
				},
				port,
				options,
			),
		);
	}

	/** End the session (`bye`). Grants stay: AI apps work again after the next `connect()`. */
	disconnect(): void {
		this.#end("user");
	}

	/**
	 * Disconnect every AI app and start over with a new secret. The address
	 * people add to an AI app names the app and stays the same (DEC-196);
	 * what changes is the page behind it, so every AI app has to pair again.
	 * If the page has a secret already, it first takes it back: it
	 * connects with the old secret and the relay revokes every grant of it in
	 * the same step (`hello.revokeAll`, DEC-095, DEC-136), connected or not,
	 * taken over or not. Then it makes a new secret and connects with it if
	 * the page was connected, connecting or reconnecting, and resolves once
	 * that is done (the new session is `session`). Rejects, and keeps the old
	 * secret so that a retry takes it back again, when the old secret could
	 * not be taken back (relay unreachable, taken over again first). With a
	 * relay, every rejection has `secretChanged`: `false` then, `true` when
	 * only connecting with the new secret failed (without one: a
	 * `TypeError`). Call it from a user action.
	 */
	disconnectAll(): Promise<void> {
		// Without a relay there is no secret store.
		const secrets = this.#secrets;
		if (!secrets) return noRelay();
		// biome-ignore lint/suspicious/noAssignInExpressions: one promise per run
		return (this.#renewing ??= this.#renew(secrets).finally(() => {
			this.#renewing = undefined;
		}));
	}

	async #renew(secrets: SecretStore): Promise<void> {
		const wasOn = this.#state !== "disconnected" || this.#stayOn;
		// Read now, also when the page is off or was taken over (CC 4). Another
		// tab that rotated the secret since took the address it had back itself.
		const old = secrets.current();
		this.#end("disconnect_all");
		const generation = this.#generation;
		if (old) {
			this.#setState("connecting");
			try {
				await this.#open(generation, old);
			} catch (error) {
				if (generation === this.#generation) {
					this.#setState("disconnected");
					this.#stayOn = wasOn; // a retry does the same
				}
				throw changed(error, false);
			} finally {
				// The take-back connection, unless `#end` closed it already.
				if (generation === this.#generation) {
					this.#connection?.close("disconnect_all");
					this.#connection = undefined;
				}
			}
		}
		secrets.rotate();
		// The relay revoked them (CC 14).
		this.#setGrants([]);
		// It was on: the user chose that already, as for a reconnect.
		if (wasOn)
			await this.#start().catch((error: unknown) => {
				throw changed(error, true);
			});
		else this.#setState("disconnected");
	}

	/** Close the connection (or cancel connecting) and report it at once. */
	#end(reason: DisconnectReason): void {
		this.#stopReconnecting();
		this.#stayOn = false;
		this.#generation++;
		const connection = this.#connection;
		this.#connection = undefined;
		this.#connecting = undefined;
		connection?.close(reason); // its callbacks are stale from here on
		if (this.#state === "disconnected") return;
		this.#session = undefined;
		this.#clearPairing();
		this.#identityRound++;
		this.#setIdentity("none");
		// With the reason also when it ended connecting or reconnecting: the
		// page turned it off (or disconnected all apps) all the same.
		this.#setState("disconnected", reason);
	}

	/**
	 * Wait, then connect again (attempt `attempt`, from 1); `state` is
	 * `reconnecting`, and `statechange` says so for each attempt.
	 */
	#scheduleReconnect(reason: DisconnectReason, attempt: number): void {
		const delays = timing.reconnectDelaysMs;
		// Up to 20 % either way, so that the tabs a relay restart disconnected
		// do not all come back at the same moment (CC 11).
		const delay =
			(delays[Math.min(attempt, delays.length) - 1] ?? 0) *
			(0.8 + 0.4 * Math.random());
		clearTimeout(this.#reconnectTimer);
		this.#reconnectTimer = setTimeout(() => {
			this.#attemptReconnect().catch(() => {}); // the next one is scheduled
		}, delay);
		this.#watch();
		this.#reconnecting = { reason, attempt, at: Date.now() + delay };
		this.#setState("reconnecting", attempt > 1 ? undefined : reason);
	}

	/** Make the next reconnect attempt now; on failure, schedule the one after. */
	#attemptReconnect(): Promise<SessionInfo> {
		clearTimeout(this.#reconnectTimer);
		this.#reconnectTimer = undefined;
		if (this.#connecting !== undefined) return this.#connecting;
		const attempt = this.#start();
		attempt.catch((error: unknown) => {
			// Read now, not when the attempt started: a listener before this may
			// have ended it all or started the next attempt, which then owns the
			// next step (CC 10).
			const info = this.#reconnecting;
			if (info === undefined || this.#connecting !== undefined) return;
			// Only what may get better: an unreachable relay (network), a
			// heartbeat or a shutdown; a refusal stops it (DEC-082).
			const reason = (error as { reason?: DisconnectReason } | null)?.reason;
			if (reason === undefined || RECONNECT_REASONS.has(reason)) {
				this.#scheduleReconnect(info.reason, info.attempt + 1);
				return;
			}
			// A refusal stops it, and `error` says why, before `statechange`.
			// The state is `disconnected` already, so that a `connect()` from
			// the listener starts afresh (with the user-activation check).
			this.#stopReconnecting();
			this.#state = "disconnected";
			this.#emit("error", {
				error: error instanceof Error ? error : new Error(String(error)),
			});
			if (this.#state === "disconnected")
				this.#emit("statechange", { state: "disconnected" });
		});
		return attempt;
	}

	/**
	 * Back to the front, or online again: try at once instead of waiting. The
	 * listeners are in the lazy chunk, loaded by the connection that broke
	 * (if loading it failed, the timer still tries).
	 */
	#watch(): void {
		this.#unwatch ??= this.#lazy?.onWake(() => {
			// Only while waiting: an attempt that is running is not doubled.
			if (this.#reconnectTimer !== undefined)
				this.#attemptReconnect().catch(() => {});
		});
	}

	/** Stop reconnecting; the caller sets the state that follows. */
	#stopReconnecting(): void {
		clearTimeout(this.#reconnectTimer);
		this.#reconnectTimer = undefined;
		this.#unwatch?.();
		this.#unwatch = undefined;
		this.#reconnecting = undefined;
	}

	/**
	 * The pairing dialog opened: ask the relay for codes (DEC-028). With
	 * identity binding each call while connected starts the relay's ten
	 * minutes for a sign-in anew (`pairingUntil`, DEC-202): call it only
	 * when the user acts (opens the dialog, continues after the time is up).
	 */
	startPairing(): void {
		this.#pairing = true;
		// Owed to the relay until sent: also a reconnect sends it then.
		this.#asked = false;
		if (this.#state === "connected") this.#askPairing();
	}

	/** Send `pairing.start`; `pairingUntil` waits for the relay's answer. */
	#askPairing(): void {
		this.#setPairingUntil(undefined);
		this.#asked = this.#session?.pairing === "oidc";
		this.#connection?.send({ type: "pairing.start" });
	}

	/** The pairing dialog closed: the code becomes invalid. */
	stopPairing(): void {
		if (!this.#pairing) return;
		this.#pairing = false;
		if (this.#state === "connected")
			this.#connection?.send({ type: "pairing.stop" });
		this.#clearPairing();
	}

	/** No code, no time for a sign-in: pairing is off or the session ended. */
	#clearPairing(): void {
		this.#setPairingCode(undefined);
		this.#setPairingUntil(undefined);
	}

	/**
	 * Disconnect one AI app: its tokens stop working at once. Resolves once
	 * the relay removed the grant (at once for one that is not in `grants`,
	 * and when the relay no longer knows it: it leaves `grants` then).
	 * Rejects with an `InvalidStateError` while not connected (only the relay
	 * can do it), a `NetworkError` when the session ends before the answer,
	 * and with the relay's error when it refuses (its `code` is
	 * `store_unavailable` when it could not save the change: try again).
	 */
	revoke(grantId: string): Promise<void> {
		const gone = () => !this.#grants.some((g) => g.grantId === grantId);
		return gone()
			? Promise.resolve()
			: this.#ask({ type: "grant.revoke", grantId }, gone);
	}

	/**
	 * Send `message` to the relay and resolve once `done()` holds (it is
	 * checked on each change of the grants). Rejects with an
	 * `InvalidStateError` when it cannot send, a `NetworkError` when the
	 * session ends first, the relay's refusal of this message
	 * (`store_unavailable`: it could not save the change; `unknown_id`), and a
	 * `TimeoutError` when none of that happened within
	 * `timing.answerTimeoutMs`.
	 */
	#ask(
		message: TabMessage & { grantId?: string },
		done: () => boolean,
	): Promise<void> {
		// With a session, the lazy chunk is loaded: the waiting is there.
		return !this.#session || this.#connection?.send(message) !== true
			? notConnected()
			: (this.#lazy as Lazy).answer(
					this,
					message,
					done,
					() => this.#state === "connected",
					timing.answerTimeoutMs,
				);
	}

	/**
	 * Open the default "Connect your AI app" dialog; connects first if needed
	 * (call it from a click). Resolves when the dialog closes. One dialog at
	 * a time (they would share one pairing): while it is open, a call for the
	 * same document opens no second one and resolves with it, and a call for
	 * another document rejects with an `InvalidStateError`. Pages with their
	 * own UI use the events and methods instead.
	 */
	showConnectDialog(options: { document?: Document } = {}): Promise<void> {
		if (this.#relayUrl === undefined) return noRelay();
		const doc = options.document ?? globalThis.document;
		const open = this.#connectDialog;
		if (open !== undefined) {
			return open.doc === doc
				? open.shown
				: Promise.reject(
						new DOMException(
							"showConnectDialog: the dialog is already open in another document",
							"InvalidStateError",
						),
					);
		}
		const shown = this.#showConnectDialog(doc).finally(() => {
			if (this.#connectDialog?.shown === shown) this.#connectDialog = undefined;
		});
		this.#connectDialog = { doc, shown };
		return shown;
	}

	async #showConnectDialog(doc: Document): Promise<void> {
		const connecting = this.connect();
		connecting.catch(() => {}); // the dialog shows the error
		const { showConnectDialog } = await import("./connect.ts");
		await showConnectDialog(this, connecting, doc, this.#server.name, this.#ui);
	}

	override addEventListener<K extends keyof TabMcpEventMap>(
		type: K,
		listener: Listener<K> | null,
		options?: boolean | AddEventListenerOptions,
	): void;
	override addEventListener(
		type: string,
		listener: EventListenerOrEventListenerObject | null,
		options?: boolean | AddEventListenerOptions,
	): void;
	override addEventListener(
		type: string,
		listener: EventListenerOrEventListenerObject | null,
		options?: boolean | AddEventListenerOptions,
	): void {
		super.addEventListener(type, listener, options);
	}

	override removeEventListener<K extends keyof TabMcpEventMap>(
		type: K,
		listener: Listener<K> | null,
		options?: boolean | EventListenerOptions,
	): void;
	override removeEventListener(
		type: string,
		listener: EventListenerOrEventListenerObject | null,
		options?: boolean | EventListenerOptions,
	): void;
	override removeEventListener(
		type: string,
		listener: EventListenerOrEventListenerObject | null,
		options?: boolean | EventListenerOptions,
	): void {
		super.removeEventListener(type, listener, options);
	}

	#emit<K extends keyof TabMcpEventMap>(
		type: K,
		detail: TabMcpEventMap[K]["detail"],
	): void {
		this.dispatchEvent(new CustomEvent(type, { detail }));
	}

	/** A new state; `reconnecting` again means the next attempt was scheduled. */
	#setState(state: ConnectionState, reason?: DisconnectReason): void {
		if (this.#state === state && state !== "reconnecting") return;
		this.#state = state;
		this.#emit("statechange", reason ? { state, reason } : { state });
	}

	#setIdentity(identity: IdentityState, message?: string): void {
		if (this.#identity === identity && message === undefined) return;
		this.#identity = identity;
		this.#identityMessage = identity === "refused" ? message : undefined;
		this.#emit("identitychange", {
			identity,
			identityMessage: this.#identityMessage,
		});
	}

	#setPairingCode(pairingCode: PairingCode | undefined): void {
		if (this.#pairingCode === undefined && pairingCode === undefined) return;
		this.#pairingCode = pairingCode;
		this.#emit("pairingcode", { pairingCode });
	}

	#setPairingUntil(pairingUntil: string | undefined): void {
		if (this.#pairingUntil === pairingUntil) return;
		this.#pairingUntil = pairingUntil;
		this.#emit("pairinguntil", { pairingUntil });
	}

	#setGrants(grants: readonly Grant[]): void {
		this.#grants = Object.freeze(grants.map(frozenGrant));
		this.#emit("grantschange", { grants: this.#grants });
	}

	/**
	 * A call the user allowed runs without asking, else `onConfirm` or the
	 * dialog: decided out of the core, in the confirmation's chunk (a chunk
	 * of its own for the allowances would cost the core more bytes, DEC-200).
	 * If that chunk does not load, the page's own `onConfirm` asks (only its
	 * `true` runs the call); without one the call is refused, never allowed.
	 */
	#confirm(request: ConfirmRequest): Promise<ConfirmAnswer> {
		const ask = this.#onConfirm;
		return import("./confirm.ts").then(
			(m) => m.confirmCall(this, request, ask),
			() => ask?.(request) ?? false,
		);
	}

	/**
	 * For `./allowed` and the dialogs, not for pages: the tools, where the
	 * secret is kept, and `alwaysAllow`.
	 * @internal
	 */
	get _allowed(): [
		ToolRegistry,
		SecretStore | undefined,
		TabMcpOptions["alwaysAllow"],
	] {
		return [this.#registry, this.#secrets, this.#alwaysAllow];
	}

	/**
	 * For `./react`, not for pages: the dialogs' options, whose `strings`
	 * `ConnectButton` reads too (one table for every text, given once).
	 * @internal
	 */
	get _ui(): DialogOptions | undefined {
		return this.#ui;
	}

	/**
	 * The library's own confirmation: the dialog in the page with Don't allow
	 * and Allow, and Always allow with `alwaysAllow` (what runs without
	 * `onConfirm`), in `options.document` (default: the global one). An
	 * `onConfirm` may hand some calls to it. A call the user allowed for its
	 * AI app resolves `true` unasked. A WebMCP call resolves `true` unasked
	 * too, without loading the dialog, as without `onConfirm` (DEC-215). Resolves `false` where there is no document.
	 */
	confirmInPage(
		request: ConfirmRequest,
		options: { document?: Document } = {},
	): Promise<boolean> {
		if (request.client.kind === "webmcp") return Promise.resolve(true);
		const doc = options.document ?? globalThis.document;
		if (doc === undefined) return Promise.resolve(false); // nobody to ask: decline
		return import("./confirm.ts").then((ui) =>
			ui.confirmInPage(this, request, doc, { ui: this.#ui }),
		);
	}

	/** The callbacks of one connection; once it is not current they are ignored. */
	#host(ref: { connection?: ConnectionHandle }): ConnectionHost {
		const current = () =>
			ref.connection !== undefined && this.#connection === ref.connection;
		let replacedHere = false;
		return {
			...this.#calls,
			server: this.#server,
			app: this.#app,
			appName: this.#appName,
			tabs: this.#tabs,
			library: { name: LIBRARY_NAME, version: VERSION },
			extra: this.#extra,
			clientFor: (grant: GrantRef): ToolCallClient => {
				const known = this.#grants.find((g) => g.grantId === grant.grantId);
				const client: RelayClient = {
					kind: "relay",
					grantId: grant.grantId,
					id: grant.clientId,
					host: hostOf(grant.clientId),
				};
				if (known !== undefined) client.name = known.client.name;
				return client;
			},
			sessionStarted: (m) => {
				const session = sessionInfo(m);
				if (!current()) return session;
				this.#session = session;
				this.#stayOn = false;
				// A reconnect the library made by itself does not start a
				// sign-in's time anew once the user's start was sent, answered
				// or not: only the user does (DEC-202). Codes come again.
				const ended =
					this.#pairing &&
					this.#reconnecting &&
					!this.#clicked &&
					this.#asked &&
					session.pairing === "oidc";
				this.#clicked = false;
				this.#stopReconnecting();
				this.#setGrants([...m.grants]);
				if (ended) this.#setPairingUntil(new Date().toISOString());
				else if (this.#pairing) this.#askPairing();
				this.#setState("connected");
				if (session.pairing === "oidc" && this.#identityAssertion)
					void this.refreshIdentity();
				return session;
			},
			pairingCode: (code) => {
				if (current() && this.#pairing) this.#setPairingCode(code);
			},
			pairingOpen: (until) => {
				if (current() && this.#pairing) this.#setPairingUntil(until);
			},
			grantAdded: (grant) => {
				if (!current()) return;
				this.#setGrants([
					...this.#grants.filter((g) => g.grantId !== grant.grantId),
					grant,
				]);
			},
			grantRemoved: (grantId) => {
				if (!current()) return;
				this.#setGrants(this.#grants.filter((g) => g.grantId !== grantId));
			},
			// After `closed`, so no longer current: only a connection that was
			// current when it was replaced reports it.
			replaced: (detail) => {
				if (replacedHere) this.#emit("replaced", detail);
			},
			identityResult: (bound, round, message) => {
				if (!current()) return;
				// Only the answer to the newest assertion counts: the relay echoes
				// its round, so a lost or late answer cannot pass for a newer one.
				if (round !== this.#identityRound) return;
				if (bound) this.#setIdentity("bound");
				else this.#setIdentity("refused", message ?? "");
			},
			error: (error) => {
				if (current()) this.#emit("error", { error });
			},
			closed: (reason: DisconnectReason) => {
				if (!current()) return;
				if (reason === "replaced") this.#stayOn = replacedHere = true;
				this.#connection = undefined;
				this.#session = undefined;
				// Any listener of these may end it all (`disconnect()`,
				// `disconnectAll()`): that bumps the generation.
				const generation = this.#generation;
				this.#clearPairing();
				this.#identityRound++;
				this.#setIdentity("none");
				if (generation !== this.#generation) return;
				// Reconnecting is decided before the page hears of it, so its
				// listener sees `reconnecting` (or calls `connect()`, which then
				// makes the first attempt at once).
				if (this.#reconnect && RECONNECT_REASONS.has(reason))
					this.#scheduleReconnect(reason, 1);
				else this.#setState("disconnected", reason);
			},
		};
	}
}
