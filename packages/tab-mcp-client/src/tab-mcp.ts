/**
 * `TabMcp`: the eagerly loaded core (DEC-035). It holds the tool registry, the
 * events, the pairing state and the address secret; `connect()` loads the
 * connection and the MCP handler with a dynamic `import()`.
 */

import type { ConnectionHandle, ConnectionHost } from "./internal.ts";
import type { GrantRef, SessionMessage } from "./protocol.ts";
import { ToolRegistry } from "./registry.ts";
import { SecretStore } from "./secret.ts";
import type {
	ConfirmHandler,
	ConfirmRequest,
	ConnectionState,
	ConnectOptions,
	DisconnectReason,
	Grant,
	IdentityAssertionHandler,
	IdentityState,
	PairingCode,
	ReconnectingInfo,
	RegisterToolOptions,
	ServerInfo,
	SessionInfo,
	TabMcpEventMap,
	TabMcpOptions,
	Tool,
	ToolCallClient,
} from "./types.ts";
import { LIBRARY_NAME, VERSION } from "./version.ts";

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** The default waits before each reconnect attempt; the last one repeats. */
const RECONNECT_DELAYS_MS = [5_000, 10_000, 20_000, 40_000, 60_000];
/** Reasons after which the library connects again by itself. */
const RECONNECT_REASONS = new Set<DisconnectReason>([
	"network",
	"heartbeat",
	"shutdown",
]);

function reconnectDelays(
	option: TabMcpOptions["reconnect"],
): readonly number[] | undefined {
	if (option === false) return undefined;
	if (option === undefined || option === true) return RECONNECT_DELAYS_MS;
	const delays = option.delaysMs ?? RECONNECT_DELAYS_MS;
	if (
		!Array.isArray(delays) ||
		delays.length === 0 ||
		!delays.every((d) => typeof d === "number" && d >= 0 && d < 2 ** 31)
	) {
		throw new TypeError("TabMcp: reconnect.delaysMs: a non-empty list of ms");
	}
	return [...delays];
}

/** A delay option: `undefined`, or a whole wait `setTimeout` can keep (below 2^31 ms). */
function delayOption(name: string, value: unknown): number | undefined {
	if (value === undefined) return undefined;
	if (
		typeof value !== "number" ||
		!Number.isFinite(value) ||
		value < 0 ||
		value >= 2 ** 31
	) {
		throw new TypeError(`TabMcp: ${name} must be a number of milliseconds`);
	}
	return value;
}

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

type Listener<K extends keyof TabMcpEventMap> = (
	event: TabMcpEventMap[K],
) => void;

/**
 * Offers a page's tools to AI apps through a tab-mcp relay.
 *
 * ```ts
 * const mcp = new TabMcp({ relay: "https://relay.example", server: { name: "Calculator", version: "1.0.0" } });
 * mcp.registerTool({ name: "add", description: "Add two numbers", execute: ({ a, b }) => Number(a) + Number(b) });
 * button.onclick = () => mcp.showConnectDialog();
 * ```
 */
