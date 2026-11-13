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
	PairingCode,
	ReconnectingInfo,
	RegisterToolOptions,
	RelayClient,
	ServeHandle,
	ServeOptions,
	ServerInfo,
	SessionInfo,
	TabMcpEventMap,
	TabMcpOptions,
	Tool,
	ToolCallClient,
	TunnelPort,
} from "./types.ts";
import { LIBRARY_NAME, VERSION } from "./version.ts";
import { mirror, nativeContext } from "./webmcp.ts";

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * The library's waits, in milliseconds: constants for pages (CU 17), which
 * only tests change. `reconnectDelaysMs`: before each reconnect attempt,
 * the last one repeating. `identityTimeoutMs`: for an identity assertion and
 * the relay's answer to it.
 */
export const timing: { reconnectDelaysMs: number[]; identityTimeoutMs: number } = {
	reconnectDelaysMs: [5_000, 10_000, 20_000, 40_000, 60_000],
	identityTimeoutMs: 15_000,
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

/** What `connect()`, `showConnectDialog()` and `newAddress()` reject with without a relay. */
function noRelay(): Promise<never> {
	return Promise.reject(new TypeError("TabMcp: this TabMcp has no relay"));
}

/** What a method that asks the relay rejects with while it cannot. */
function notConnected(): Promise<never> {
	return Promise.reject(
		new DOMException("TabMcp: not connected", "InvalidStateError"),
	);
}

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
	readonly #server: ServerInfo;
	readonly #appName: string | undefined;
	readonly #onConfirm: ConfirmHandler | undefined;
	readonly #alwaysAllow: boolean;
	readonly #ui: DialogOptions | undefined;
	/** `undefined` without a relay: tools only through `serve` and WebMCP. */
	readonly #relayUrl: string | undefined;
	readonly #secrets: SecretStore | undefined;
	/** The channel of the tabs that share the secret (DEC-095). */
	readonly #tabs: string | undefined;
	/**
	 * The page was on when a takeover ended its session (or when a
	 * `newAddress()` failed), and nothing was ended since: the next
	 * `newAddress()` connects with the new address. Only that; whether it
	 * takes the old address back does not depend on it (DEC-136).
	 */
	#stayOn = false;
	/** The running `newAddress()`: a second call returns it, `connect()` waits for it. */
	#renewing: Promise<void> | undefined;
	readonly #identityAssertion: IdentityAssertionHandler | undefined;
	#identity: IdentityState = "none";
	#identityMessage: string | undefined;
	/** Incremented per identity request, so a late answer of an older one is dropped. */
	#identityRound = 0;
	#state: ConnectionState = "disconnected";
	#session: SessionInfo | undefined;
	#grants: readonly Grant[] = Object.freeze([]);
	#pairing = false;
	#pairingCode: PairingCode | undefined;
	#connection: ConnectionHandle | undefined;
	#connecting: Promise<SessionInfo> | undefined;
	/** Incremented when a connection ends or is cancelled. */
	#generation = 0;
	readonly #reconnect: boolean;
	#reconnecting: ReconnectingInfo | undefined;
	#reconnectTimer: ReturnType<typeof setTimeout> | undefined;
	#unwatch: (() => void) | undefined;
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
		this.#relayUrl = relay?.url;
		this.#server = { ...server };
		this.#appName = appName;
		this.#onConfirm = options.onConfirm;
		this.#alwaysAllow = options.alwaysAllow === true;
		this.#ui = options.ui;
		this.#identityAssertion = options.identityAssertion;
		this.#reconnect = options.reconnect !== false;
		if (relay !== undefined) {
			// One address per relay and page (server name); the default of 0.4 and
			// older, per relay only, is moved over once (DEC-083).
			const key =
				options.storageKey ??
				`tab-mcp:secret:${relay.origin}:${encodeURIComponent(server.name)}`;
			this.#secrets = new SecretStore(
				options.storage,
				key,
				options.storageKey === undefined
					? `tab-mcp:secret:${relay.origin}`
					: undefined,
			);
			// Tabs that share the secret share this channel; with `storage: null`
			// every tab has an address of its own (DEC-095).
			this.#tabs = options.storage === null ? undefined : `${key}#tabs`;
		}
		this.#registry.onChange(() =>
			this.#emit("toolschange", { tools: this.tools }),
		);
		// Also through the browser's own WebMCP, where it has it (DEC-115):
		// consequential tools only when their registration says so.
		const context = options.webmcp === true ? nativeContext() : undefined;
		if (context !== undefined)
			mirror(this.#registry, context, (tool, input, signal) =>
				this.#load().then((lazy) =>
					lazy.callFromWebMcp(this.#calls, tool, input, signal),
				),
			);
	}

	/**
	 * Register a tool (WebMCP shape). Allowed before and after `connect()`;
	 * aborting `options.signal` unregisters it. Rejects with a `TypeError` for
	 * an invalid tool and an `InvalidStateError` for a duplicate name (the
	 * tool is registered, or refused, before it returns); await it or catch
	 * the rejection (DEC-010).
	 */
	registerTool<Input extends object = Record<string, unknown>>(
		tool: Tool<Input>,
		options: RegisterToolOptions = {},
	): Promise<void> {
		try {
			// The arguments are checked against `inputSchema` before `execute` runs.
			this.#registry.register(tool as unknown as Tool, options);
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
	 * `InvalidStateError` while not connected or without the hook.
	 */
	refreshIdentity(): Promise<IdentityState> {
		const session = this.#session;
		const ask = this.#identityAssertion;
		if (session === undefined || ask === undefined) return notConnected();
		const round = ++this.#identityRound;
		const connection = this.#connection;
		this.#setIdentity("pending");
		// No answer in time, from the hook or the relay (an old relay, a lost
		// message, a hook that never settles): give up.
		const timer = setTimeout(() => {
			if (round !== this.#identityRound || this.#identity !== "pending") return;
			this.#identityRound++; // a late answer is dropped
			this.#setIdentity("none");
		}, timing.identityTimeoutMs);
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
	 * relay that pairs by sign-in (`session.pairing` is `oidc`), and when the
	 * session ends first. Grants that stay work only while a page signed in
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
		if (this.#connecting !== undefined) return this.#connecting;
		if (this.#reconnecting !== undefined) return this.#attemptReconnect();
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
		// While `newAddress()` runs: afterwards, with the new address.
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
	async #load(): Promise<typeof import("./connection.ts")> {
		const lazy = await import("./connection.ts");
		for (const error of lazy.compileRegistry(this.#registry))
			this.#emit("error", { error });
		return lazy;
	}

	/**
	 * Open a connection. `takeBack`: the secret of an address to take back
	 * (`hello.revokeAll`, DEC-095); that connection is never current, so its
	 * session and events stay unseen, but `#end` closes it.
	 */
	async #open(generation: number, takeBack?: string): Promise<SessionInfo> {
		const { openConnection, addressIdOf, withAddress } = await this.#load();
		const relayUrl = this.#relayUrl;
		if (relayUrl === undefined || this.#secrets === undefined) return noRelay();
		const secret =
			takeBack ?? this.#secrets.current() ?? this.#secrets.rotate();
		const address = await addressIdOf(secret);
		if (generation !== this.#generation) {
			throw new DOMException("The connection was cancelled", "AbortError");
		}
		const ref: { connection?: ConnectionHandle } = {};
		const connection = openConnection(
			this.#host(ref),
			withAddress(relayUrl, address),
			secret,
			{ address, revokeAll: !!takeBack },
		);
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
	 * origin you checked. Consequential tools still ask. Resolves once the port
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
	 * A new address. If the page has one already, it first takes it back: it
	 * connects with the old secret and the relay revokes every grant of it in
	 * the same step (`hello.revokeAll`, DEC-095, DEC-136), connected or not,
	 * taken over or not. Then it makes a new secret and connects with it if
	 * the page was connected, connecting or reconnecting, and resolves once
	 * that is done (the new session is `session`). Rejects, and keeps the old
	 * secret so that a retry takes it back again, when the old address could
	 * not be taken back (relay unreachable, taken over again first). Call it
	 * from a user action.
	 */
	newAddress(): Promise<void> {
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
		this.#end("new_address");
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
				throw error;
			} finally {
				// The take-back connection, unless `#end` closed it already.
				if (generation === this.#generation) {
					this.#connection?.close("new_address");
					this.#connection = undefined;
				}
			}
		}
		secrets.rotate();
		// The relay revoked them (CC 14).
		this.#setGrants([]);
		// It was on: the user chose that already, as for a reconnect.
		if (wasOn) await this.#start();
		else this.#setState("disconnected");
	}

	/** Close the connection (or cancel connecting) and report it at once. */
	#end(reason: DisconnectReason): void {
		this.#stopReconnecting();
		this.#stayOn = false;
		this.#generation++;
		const connection = this.#connection;
		const wasConnected = this.#state === "connected";
		this.#connection = undefined;
		this.#connecting = undefined;
		connection?.close(reason); // its callbacks are stale from here on
		if (this.#state === "disconnected") return;
		this.#session = undefined;
		this.#setPairingCode(undefined);
		this.#identityRound++;
		this.#setIdentity("none");
		this.#setState("disconnected", wasConnected ? reason : undefined);
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

	/** Back to the front, or online again: try at once instead of waiting. */
	#watch(): void {
		if (this.#unwatch !== undefined) return;
		const g = globalThis as Partial<EventTarget>;
		const doc = (globalThis as { document?: Document }).document;
		const now = () => {
			// Only while waiting: an attempt that is running is not doubled.
			if (this.#reconnectTimer !== undefined)
				this.#attemptReconnect().catch(() => {});
		};
		const visible = () => {
			if (doc?.visibilityState !== "hidden") now();
		};
		doc?.addEventListener("visibilitychange", visible);
		g.addEventListener?.("online", now);
		this.#unwatch = () => {
			doc?.removeEventListener("visibilitychange", visible);
			g.removeEventListener?.("online", now);
		};
	}

	/** Stop reconnecting; the caller sets the state that follows. */
	#stopReconnecting(): void {
		clearTimeout(this.#reconnectTimer);
		this.#reconnectTimer = undefined;
		this.#unwatch?.();
		this.#unwatch = undefined;
		this.#reconnecting = undefined;
	}

	/** The pairing dialog opened: ask the relay for codes (DEC-028). */
	startPairing(): void {
		if (this.#pairing) return;
		this.#pairing = true;
		if (this.#state === "connected")
			this.#connection?.send({ type: "pairing.start" });
	}

	/** The pairing dialog closed: the code becomes invalid. */
	stopPairing(): void {
		if (!this.#pairing) return;
		this.#pairing = false;
		if (this.#state === "connected")
			this.#connection?.send({ type: "pairing.stop" });
		this.#setPairingCode(undefined);
	}

	/**
	 * Disconnect one AI app: its tokens stop working at once. Resolves once
	 * the relay removed the grant (at once for one that is not in `grants`).
	 * Rejects with an `InvalidStateError` while not connected (only the relay
	 * can do it) and when the session ends first, and with the relay's error
	 * when it refuses (its `code` is `store_unavailable` when it could not
	 * save the change: try again; `unknown_id` for a grant it does not know).
	 */
	revoke(grantId: string): Promise<void> {
		const gone = () => !this.#grants.some((g) => g.grantId === grantId);
		return gone()
			? Promise.resolve()
			: this.#ask({ type: "grant.revoke", grantId }, gone);
	}

	/**
	 * Send `message` to the relay and resolve once `done()` holds (it is
	 * checked on each change of the grants). Rejects when not connected, when
	 * the session ends first, and with the relay's error when it sends one
	 * meanwhile (`store_unavailable`: it could not save the change).
	 */
	#ask(message: TabMessage, done: () => boolean): Promise<void> {
		if (!this.#session || this.#connection?.send(message) !== true)
			return notConnected();
		return new Promise((resolve, reject) => {
			const check = (event?: Event) => {
				const error = (event as Partial<TabMcpEventMap["error"]>)?.detail
					?.error as { code?: string } | undefined;
				if (done()) resolve();
				else if (error?.code) reject(error);
				else if (this.#state !== "connected") notConnected().catch(reject);
				else return;
				for (const type of ["grantschange", "statechange", "error"])
					this.removeEventListener(type, check);
			};
			for (const type of ["grantschange", "statechange", "error"])
				this.addEventListener(type, check);
			check();
		});
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

	#setGrants(grants: readonly Grant[]): void {
		this.#grants = Object.freeze(grants.map(frozenGrant));
		this.#emit("grantschange", { grants: this.#grants });
	}

	#confirm(request: ConfirmRequest): Promise<ConfirmAnswer> {
		if (this.#onConfirm !== undefined) {
			const ask = this.#onConfirm;
			// Anything but true or "unanswered" is a refusal.
			return Promise.resolve()
				.then(() => ask(request))
				.then((answer) => (answer === "unanswered" ? answer : answer === true));
		}
		return this.confirmInPage(request);
	}

	/**
	 * The library's own confirmation: the dialog in the page with Don't allow
	 * and Allow, and Allow until reload with `alwaysAllow: true` (what runs
	 * without `onConfirm`), in `options.document` (default: the global one).
	 * An `onConfirm` may hand some calls to it. Resolves `false` where there
	 * is no document.
	 */
	confirmInPage(
		request: ConfirmRequest,
		options: { document?: Document } = {},
	): Promise<boolean> {
		const doc = options.document ?? globalThis.document;
		if (doc === undefined) return Promise.resolve(false); // nobody to ask: decline
		// The tools allowed until reload live in the dialogs' chunks too: only they add them.
		return import("./confirm.ts").then((ui) =>
			ui.confirmInPage(this, request, doc, {
				alwaysAllow: this.#alwaysAllow,
				ui: this.#ui,
			}),
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
			appName: this.#appName,
			tabs: this.#tabs,
			library: { name: LIBRARY_NAME, version: VERSION },
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
				this.#stopReconnecting();
				this.#setGrants([...m.grants]);
				if (this.#pairing) this.#connection?.send({ type: "pairing.start" });
				this.#setState("connected");
				if (session.pairing === "oidc" && this.#identityAssertion)
					void this.refreshIdentity();
				return session;
			},
			pairingCode: (code) => {
				if (current() && this.#pairing) this.#setPairingCode(code);
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
				// `newAddress()`): that bumps the generation.
				const generation = this.#generation;
				this.#setPairingCode(undefined);
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