export class TabMcp extends EventTarget {
	readonly #registry = new ToolRegistry();
	readonly #server: ServerInfo;
	readonly #appName: string | undefined;
	readonly #onConfirm: ConfirmHandler | undefined;
	readonly #confirmDelayMs: number | undefined;
	readonly #alwaysAllow: boolean;
	readonly #relayUrl: string;
	readonly #secrets: SecretStore;
	/** The channel of the tabs that share the secret (DEC-095). */
	readonly #tabs: string | undefined;
	/** Replaced since the last session: `newAddress()` takes the address back first. */
	#takenOver = false;
	readonly #identityAssertion: IdentityAssertionHandler | undefined;
	#identity: IdentityState = "none";
	#identityMessage: string | undefined;
	/** Incremented per identity request, so a late answer of an older one is dropped. */
	#identityRound = 0;
	readonly #identityTimeoutMs: number;
	#state: ConnectionState = "disconnected";
	#session: SessionInfo | undefined;
	#grants: readonly Grant[] = Object.freeze([]);
	#pairing = false;
	#pairingCode: PairingCode | undefined;
	#connection: ConnectionHandle | undefined;
	#connecting: Promise<SessionInfo> | undefined;
	/** Incremented when a connection ends or is cancelled. */
	#generation = 0;
	/** Waits between reconnect attempts; `undefined`: reconnecting is off. */
	readonly #reconnectDelays: readonly number[] | undefined;
	#reconnecting: ReconnectingInfo | undefined;
	#reconnectTimer: ReturnType<typeof setTimeout> | undefined;
	#unwatch: (() => void) | undefined;
	/** The page's `connect()` waits on the running reconnect attempt: its promise tells it. */
	#pageWaits = false;
	/** The open "Connect your AI app" dialog: one at a time. */
	#connectDialog: { doc: Document; shown: Promise<void> } | undefined;

	constructor(options: TabMcpOptions) {
		super();
		const { url, origin } = tabUrl(options.relay);
		const { server, appName } = options;
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
		this.#relayUrl = url;
		this.#server = { ...server };
		this.#appName = appName;
		this.#onConfirm = options.onConfirm;
		this.#confirmDelayMs = delayOption(
			"confirmDelayMs",
			options.confirmDelayMs,
		);
		this.#alwaysAllow = options.alwaysAllow === true;
		this.#identityAssertion = options.identityAssertion;
		this.#identityTimeoutMs =
			delayOption("identityTimeoutMs", options.identityTimeoutMs) ?? 15_000;
		this.#reconnectDelays = reconnectDelays(options.reconnect);
		// One address per relay and page (server name); the default of 0.4 and
		// older, per relay only, is moved over once (DEC-083).
		const key =
			options.storageKey ??
			`tab-mcp:secret:${origin}:${encodeURIComponent(server.name)}`;
		this.#secrets = new SecretStore(
			options.storage,
			key,
			options.storageKey === undefined ? `tab-mcp:secret:${origin}` : undefined,
		);
		// Tabs that share the secret share this channel; with `storage: null`
		// every tab has an address of its own (DEC-095).
		this.#tabs = options.storage === null ? undefined : `${key}#tabs`;
		this.#registry.onChange(() =>
			this.#emit("toolschange", { tools: this.tools }),
		);
	}

	/**
	 * Register a tool (WebMCP shape). Allowed before and after `connect()`;
	 * aborting `options.signal` unregisters it. Rejects with a `TypeError` for
	 * an invalid tool and an `InvalidStateError` for a duplicate name.
	 */
	registerTool<Input = Record<string, unknown>>(
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

	/** The current session, while connected. */
	get session(): SessionInfo | undefined {
		return this.#session;
	}

	/** The MCP address to give to AI apps, while connected. */
	get address(): string | undefined {
		return this.#session?.address;
	}

	/** The app name AI apps see when pairing: the relay's (`session.appName`), else the page's own. */
	get appName(): string | undefined {
		return this.#session?.appName ?? this.#appName;
	}

	/** The AI apps connected to this address (frozen; a new array when they change). */
	get grants(): readonly Grant[] {
		return this.#grants;
	}

	/**
	 * While the library connects again by itself after the connection broke:
	 * the next attempt and when it starts. `undefined` otherwise.
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
	 * the user signed in without a page load. Resolves `true` once the relay
	 * accepted it; `false` when nobody is signed in, it was refused, or the
	 * page is not connected.
	 */
	refreshIdentity(): Promise<boolean> {
		const session = this.#session;
		const ask = this.#identityAssertion;
		if (
			this.#state !== "connected" ||
			session === undefined ||
			ask === undefined
		) {
			return Promise.resolve(false);
		}
		const round = ++this.#identityRound;
		const connection = this.#connection;
		this.#setIdentity("pending");
		// No answer in time, from the hook or the relay (an old relay, a lost
		// message, a hook that never settles): give up.
		const timer = setTimeout(() => {
			if (round !== this.#identityRound || this.#identity !== "pending") return;
			this.#identityRound++; // a late answer is dropped
			this.#setIdentity("none");
		}, this.#identityTimeoutMs);
		return new Promise<boolean>((resolve) => {
			const settle = (event: TabMcpEventMap["identitychange"]) => {
				if (event.detail.state === "pending") return;
				this.removeEventListener("identitychange", settle);
				clearTimeout(timer);
				resolve(event.detail.state === "bound");
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
	 * Returns `false` when it could not be sent (not connected); the grants
	 * then stay, but work only while a page signed in as the same person is
	 * open.
	 */
	signOut(): boolean {
		this.#identityRound++;
		this.#setIdentity("none");
		if (this.#state !== "connected") return false;
		return this.#connection?.send({ type: "identity.logout" }) === true;
	}

	/** Whether pairing is on (`startPairing()`). */
	get pairing(): boolean {
		return this.#pairing;
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
	 * While reconnecting (`reconnecting`), it makes the next attempt at once.
	 */
	connect(options: ConnectOptions = {}): Promise<SessionInfo> {
		if (this.#state === "connected" && this.#session !== undefined) {
			return Promise.resolve(this.#session);
		}
		if (this.#connecting !== undefined) {
			if (this.#reconnecting !== undefined) this.#pageWaits = true;
			return this.#connecting;
		}
		if (this.#reconnecting !== undefined) return this.#attemptReconnect(true);
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
		return this.#start();
	}

	#start(revokeAll?: boolean): Promise<SessionInfo> {
		this.#setState("connecting");
		const connecting = this.#open(this.#generation, revokeAll);
		this.#connecting = connecting;
		connecting.then(
			() => {
				if (this.#connecting === connecting) this.#connecting = undefined;
			},
			() => {
				if (this.#connecting !== connecting) return; // superseded
				this.#connecting = undefined;
				this.#connection = undefined;
				this.#setState("disconnected");
			},
		);
		return connecting;
	}

	async #open(generation: number, revokeAll?: boolean): Promise<SessionInfo> {
		const { openConnection, compileRegistry, addressIdOf, withAddress } =
			await import("./connection.ts");
		// The validator is loaded: it checks the schemas from now on (DEC-086).
		for (const error of compileRegistry(this.#registry))
			this.#emit("error", { error });
		const secret = this.#secrets.get();
		const address = await addressIdOf(secret);
		if (generation !== this.#generation) {
			throw new DOMException("The connection was cancelled", "AbortError");
		}
		const ref: { connection?: ConnectionHandle } = {};
		const connection = openConnection(
			this.#host(ref),
			withAddress(this.#relayUrl, address),
			secret,
			revokeAll,
		);
		ref.connection = connection;
		this.#connection = connection;
		return connection.ready;
	}

	/** End the session (`bye`). Grants stay: AI apps work again after the next `connect()`. */
	disconnect(): void {
		this.#end("user");
	}

	/**
	 * A new address: revokes every connected app of the old one (while
	 * connected), makes a new secret, and connects again if it was connected or
	 * connecting. After `replaced`, it first connects with the old address
	 * again, so that the relay disconnects the apps that now talk to whoever
	 * took it over (DEC-095), then connects with the new one. Call it from a
	 * user action.
	 */
	newAddress(): Promise<SessionInfo | undefined> {
		if (this.#takenOver) {
			// `hello.revokeAll`: the relay revokes as it hands the address back, and
			// the connection resolves only once no grant is left. Taken over again
			// first: reject, keep the secret, so that a retry takes it back again.
			this.#end("new_address");
			return this.#start(true).then(
				() => this.#renew(true),
				(error: unknown) => {
					this.#takenOver = true;
					throw error;
				},
			);
		}
		return this.#renew(false);
	}

	#renew(on: boolean): Promise<SessionInfo | undefined> {
		const wasOn =
			on || this.#state !== "disconnected" || this.#reconnecting !== undefined;
		if (this.#state === "connected")
			this.#connection?.send({ type: "grants.revokeAll" });
		this.#end("new_address");
		this.#secrets.rotate();
		this.#takenOver = false; // nobody else has the new secret
		// It was on: the user chose that already, as for a reconnect.
		return wasOn ? this.connect({ resume: true }) : Promise.resolve(undefined);
	}

	/** Close the connection (or cancel connecting) and report it at once. */
	#end(reason: DisconnectReason): void {
		this.#stopReconnecting();
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
		this.#setState("disconnected");
		if (wasConnected) this.#emit("disconnected", { reason, code: 1000 });
	}

	/** Wait, then connect again (attempt `attempt`, from 1). */
	#scheduleReconnect(reason: DisconnectReason, attempt: number): void {
		const delays = this.#reconnectDelays;
		if (delays === undefined) return;
		const delay = delays[Math.min(attempt, delays.length) - 1] ?? 0;
		clearTimeout(this.#reconnectTimer);
		this.#reconnectTimer = setTimeout(() => {
			this.#attemptReconnect().catch(() => {}); // the next one is scheduled
		}, delay);
		this.#watch();
		this.#reconnecting = { reason, attempt, at: Date.now() + delay };
		this.#emit("reconnecting", this.#reconnecting);
	}

	/**
	 * Make the next reconnect attempt now; on failure, schedule the one after.
	 * `byPage`: from `connect()`, whose promise tells the page why it failed.
	 */
	#attemptReconnect(byPage = false): Promise<SessionInfo> {
		clearTimeout(this.#reconnectTimer);
		this.#reconnectTimer = undefined;
		if (this.#connecting !== undefined) return this.#connecting;
		const info = this.#reconnecting;
		this.#pageWaits = byPage;
		const attempt = this.#start();
		attempt.catch((error: unknown) => {
			const pageWaits = this.#pageWaits;
			this.#pageWaits = false;
			if (info === undefined || this.#reconnecting !== info) return;
			// Only what may get better: an unreachable relay (network), a
			// heartbeat or a shutdown; a refusal stops it (DEC-082).
			const reason = (error as { reason?: DisconnectReason } | null)?.reason;
			if (reason === undefined || RECONNECT_REASONS.has(reason)) {
				this.#scheduleReconnect(info.reason, info.attempt + 1);
				return;
			}
			// A refusal stops it. Without a connect() of the page's waiting on this
			// attempt, nothing else tells the page why: `error` does, before `null`.
			this.#stopReconnecting(
				pageWaits
					? undefined
					: error instanceof Error
						? error
						: new Error(String(error)),
			);
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

	/**
	 * Stop reconnecting. `why` (a refusal) goes out as `error` before the
	 * `null`, once the state is clear: a listener that calls `connect()` then
	 * starts afresh, with the user-activation check.
	 */
	#stopReconnecting(why?: Error): void {
		clearTimeout(this.#reconnectTimer);
		this.#reconnectTimer = undefined;
		this.#unwatch?.();
		this.#unwatch = undefined;
		if (this.#reconnecting === undefined) return;
		this.#reconnecting = undefined;
		if (why !== undefined) this.#emit("error", { error: why });
		this.#emit("reconnecting", null);
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
	 * Disconnect one AI app: its tokens stop working at once. Works only while
	 * connected (the relay does it); returns `false` when it could not be sent.
	 */
	revoke(grantId: string): boolean {
		if (this.#state !== "connected") return false;
		return this.#connection?.send({ type: "grant.revoke", grantId }) === true;
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
		const { showConnectDialog } = await import("./ui.ts");
		await showConnectDialog(this, connecting, doc, this.#server.name);
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

	#setState(state: ConnectionState): void {
		if (this.#state === state) return;
		this.#state = state;
		this.#emit("statechange", { state });
	}

	#setIdentity(state: IdentityState, message?: string): void {
		if (this.#identity === state && message === undefined) return;
		this.#identity = state;
		this.#identityMessage = state === "refused" ? message : undefined;
		this.#emit(
			"identitychange",
			message === undefined ? { state } : { state, message },
		);
	}

	#setPairingCode(code: PairingCode | undefined): void {
		if (this.#pairingCode === undefined && code === undefined) return;
		this.#pairingCode = code;
		this.#emit("pairingcode", code ?? null);
	}

	#setGrants(grants: readonly Grant[]): void {
		this.#grants = Object.freeze(grants.map(frozenGrant));
		this.#emit("grantschange", { grants: this.#grants });
	}

	#confirm(request: ConfirmRequest): Promise<boolean> {
		if (this.#onConfirm !== undefined) {
			const ask = this.#onConfirm;
			return Promise.resolve()
				.then(() => ask(request))
				.then((allowed) => allowed === true);
		}
		return this.confirmInPage(request);
	}

	/**
	 * The library's own confirmation: the dialog in the page with Don't allow
	 * and Allow, and Always allow with `alwaysAllow: true` (what runs without
	 * `onConfirm`). An `onConfirm`
	 * may hand some calls to it. Resolves `false` where there is no document.
	 */
	confirmInPage(request: ConfirmRequest): Promise<boolean> {
		const doc = globalThis.document as Document | undefined;
		if (doc === undefined) return Promise.resolve(false); // nobody to ask: decline
		// The tools allowed always live in the UI chunk too: only it adds them.
		return import("./ui.ts").then((ui) =>
			ui.confirmInPage(this, request, doc, {
				allowDelayMs: this.#confirmDelayMs,
				alwaysAllow: this.#alwaysAllow,
			}),
		);
	}

	/** The callbacks of one connection; once it is not current they are ignored. */
	#host(ref: { connection?: ConnectionHandle }): ConnectionHost {
		const current = () =>
			ref.connection !== undefined && this.#connection === ref.connection;
		let replacedHere = false;
		return {
			registry: this.#registry,
			server: this.#server,
			appName: this.#appName,
			tabs: this.#tabs,
			library: { name: LIBRARY_NAME, version: VERSION },
			confirm: (request) => this.#confirm(request),
			// Both always, even from a connection that is no longer current: a
			// call that started must end, and every end has its start.
			toolCallStarted: (call) => this.#emit("toolcall", call),
			toolCallEnded: (call) => this.#emit("toolcallend", call),
			clientFor: (grant: GrantRef): ToolCallClient => {
				const known = this.#grants.find((g) => g.grantId === grant.grantId);
				const client: ToolCallClient = {
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
				this.#takenOver = false;
				this.#stopReconnecting();
				this.#setState("connected");
				this.#setGrants([...m.grants]);
				if (this.#pairing) this.#connection?.send({ type: "pairing.start" });
				this.#emit("connected", session);
				if (session.pairing === "oidc") void this.refreshIdentity();
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
			closed: (reason: DisconnectReason, code: number) => {
				if (!current()) return;
				// Taken over: `newAddress()` takes it back first, whatever runs by
				// then (review of PR 39).
				if (reason === "replaced") this.#takenOver = replacedHere = true;
				// Any listener below may end it all (`disconnect()`, `newAddress()`):
				// that bumps the generation, and then nothing is scheduled.
				const generation = this.#generation;
				this.#connection = undefined;
				this.#session = undefined;
				this.#setPairingCode(undefined);
				this.#identityRound++;
				this.#setIdentity("none");
				this.#setState("disconnected");
				this.#emit("disconnected", { reason, code });
				// After the page heard of it: its listener may have connected or ended it.
				if (
					RECONNECT_REASONS.has(reason) &&
					this.#generation === generation &&
					this.#state === "disconnected" &&
					this.#connecting === undefined
				)
					this.#scheduleReconnect(reason, 1);
			},
		};
	}
}
