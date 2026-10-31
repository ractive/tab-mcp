import type { Server, ServerWebSocket } from "bun";
import { version } from "../package.json" with { type: "json" };
import { addressIdFromSecret, isAddressId, shortAddress } from "./address.ts";
import {
	largestMessageBytes,
	MIN_MESSAGE_BYTES,
	type RelayConfig,
	resolveConfig,
	type Site,
	type StoreKind,
	siteFor,
} from "./config.ts";
import {
	type Exchange,
	RelayErrorCode,
	type RpcId,
	rpcErrorBody,
} from "./exchange.ts";
import { APPLE_TOUCH_ICON, FAVICON_ICO, FAVICON_SVG } from "./icons.ts";
import { MISMATCH_TEXT, TabAssertionVerifier } from "./identity.ts";
import { ipPrefixKey } from "./ip.ts";
import { JwtError, type KeySource } from "./jwt.ts";
import { createLogger, errorName, type Logger, truncateIp } from "./log.ts";
import {
	isRetryable,
	type NotOpenPhase,
	notOpenAnswer,
	type RelayInfo,
} from "./notopen.ts";
import {
	AuthorizationServer,
	type AuthorizationTestMode,
} from "./oauth/server.ts";
import {
	CloseCode,
	type GrantInfo,
	MCP_PROTOCOL_VERSION,
	PROTOCOL_VERSION_META_KEY,
	type RelayMessage,
	SUBPROTOCOL,
} from "./protocol.ts";
import { TabSession } from "./session.ts";
import { MemoryTokenStore } from "./store/memory.ts";
import { SqliteTokenStore } from "./store/sqlite.ts";
import type { TokenRecord, TokenStore } from "./store/types.ts";
import { hashToken } from "./tokens.ts";

export const VERSION: string = version;

const RELAY_INFO: RelayInfo = { name: "tab-mcp", version };

/** Settles the race between an exchange and its page going away. */
const RETRY = Symbol("retry");

/** The one mismatched header Claude sends today (claude-code #93290, DEC-033). */
const CLAUDE_MISMATCHED_HEADER = "2025-11-25";

/**
 * Listen streams one grant may hold on a page at once: they have no request
 * timer, so without a cap one AI app could take every concurrency slot.
 */
const MAX_LISTEN_STREAMS_PER_GRANT = 2;

/**
 * Bun closes a WebSocket whose frame is over `maxPayloadLength` (1009). Frames
 * up to this many times the largest site limit get a `too_large` error instead
 * and the session stays; they are refused by length, before parsing.
 */
const FRAME_HEADROOM = 4;

/**
 * Refusals of a tab assertion that say nothing about the user: the relay could
 * not check (signing keys or store unavailable, an unexpected error).
 */
const TRANSIENT_REFUSALS = new Set([
	"jwks_unavailable",
	"store_unavailable",
	"relay_busy",
	"error",
]);

/** The text for requests that cannot be checked against the page's user. */
const UNCHECKED_TEXT =
	"The relay cannot check the page's user right now. Try again shortly.";

/** `Retry-After` (seconds) for answers that ask an AI app to try again soon. */
const RETRY_AFTER_S = "5";

/** Request headers forwarded to the tab (protocol: tunnelled MCP requests). */
const FORWARDED_HEADERS = new Set([
	"content-type",
	"accept",
	"mcp-method",
	"mcp-name",
	"traceparent",
	"tracestate",
]);

export interface CreateRelayOptions
	extends Omit<Partial<RelayConfig>, "store"> {
	/**
	 * The token store: a `TokenStore` instance (e.g. Prisma, Redis), or the name
	 * of a built-in one (`"sqlite"`, the default, at `sqlitePath`; `"memory"`).
	 */
	store?: StoreKind | TokenStore;
	/** Logger; defaults to JSON lines on stdout at `logLevel`. */
	logger?: Logger;
}

/**
 * The public URL in development without `publicUrl`: the loopback address the
 * relay listens on, so the addresses match the URL the page was given;
 * `localhost` for any other host (`0.0.0.0`, `::`, a name).
 */
export function developmentUrl(host: string, port: number): string {
	if (host === "127.0.0.1") return `http://127.0.0.1:${port}`;
	if (host === "::1" || host === "[::1]") return `http://[::1]:${port}`;
	return `http://localhost:${port}`;
}

export interface Relay {
	/** The external origin (issuer and address base). */
	readonly url: string;
	/** The port the server listens on. */
	readonly port: number;
	readonly config: RelayConfig;
	/** The MCP address a page with this secret gets. */
	addressFor(secret: string): string;
	/** Number of connected tab sessions. */
	readonly sessionCount: number;
	/** Close all sessions (bye `shutdown`, close 4004) and stop the server. */
	stop(): Promise<void>;
}

/** What `/healthz` says about the token store (DEC-099). */
type StoreHealth = "ok" | "store_unavailable" | "store_timeout";
/** How long the health probe waits for the store. */
const HEALTH_STORE_TIMEOUT_MS = 1000;
/** How long a probe's answer is reused. */
const HEALTH_REUSE_MS = 1000;
/** While an earlier read hangs, how long before a new one is tried. */
const HEALTH_HUNG_RETRY_MS = 30_000;
/** A store key no token ever has (a token's hash is of `tmcp_…`). */
const HEALTH_PROBE_HASH = hashToken("tab-mcp /healthz probe");

/**
 * The `a` parameter of a `/tab` query, read from the raw text: `undefined`
 * when absent, `false` when malformed or repeated. Only the literal id
 * counts, never a percent-encoded one, so the relay agrees with a load
 * balancer that matches the URL as sent (review of PR 38).
 */
function rawAddressParam(search: string): string | undefined | false {
	let found: string | undefined;
	for (const pair of search.replace(/^\?/, "").split("&")) {
		if (pair === "") continue;
		const eq = pair.indexOf("=");
		const rawName = eq < 0 ? pair : pair.slice(0, eq);
		let name: string;
		try {
			name = decodeURIComponent(rawName.replaceAll("+", " "));
		} catch {
			continue; // not ours: other parameters are ignored
		}
		if (name !== "a") continue;
		const value = eq < 0 ? "" : pair.slice(eq + 1);
		if (rawName !== "a" || found !== undefined || !isAddressId(value)) {
			return false;
		}
		found = value;
	}
	return found;
}

interface WsData {
	ip: string;
	origin: string;
	site: Site;
	/** The address id the URL named (`/tab?a=`, DEC-098). */
	address?: string;
	session?: TabSession;
}

/**
 * Test-only relaxations, never reachable from configuration or the package's
 * public API (`createTestRelay` is not exported from the package): CIMD
 * fetches from loopback test servers, shorter code lifetimes.
 */
export interface RelayTestHooks extends AuthorizationTestMode {
	pairingCodeTtlMs?: number;
	/** Keys for tab assertions instead of fetching the JWKS URL. */
	assertionKeys?: KeySource;
	/** A smaller relay-wide replay cache for tab assertions. */
	maxSeenAssertions?: number;
	/** How long `/healthz` waits before a new read while one hangs. */
	healthRetryMs?: number;
}

interface Body {
	value: Record<string, unknown>;
	text: string;
}

function json(
	status: number,
	value: unknown,
	headers?: Record<string, string>,
): Response {
	const h = new Headers(headers);
	h.set("content-type", "application/json");
	return new Response(JSON.stringify(value), { status, headers: h });
}

function rpcError(
	status: number,
	rpcId: RpcId | undefined,
	code: number,
	message: string,
	headers: Record<string, string>,
	data?: unknown,
): Response {
	return new Response(rpcErrorBody(rpcId, code, message, data), {
		status,
		headers: { ...headers, "content-type": "application/json" },
	});
}

function rpcIdOf(body: Record<string, unknown>): RpcId | undefined {
	if (!("id" in body)) return undefined;
	const id = body["id"];
	return typeof id === "string" || typeof id === "number" ? id : null;
}

/** A loggable MCP method name (attacker-controlled input, so constrained). */
function methodForLog(body: Record<string, unknown>): string {
	const m = body["method"];
	return typeof m === "string" && /^[A-Za-z0-9_/.-]{1,64}$/.test(m) ? m : "?";
}

function metaVersion(body: Record<string, unknown>): unknown {
	const params = body["params"];
	if (typeof params !== "object" || params === null) return undefined;
	const meta = (params as Record<string, unknown>)["_meta"];
	if (typeof meta !== "object" || meta === null) return undefined;
	return (meta as Record<string, unknown>)[PROTOCOL_VERSION_META_KEY];
}

const INDEX_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>tab-mcp relay</title>
<link rel="icon" href="/favicon.ico" sizes="32x32"><link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/apple-touch-icon.png"></head>
<body><h1>tab-mcp relay</h1>
<p>This server relays AI apps' MCP requests to tools offered by web pages open in a browser tab.
It does not log request contents. Source and documentation:
<a href="https://github.com/ractive/tab-mcp">github.com/ractive/tab-mcp</a>.</p>
</body></html>`;

function icon(body: string | Uint8Array<ArrayBuffer>, type: string): Response {
	return new Response(body, {
		headers: {
			"content-type": type,
			"content-security-policy": "default-src 'none'",
			"x-content-type-options": "nosniff",
			"cache-control": "public, max-age=86400",
		},
	});
}

/** Start a relay. Returns once the server listens. */
export function createRelay(options: CreateRelayOptions = {}): Relay {
	return startRelay(options, undefined);
}

/**
 * A relay with test hooks. Only for this repository's tests: it refuses to
 * start outside development and logs a warning.
 */
export function createTestRelay(
	options: CreateRelayOptions,
	hooks: RelayTestHooks,
): Relay {
	if (options.development !== true) {
		throw new Error("test hooks need development: true");
	}
	return startRelay(options, hooks);
}

function startRelay(
	options: CreateRelayOptions,
	hooks: RelayTestHooks | undefined,
): Relay {
	const { store: storeOption, logger: givenLogger, ...partial } = options;
	const tokenStore = typeof storeOption === "object" ? storeOption : undefined;
	const config = resolveConfig(
		typeof storeOption === "string"
			? { ...partial, store: storeOption }
			: partial,
	);
	const logger = givenLogger ?? createLogger(config.logLevel);
	const ownsStore = tokenStore === undefined;
	const store: TokenStore =
		tokenStore ??
		(config.store === "sqlite"
			? new SqliteTokenStore(config.sqlitePath)
			: new MemoryTokenStore());

	const sessions = new Map<string, TabSession>();
	const allSessions = new Set<TabSession>();
	const perIp = new Map<string, number>();
	/** Requests waiting for their page, per address (DEC-074). */
	const waiters = new Map<string, Set<(s: TabSession | undefined) => void>>();
	let waitingCount = 0;
	/**
	 * Each address's last session: its app name, for "open <name>", and its
	 * site's concurrency limit, for requests that wait for the page.
	 */
	const lastSeen = new Map<
		string,
		{ appName: string | undefined; maxConcurrentRequests: number }
	>();
	let claudeWorkarounds = 0;
	let publicUrl = config.publicUrl ?? "";
	/** Tab assertions (identity binding, DEC-076), when configured. */
	const assertions =
		config.oidc === undefined
			? undefined
			: new TabAssertionVerifier(
					config.oidc,
					hooks?.assertionKeys,
					hooks?.maxSeenAssertions,
				);

	const corsHeaders: Record<string, string> = config.cors
		? {
				"access-control-allow-origin": "*",
				"access-control-expose-headers":
					"www-authenticate, mcp-protocol-version",
			}
		: {};

	/** Tombstones outlive every token issued before the revocation (DEC-063). */
	const revokeOptions = () => {
		const now = Date.now();
		return { now, keepUntil: now + config.grantLifetimeMs };
	};

	function grantRemoved(
		addressId: string,
		grantId: string,
		reason: "revoked" | "reuse_detected" | "expired",
	): void {
		const session = sessions.get(addressId);
		if (session?.ready)
			session.send({ type: "grant.removed", grantId, reason });
	}

	const host = {
		config,
		logger,
		store,
		...(hooks?.pairingCodeTtlMs === undefined
			? {}
			: { pairingCodeTtlMs: hooks.pairingCodeTtlMs }),
		publicUrl: () => publicUrl,
		async revokeGrant(session: TabSession, grantId: string): Promise<boolean> {
			const addressId = session.addressId;
			if (addressId === undefined) return false;
			const grants = await store.listGrants(addressId, Date.now());
			if (!grants.some((g) => g.grantId === grantId)) return false;
			await store.revoke({ grantId }, revokeOptions());
			logger.info("oauth.revoked", {
				address: shortAddress(addressId),
				by: "tab",
			});
			grantRemoved(addressId, grantId, "revoked");
			return true;
		},
		async revokeAll(session: TabSession): Promise<void> {
			const addressId = session.addressId;
			if (addressId === undefined) return;
			const grants = await store.listGrants(addressId, Date.now());
			await store.revoke({ addressId }, revokeOptions());
			logger.info("oauth.revoked_all", {
				address: shortAddress(addressId),
				grants: grants.length,
			});
			for (const g of grants) grantRemoved(addressId, g.grantId, "revoked");
		},
		/**
		 * Called one at a time per session (the session chains `identity` and
		 * `identity.logout`), so a slow check never lands after a later sign-out.
		 * Always answers the tab once: `identity.bound` or `identity_refused`.
		 */
		async bindIdentity(
			session: TabSession,
			assertion: string,
			round?: number,
		): Promise<void> {
			const addressId = session.addressId;
			if (addressId === undefined) return;
			const echo = round === undefined ? {} : { round };
			// The page waits for this answer; a dropped one (backpressure) is
			// logged, and the page's timeout gives up on it (the round tells a late
			// answer from a new one).
			const answer = (message: RelayMessage) => {
				if (!session.send(message)) {
					logger.warn("identity.answer_dropped", {
						address: shortAddress(addressId),
						type: message.type,
					});
				}
			};
			const refuse = (reason: string, message: string) => {
				// Fail closed: a refused assertion also ends an earlier binding,
				// and the requests made under it. When the relay could not check
				// (keys or store unavailable), the AI app is told to try again,
				// not to sign in again, until an assertion is checked.
				const transient = TRANSIENT_REFUSALS.has(reason);
				session.identityUnchecked = transient;
				if (session.identity !== undefined) {
					session.identity = undefined;
					if (transient) {
						failPending(session, UNCHECKED_TEXT, true);
					} else {
						failPending(session, "The page's user is no longer signed in.");
					}
				}
				logger.info("identity.refused", {
					address: shortAddress(addressId),
					reason,
				});
				answer({ type: "error", code: "identity_refused", message, ...echo });
			};
			if (session.site.pairing !== "oidc" || assertions === undefined) {
				refuse("not_oidc", "this page's site does not use identity binding");
				return;
			}
			let key: string;
			try {
				key = await assertions.verify(
					assertion,
					`${publicUrl}/a/${addressId}/mcp`,
				);
			} catch (error) {
				refuse(
					error instanceof JwtError ? error.reason : "error",
					`the identity assertion was refused: ${error instanceof JwtError ? error.message : "the relay could not check it"}`,
				);
				return;
			}
			if (!session.ready) return; // closed meanwhile
			const changed = session.identity !== key;
			if (changed && session.identity !== undefined) {
				// Another person now: nothing more for the old one, before any I/O.
				session.identity = undefined;
				failPending(session, "The page's user changed.");
			}
			// Grants made for someone else (or with a code) end now (DEC-077).
			let revoked = 0;
			try {
				const grants = await store.listGrants(addressId, Date.now());
				for (const g of grants.filter((g) => g.subject !== key)) {
					await store.revoke({ grantId: g.grantId }, revokeOptions());
					grantRemoved(addressId, g.grantId, "revoked");
					revoked++;
				}
			} catch (error) {
				logger.error("store.error", {
					op: "identity",
					error: errorName(error),
				});
				refuse("store_unavailable", "the relay cannot check grants right now");
				return;
			}
			if (!session.ready) return;
			session.identity = key;
			session.identityUnchecked = false;
			answer({ type: "identity.bound", ...echo });
			logger.info("identity.bound", {
				address: shortAddress(addressId),
				changed,
				revoked,
			});
			host.ready(session); // requests waiting for a signed-in page go on
		},
		async signOut(session: TabSession): Promise<void> {
			const addressId = session.addressId;
			if (addressId === undefined) return;
			if (session.site.pairing !== "oidc") {
				session.send({
					type: "error",
					code: "identity_refused",
					message: "this page's site does not use identity binding",
				});
				return;
			}
			// First the binding and the requests in flight: they end even if the
			// store fails below.
			session.identity = undefined;
			session.identityUnchecked = false;
			failPending(session, "The page's user signed out.");
			try {
				const grants = await store.listGrants(addressId, Date.now());
				await store.revoke({ addressId }, revokeOptions());
				logger.info("identity.signed_out", {
					address: shortAddress(addressId),
					grants: grants.length,
				});
				for (const g of grants) grantRemoved(addressId, g.grantId, "revoked");
			} catch (error) {
				// The grants stay, but work only for a page bound to their person.
				logger.error("store.error", { op: "signOut", error: errorName(error) });
			}
		},
		claimAddress(session: TabSession): TabSession | undefined {
			const id = session.addressId;
			if (id === undefined) return undefined;
			const previous = sessions.get(id);
			sessions.set(id, session);
			return previous === session ? undefined : previous;
		},
		released(session: TabSession): void {
			allSessions.delete(session);
			if (
				session.addressId !== undefined &&
				sessions.get(session.addressId) === session
			) {
				sessions.delete(session.addressId);
			}
			releaseIp(session.ip);
		},
		ready(session: TabSession): void {
			const id = session.addressId;
			if (id === undefined) return;
			const appName = session.appName ?? lastSeen.get(id)?.appName;
			lastSeen.delete(id);
			lastSeen.set(id, {
				appName,
				maxConcurrentRequests: session.limits.maxConcurrentRequests,
			});
			// Bounded: forget the oldest addresses first.
			if (lastSeen.size > config.maxSessions * 2) {
				const oldest = lastSeen.keys().next().value;
				if (oldest !== undefined) lastSeen.delete(oldest);
			}
			const waiting = waiters.get(id);
			if (waiting !== undefined) for (const wake of [...waiting]) wake(session);
		},
	};

	/**
	 * End a session's requests in flight with `-31009`; the page is told to stop
	 * them. 401 with `WWW-Authenticate`, or, when the relay could not check
	 * (`transient`), 503 with `Retry-After`, so AI apps keep their tokens.
	 */
	function failPending(
		session: TabSession,
		message: string,
		transient = false,
	): void {
		const addressId = session.addressId;
		const headers: Record<string, string> = transient
			? { "retry-after": RETRY_AFTER_S }
			: addressId === undefined
				? {}
				: { "www-authenticate": wwwAuthenticate(addressId, true) };
		for (const exchange of [...session.pending.values()]) {
			exchange.fail(
				transient ? 503 : 401,
				RelayErrorCode.signedOut,
				message,
				true,
				headers,
			);
		}
	}

	function readySession(
		addressId: string,
		usable: (s: TabSession) => boolean = () => true,
	): TabSession | undefined {
		const s = sessions.get(addressId);
		return s?.ready === true && usable(s) ? s : undefined;
	}

	/**
	 * Whether a session can take a grant's requests: a grant with a subject, or
	 * any grant on an `oidc` site, needs a page that proved who its user is
	 * (DEC-077). Whether it is the same person is checked after the wait.
	 */
	function usableFor(subject: string | undefined) {
		return (s: TabSession) =>
			(subject === undefined && s.site.pairing === "code") ||
			s.identity !== undefined;
	}

	/**
	 * The page's ready session, waiting up to `waitMs` for it (DEC-074).
	 * `undefined` when it does not come in time or too many requests wait
	 * already; `"aborted"` when the AI app gave up.
	 */
	function waitForPage(
		addressId: string,
		signal: AbortSignal,
		waitMs: number,
		usable: (s: TabSession) => boolean,
	): Promise<TabSession | undefined | "aborted"> {
		const now = readySession(addressId, usable);
		if (now !== undefined) return Promise.resolve(now);
		if (waitMs === 0 || closing) {
			return Promise.resolve(undefined);
		}
		const set = waiters.get(addressId) ?? new Set();
		// A waiting request holds its body and a socket like a forwarded one: at
		// most maxConcurrentRequests per address (its site's, as far as known,
		// so none gets 429 when the page comes), maxSessions in all.
		const limit =
			sessions.get(addressId)?.limits.maxConcurrentRequests ??
			lastSeen.get(addressId)?.maxConcurrentRequests ??
			config.maxConcurrentRequests;
		if (set.size >= limit || waitingCount >= config.maxSessions) {
			return Promise.resolve(undefined);
		}
		return new Promise((resolve) => {
			let timer: Timer | undefined;
			let settled = false;
			const done = (result: TabSession | undefined | "aborted") => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				signal.removeEventListener("abort", onAbort);
				set.delete(wake);
				waitingCount--;
				if (set.size === 0 && waiters.get(addressId) === set) {
					waiters.delete(addressId);
				}
				resolve(result);
			};
			const wake = (session: TabSession | undefined) => {
				if (session === undefined || usable(session)) done(session);
			};
			const onAbort = () => done("aborted");
			set.add(wake);
			waiters.set(addressId, set);
			waitingCount++;
			timer = setTimeout(() => done(undefined), waitMs);
			signal.addEventListener("abort", onAbort, { once: true });
			if (signal.aborted) onAbort();
		});
	}

	function releaseIp(ip: string): void {
		const n = (perIp.get(ip) ?? 1) - 1;
		if (n <= 0) perIp.delete(ip);
		else perIp.set(ip, n);
	}

	function clientIp(req: Request, server: Server<WsData>): string {
		if (config.trustProxy === "x-real-ip") {
			const v = req.headers.get("x-real-ip")?.trim();
			if (v) return v;
		} else if (config.trustProxy === "x-forwarded-for") {
			const parts = (req.headers.get("x-forwarded-for") ?? "")
				.split(",")
				.map((s) => s.trim())
				.filter((s) => s !== "");
			const last = parts.at(-1);
			if (last !== undefined) return last;
		}
		return server.requestIP(req)?.address ?? "unknown";
	}

	const auth = new AuthorizationServer(
		{
			config,
			logger,
			store,
			publicUrl: () => publicUrl,
			session: (addressId) => {
				const s = sessions.get(addressId);
				return s?.ready === true ? s : undefined;
			},
			grantAdded: (addressId: string, grant: GrantInfo) => {
				const session = sessions.get(addressId);
				if (session?.ready) session.send({ type: "grant.added", grant });
			},
			grantRemoved: (addressId, grantId, reason) =>
				grantRemoved(
					addressId,
					grantId,
					reason as "revoked" | "reuse_detected" | "expired",
				),
		},
		hooks,
	);
	if (hooks !== undefined) {
		logger.warn("relay.test_hooks", {
			message: "test hooks are on: never use this relay outside tests",
		});
	}

	function handleTab(
		req: Request,
		server: Server<WsData>,
	): Response | undefined {
		const origin = req.headers.get("origin");
		const site = siteFor(config, origin);
		if (site === undefined) {
			logger.info("tab.refused", { reason: "origin" });
			return json(403, { error: "origin_not_allowed" });
		}
		const offered = (req.headers.get("sec-websocket-protocol") ?? "")
			.split(",")
			.map((s) => s.trim());
		if (!offered.includes(SUBPROTOCOL)) {
			return json(426, {
				error: "unsupported_protocol",
				supported: [SUBPROTOCOL],
			});
		}
		// The address id for a load balancer to route by (DEC-098). Optional
		// (libraries before 0.8 do not send it); checked against the secret
		// in hello. Never the secret itself: URLs end up in access logs.
		const address = rawAddressParam(new URL(req.url).search);
		if (address === false) {
			logger.info("tab.refused", { reason: "bad_address" });
			return json(400, { error: "bad_address" });
		}
		const realIp = clientIp(req, server);
		// Counted per /64 for IPv6 (DEC-061): one subscriber owns a whole /64.
		const ip = ipPrefixKey(realIp);
		if (allSessions.size >= config.maxSessions) {
			logger.warn("tab.refused", { reason: "max_sessions" });
			return json(429, { error: "too_many_sessions" });
		}
		const count = perIp.get(ip) ?? 0;
		if (count >= config.maxSessionsPerIp) {
			logger.warn("tab.refused", {
				reason: "max_sessions_per_ip",
				ip: truncateIp(realIp),
			});
			return json(429, { error: "too_many_sessions" });
		}
		perIp.set(ip, count + 1);
		const ok = server.upgrade(req, {
			data: {
				ip,
				origin: origin ?? "",
				site,
				...(address === undefined ? {} : { address }),
			},
			headers: { "Sec-WebSocket-Protocol": SUBPROTOCOL },
		});
		if (ok) return undefined;
		releaseIp(ip);
		return json(400, { error: "websocket_upgrade_expected" });
	}

	function wwwAuthenticate(id: string, presented: boolean): string {
		const metadata = `${publicUrl}/.well-known/oauth-protected-resource/a/${id}/mcp`;
		const error = presented ? ', error="invalid_token"' : "";
		return `Bearer resource_metadata="${metadata}", scope="tools"${error}`;
	}

	async function authenticate(
		req: Request,
		addressId: string,
	): Promise<TokenRecord | "missing" | "invalid" | "unavailable"> {
		const header = req.headers.get("authorization");
		if (header === null) return "missing";
		const match = /^Bearer ([A-Za-z0-9._~+/-]+=*)$/i.exec(header.trim());
		const token = match?.[1];
		if (token === undefined) return "invalid";
		let record: TokenRecord | undefined;
		try {
			record = await store.get(hashToken(token));
		} catch (error) {
			logger.error("store.error", { op: "get", error: errorName(error) });
			return "unavailable";
		}
		if (
			record === undefined ||
			record.kind !== "access" ||
			record.addressId !== addressId ||
			record.expiresAt <= Date.now() ||
			!record.scopes.includes("tools")
		) {
			return "invalid";
		}
		return record;
	}

	async function readBody(
		req: Request,
		maxBytes: number,
	): Promise<Body | Response> {
		const length = Number(req.headers.get("content-length") ?? "0");
		if (length > maxBytes) {
			return rpcError(
				413,
				undefined,
				-32600,
				"Request body too large.",
				corsHeaders,
			);
		}
		let bytes: ArrayBuffer;
		try {
			// Bun's idle timeout does not fire while a body is being read, so a
			// client that stalls mid-body would hold the socket; our own deadline
			// answers 408 and closes the connection.
			const reading = req.arrayBuffer();
			reading.catch(() => {}); // rejects once the socket is closed
			let timer: Timer | undefined;
			const deadline = new Promise<"timeout">((resolve) => {
				timer = setTimeout(() => resolve("timeout"), config.bodyTimeoutMs);
			});
			let result: ArrayBuffer | "timeout";
			try {
				result = await Promise.race([reading, deadline]);
			} finally {
				clearTimeout(timer);
			}
			if (result === "timeout") {
				return rpcError(
					408,
					undefined,
					-32600,
					"The request body did not arrive in time.",
					{ ...corsHeaders, connection: "close" },
				);
			}
			bytes = result;
		} catch {
			return rpcError(
				400,
				undefined,
				-32700,
				"Could not read the request body.",
				corsHeaders,
			);
		}
		if (bytes.byteLength > maxBytes) {
			return rpcError(
				413,
				undefined,
				-32600,
				"Request body too large.",
				corsHeaders,
			);
		}
		let text: string;
		let value: unknown;
		try {
			text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
			value = JSON.parse(text);
		} catch {
			return rpcError(400, undefined, -32700, "Parse error.", corsHeaders);
		}
		if (typeof value !== "object" || value === null || Array.isArray(value)) {
			return rpcError(
				400,
				undefined,
				-32600,
				"The body must be one JSON-RPC message (no batches).",
				corsHeaders,
			);
		}
		return { value: value as Record<string, unknown>, text };
	}

	/** DEC-033 / DEC-040: the protocol-version pre-check. */
	function checkVersion(
		req: Request,
		body: Record<string, unknown>,
		rpcId: RpcId | undefined,
	): Response | { forwardVersion: string } {
		const header = req.headers.get("mcp-protocol-version");
		// An initialize in a 2026-07-28 envelope is an ordinary request for a
		// method the tab does not have: forwarded, so the tab answers 404 and
		// -32601 like any removed method.
		if (
			body["method"] === "initialize" &&
			!(
				header === MCP_PROTOCOL_VERSION &&
				metaVersion(body) === MCP_PROTOCOL_VERSION
			)
		) {
			const params = body["params"] as Record<string, unknown> | undefined;
			const requested =
				typeof params?.["protocolVersion"] === "string"
					? params["protocolVersion"]
					: (header ?? null);
			return rpcError(
				400,
				rpcId,
				-32022,
				`Unsupported protocol version: ${String(requested)}. This server supports only ${MCP_PROTOCOL_VERSION}.`,
				corsHeaders,
				{ supported: [MCP_PROTOCOL_VERSION], requested },
			);
		}
		if (header === MCP_PROTOCOL_VERSION) return { forwardVersion: header };
		if (
			header === CLAUDE_MISMATCHED_HEADER &&
			metaVersion(body) === MCP_PROTOCOL_VERSION
		) {
			// Logged once per process; the running count is in /healthz.
			if (++claudeWorkarounds === 1) {
				logger.info("mcp.claude_header_workaround", {
					message:
						"accepting MCP-Protocol-Version 2025-11-25 with a 2026-07-28 body (claude-code #93290); counted in /healthz",
				});
			}
			return { forwardVersion: MCP_PROTOCOL_VERSION };
		}
		if (header === null) {
			return rpcError(
				400,
				rpcId,
				-32020,
				"Missing MCP-Protocol-Version header.",
				corsHeaders,
			);
		}
		return rpcError(
			400,
			rpcId,
			-32022,
			`Unsupported protocol version: ${header}. This server supports only ${MCP_PROTOCOL_VERSION}.`,
			corsHeaders,
			{ supported: [MCP_PROTOCOL_VERSION], requested: header },
		);
	}

	async function handleMcp(
		req: Request,
		server: Server<WsData>,
		addressId: string,
	): Promise<Response> {
		const started = Date.now();
		const logDone = (
			status: number,
			method: string,
			extra: Record<string, string | number> = {},
		) =>
			logger.info("mcp.request", {
				address: shortAddress(addressId),
				method,
				status,
				durationMs: Date.now() - started,
				...extra,
			});

		// The page's own limit when it is connected; else the instance's (the
		// request then ends with 401 or 503 anyway).
		const body = await readBody(
			req,
			sessions.get(addressId)?.limits.maxMessageBytes ?? config.maxMessageBytes,
		);
		if (body instanceof Response) {
			logDone(body.status, "?");
			return body;
		}
		const rpcId = rpcIdOf(body.value);
		const method = methodForLog(body.value);

		const version = checkVersion(req, body.value, rpcId);
		if (version instanceof Response) {
			logDone(version.status, method);
			return version;
		}

		const auth = await authenticate(req, addressId);
		if (auth === "unavailable") {
			// Not the token's fault: a 401 would make clients drop valid tokens.
			logDone(503, method, { reason: "store_unavailable" });
			return rpcError(
				503,
				rpcId,
				RelayErrorCode.storeUnavailable,
				"The relay cannot check tokens right now. Try again shortly.",
				{ ...corsHeaders, "retry-after": RETRY_AFTER_S },
			);
		}
		if (typeof auth === "string") {
			logDone(401, method);
			return json(
				401,
				{
					error: "invalid_token",
					error_description:
						auth === "missing"
							? "Authorization required."
							: "The access token is not valid.",
				},
				{
					...corsHeaders,
					"www-authenticate": wwwAuthenticate(addressId, auth === "invalid"),
				},
			);
		}

		const headers: Record<string, string> = {};
		for (const [k, v] of req.headers) {
			const key = k.toLowerCase();
			if (FORWARDED_HEADERS.has(key) || key.startsWith("mcp-param-"))
				headers[key] = v;
		}
		headers["mcp-protocol-version"] = version.forwardVersion;

		const clientHostName = (() => {
			try {
				return new URL(auth.clientId).host;
			} catch {
				return "";
			}
		})();
		const isListen = body.value["method"] === "subscriptions/listen";
		// `server/discover` does not wait: clients use it as the protocol-era
		// probe with a short timeout (Claude Code: 5 s, then it falls back to
		// the legacy handshake), and the stand-in answer has `ttlMs: 0`.
		const waitMs =
			body.value["method"] === "server/discover" ||
			// Only small requests wait: a waiting request holds its body, and
			// tool calls are small (review of iteration 8).
			Buffer.byteLength(body.text) > MIN_MESSAGE_BYTES
				? 0
				: config.pageWaitMs;
		const closed = () => {
			logDone(499, method, { outcome: "client_closed" });
			return new Response(null, { status: 499 });
		};

		// Only now, for an authenticated request, switch off Bun's idle timer:
		// our own timers (the page wait, the request timer) and keep-alives take
		// over (Bun research, finding 1). Body reading and every unauthenticated
		// path keep the idle timeout, so a stalled client cannot hold a socket.
		// It is switched on again on every exit, while the response is still in
		// progress: Bun ignores a timeout set once the response has finished.
		const idle = (on: boolean) =>
			server.timeout(req, on ? config.httpIdleTimeoutS : 0);
		const usable = usableFor(auth.subject);

		/** The page's session to forward to, or the answer when there is none. */
		const admit = async (): Promise<TabSession | Response> => {
			const found = await waitForPage(addressId, req.signal, waitMs, usable);
			// The AI app may have gone while the body was read, the token checked
			// or the page awaited: then forward nothing (the abort event has
			// already fired and would not cancel the exchange, which would hold a
			// slot until the timeout).
			if (found === "aborted" || req.signal.aborted) return closed();
			if (found === undefined) {
				return pageNotOpen(body.value, rpcId, addressId, logDone, method);
			}
			const session = found;
			// Identity binding: only the person the grant was made for (DEC-077).
			if (
				(auth.subject !== undefined || session.site.pairing === "oidc") &&
				session.identity !== auth.subject
			) {
				logDone(401, method, { reason: "identity_mismatch" });
				return json(
					401,
					{ error: "invalid_token", error_description: MISMATCH_TEXT },
					{
						...corsHeaders,
						"www-authenticate": `${wwwAuthenticate(addressId, true)}, error_description="${MISMATCH_TEXT}"`,
					},
				);
			}
			// The body was read with the instance's limit if the page was not
			// open yet; its site may allow less.
			if (Buffer.byteLength(body.text) > session.limits.maxMessageBytes) {
				logDone(413, method);
				return rpcError(
					413,
					rpcId,
					-32600,
					"Request body too large.",
					corsHeaders,
				);
			}
			if (session.pending.size >= session.limits.maxConcurrentRequests) {
				logDone(429, method);
				return rpcError(
					429,
					rpcId,
					RelayErrorCode.overloaded,
					"Too many requests at once for this page.",
					corsHeaders,
				);
			}
			if (
				isListen &&
				session.listenStreams(auth.grantId) >= MAX_LISTEN_STREAMS_PER_GRANT
			) {
				logDone(429, method, { reason: "listen_streams" });
				return rpcError(
					429,
					rpcId,
					RelayErrorCode.overloaded,
					"Too many listen streams at once for this AI app.",
					corsHeaders,
				);
			}
			return session;
		};

		if (readySession(addressId, usable) === undefined && waitMs > 0) {
			idle(false);
		}
		let retried = false;
		for (;;) {
			const admitted = await admit();
			if (admitted instanceof Response) {
				idle(true);
				return admitted;
			}
			const session = admitted;
			idle(false);
			let retry: () => void = () => {};
			const retrying = new Promise<typeof RETRY>((resolve) => {
				retry = () => resolve(RETRY);
			});
			const mayRetry =
				!retried && waitMs > 0 && isRetryable(body.value["method"]);
			const exchange = session.forward({
				headers,
				body: body.text,
				rpcId,
				isListen,
				grant: {
					grantId: auth.grantId,
					clientId: auth.clientId,
					scopes: auth.scopes,
				},
				extraHeaders: corsHeaders,
				onDone: (e: Exchange) => {
					if (e.outcome === "page_gone_retry") return; // logged once, at the end
					idle(true);
					logDone(e.status, method, {
						session: session.sessionId,
						client: clientHostName,
						outcome: e.outcome,
						...(e.outcome === "page_gone" ? { reason: "page_not_open" } : {}),
					});
				},
				pageGone: (waiting) => {
					if (waiting && mayRetry && !req.signal.aborted) {
						retry();
						return { retry: true };
					}
					const answer = notOpenAnswer(
						body.value,
						rpcId,
						session.appName,
						closing ? "restarting_gone" : "gone",
						RELAY_INFO,
					);
					if (answer !== undefined) return { retry: false, body: answer };
					// A notification: an HTTP error, which says "restarting" too.
					return !closing
						? { retry: false }
						: {
								retry: false,
								error: {
									status: 503,
									code: RelayErrorCode.restarting,
									message: "The relay is restarting.",
									headers: { "retry-after": RETRY_AFTER_S },
								},
							};
				},
			});
			const onAbort = () => exchange.clientClosed();
			req.signal.addEventListener("abort", onAbort, { once: true });
			const result = await Promise.race([exchange.response, retrying]);
			if (result !== RETRY) return result;
			req.signal.removeEventListener("abort", onAbort);
			retried = true;
		}
	}

	/**
	 * DEC-074: HTTP 200 and a JSON-RPC message, not an HTTP error status. While
	 * the relay stops, the answer says it restarts (iteration 11, finding 5).
	 */
	function pageNotOpen(
		value: Record<string, unknown>,
		rpcId: RpcId | undefined,
		addressId: string,
		logDone: (
			status: number,
			method: string,
			extra?: Record<string, string | number>,
		) => void,
		method: string,
	): Response {
		// Open but not signed in (identity binding) reads differently.
		const open = sessions.get(addressId);
		if (
			!closing &&
			open?.ready === true &&
			open.identity === undefined &&
			open.identityUnchecked
		) {
			// The relay could not check the page's user: not the user's errand.
			logDone(503, method, { reason: "identity_unchecked" });
			return rpcError(503, rpcId, RelayErrorCode.signedOut, UNCHECKED_TEXT, {
				...corsHeaders,
				"retry-after": RETRY_AFTER_S,
			});
		}
		const phase: NotOpenPhase = closing
			? "restarting"
			: open?.ready === true &&
					open.identity === undefined &&
					open.site.pairing === "oidc"
				? "signed_out"
				: "not_open";
		const reason = phase === "restarting" ? "restarting" : "page_not_open";
		const answer = notOpenAnswer(
			value,
			rpcId,
			open?.appName ?? lastSeen.get(addressId)?.appName,
			phase,
			RELAY_INFO,
		);
		if (answer === undefined) {
			// A notification: the spec requires an HTTP error status.
			logDone(503, method, { reason });
			return phase === "restarting"
				? rpcError(
						503,
						rpcId,
						RelayErrorCode.restarting,
						"The relay is restarting.",
						{ ...corsHeaders, "retry-after": RETRY_AFTER_S },
					)
				: rpcError(
						503,
						rpcId,
						RelayErrorCode.pageNotOpen,
						"The page is not open.",
						corsHeaders,
					);
		}
		logDone(200, method, { reason });
		return new Response(answer, {
			status: 200,
			headers: { ...corsHeaders, "content-type": "application/json" },
		});
	}

	function preflight(req: Request): Response {
		if (!config.cors)
			return new Response(null, { status: 405, headers: { allow: "POST" } });
		const requested = req.headers.get("access-control-request-headers") ?? "";
		return new Response(null, {
			status: 204,
			headers: {
				...corsHeaders,
				"access-control-allow-methods": "POST, OPTIONS",
				"access-control-allow-headers":
					requested !== ""
						? requested
						: "authorization, content-type, accept, mcp-protocol-version, mcp-method, mcp-name",
				"access-control-max-age": "600",
			},
		});
	}

	const methodNotAllowed = () =>
		new Response(null, {
			status: 405,
			headers: { ...corsHeaders, allow: "POST" },
		});

	const postOnly = () =>
		new Response(null, { status: 405, headers: { allow: "POST, OPTIONS" } });

	/**
	 * Whether the token store answers (DEC-099): one cheap read of a hash that
	 * never exists, with a deadline. One probe at a time, and its answer is
	 * reused for a second, so a flood of `/healthz` does not reach the store.
	 * While a read that missed its deadline still hangs, a new one starts only
	 * every `healthRetryMs` (30 s): a store that lost one command recovers, and
	 * a hung store holds at most one read per window.
	 */
	const healthRetryMs = hooks?.healthRetryMs ?? HEALTH_HUNG_RETRY_MS;
	let probe: Promise<StoreHealth> | undefined;
	let probed: { at: number; result: StoreHealth } | undefined;
	let hungReads = 0;
	let lastHungAt = 0;
	async function runProbe(): Promise<StoreHealth> {
		let timer: Timer | undefined;
		const deadline = new Promise<"store_timeout">((resolve) => {
			timer = setTimeout(
				() => resolve("store_timeout"),
				HEALTH_STORE_TIMEOUT_MS,
			);
		});
		// Inside a promise chain, so a store that throws synchronously is a
		// failed probe like any other.
		const read = Promise.resolve()
			.then(() => store.get(HEALTH_PROBE_HASH))
			.then(() => "ok" as const);
		read.catch(() => {}); // a late rejection after the deadline
		try {
			const result = await Promise.race([read, deadline]);
			if (result === "store_timeout") {
				logger.warn("health.store", { error: "timeout" });
				hungReads++;
				lastHungAt = Date.now();
				const settled = () => {
					hungReads--;
				};
				read.then(settled, settled);
			}
			return result;
		} catch (error) {
			logger.warn("health.store", { error: errorName(error) });
			return "store_unavailable";
		} finally {
			clearTimeout(timer);
		}
	}
	function storeHealth(): Promise<StoreHealth> {
		if (probe !== undefined) return probe;
		const now = Date.now();
		if (probed !== undefined && now - probed.at < HEALTH_REUSE_MS) {
			return Promise.resolve(probed.result);
		}
		if (hungReads > 0 && now - lastHungAt < healthRetryMs) {
			return Promise.resolve("store_timeout");
		}
		const current = runProbe().catch((): StoreHealth => "store_unavailable");
		probe = current;
		void current.then((result) => {
			probed = { at: Date.now(), result };
			if (probe === current) probe = undefined;
		});
		return current;
	}

	const largest = largestMessageBytes(config);
	const ipOf = (req: Request, srv: Server<WsData>) =>
		ipPrefixKey(clientIp(req, srv));
	const server = Bun.serve({
		port: config.port,
		hostname: config.host,
		development: false,
		maxRequestBodySize: largest + 1024,
		idleTimeout: config.httpIdleTimeoutS,
		routes: {
			"/healthz": {
				// no-store: a CDN in front caches answers without cache headers
				// (bunny for 30 days), and a deploy check would read the old version.
				GET: async () => {
					const store = await storeHealth();
					if (store !== "ok") {
						// A reason code only: never the store's error (DEC-099).
						return json(
							503,
							{ status: "unhealthy", reason: store, version: VERSION },
							{ "cache-control": "no-store" },
						);
					}
					return json(
						200,
						{
							status: "ok",
							version: VERSION,
							counters: { claudeHeaderWorkaround: claudeWorkarounds },
						},
						{ "cache-control": "no-store" },
					);
				},
			},
			"/": {
				GET: () =>
					new Response(INDEX_HTML, {
						headers: {
							"content-type": "text/html; charset=utf-8",
							"content-security-policy":
								"default-src 'none'; img-src 'self'; frame-ancestors 'none'",
							"x-content-type-options": "nosniff",
							"cache-control": "public, max-age=3600",
						},
					}),
			},
			// The relay's icon, for the AI apps' connector lists and browser tabs.
			"/favicon.ico": { GET: () => icon(FAVICON_ICO, "image/x-icon") },
			"/favicon.svg": { GET: () => icon(FAVICON_SVG, "image/svg+xml") },
			"/apple-touch-icon.png": {
				GET: () => icon(APPLE_TOUCH_ICON, "image/png"),
			},
			"/tab": (req, srv) => handleTab(req, srv),
			"/.well-known/oauth-authorization-server": {
				GET: () => auth.metadata(),
				OPTIONS: () => auth.preflight("GET"),
			},
			"/.well-known/oauth-protected-resource/a/:id/mcp": {
				GET: (req) => auth.protectedResource(req.params.id),
				OPTIONS: () => auth.preflight("GET"),
			},
			"/authorize": {
				GET: (req, srv) => auth.authorize(req, ipOf(req, srv)),
				POST: (req, srv) => auth.authorizeSubmit(req, ipOf(req, srv)),
			},
			"/authorize/callback": {
				GET: (req, srv) => auth.authorizeCallback(req, ipOf(req, srv)),
			},
			"/authorize.css": { GET: () => auth.stylesheet() },
			"/token": {
				POST: (req, srv) => auth.token(req, ipOf(req, srv)),
				OPTIONS: () => auth.preflight("POST"),
				GET: postOnly,
			},
			"/revoke": {
				POST: (req, srv) => auth.revoke(req, ipOf(req, srv)),
				OPTIONS: () => auth.preflight("POST"),
				GET: postOnly,
			},
			"/a/:id/mcp": {
				POST: (req, srv) => {
					const id = req.params.id;
					if (!isAddressId(id))
						return new Response("Not found", { status: 404 });
					return handleMcp(req, srv, id);
				},
				OPTIONS: (req) => preflight(req),
				GET: methodNotAllowed,
				DELETE: methodNotAllowed,
				PUT: methodNotAllowed,
				PATCH: methodNotAllowed,
			},
		},
		fetch: () => new Response("Not found", { status: 404 }),
		websocket: {
			data: {} as WsData,
			maxPayloadLength: largest * FRAME_HEADROOM,
			backpressureLimit: config.backpressureLimitBytes,
			closeOnBackpressureLimit: false,
			idleTimeout: 120,
			sendPings: true,
			perMessageDeflate: false,
			open(ws: ServerWebSocket<WsData>) {
				const session = new TabSession(
					ws,
					ws.data.ip,
					ws.data.origin,
					ws.data.site,
					host,
					ws.data.address,
				);
				ws.data.session = session;
				allSessions.add(session);
			},
			message(ws: ServerWebSocket<WsData>, message: string | Buffer) {
				ws.data.session?.handleFrame(
					typeof message === "string" ? message : new Uint8Array(message),
				);
			},
			close(ws: ServerWebSocket<WsData>, code: number) {
				ws.data.session?.closed(code);
			},
		},
	});

	let stopping: Promise<void> | undefined;
	/** Set at once by `stop()`, before the sessions end (their requests read it). */
	let closing = false;
	const port = server.port ?? config.port;
	if (publicUrl === "") publicUrl = developmentUrl(config.host, port);

	const sweep = setInterval(() => {
		auth.sweep();
		store
			.deleteExpired(Date.now())
			.then((n) => {
				if (n > 0) logger.debug("store.swept", { deleted: n });
			})
			.catch((error: unknown) =>
				logger.error("store.error", {
					op: "deleteExpired",
					error: errorName(error),
				}),
			);
	}, config.sweepIntervalMs);

	const siteCount =
		config.allowedOrigins === "*"
			? "*"
			: config.allowedOrigins.length + config.sites.length;
	if (config.allowedOrigins === "*") {
		logger.warn("relay.open_relay", {
			message:
				"TAB_MCP_ALLOWED_ORIGINS=* lets any website open tab sessions on this relay",
		});
	} else if (siteCount === 0) {
		logger.warn("relay.no_origins", {
			message:
				"TAB_MCP_ALLOWED_ORIGINS and TAB_MCP_SITES are empty: no page can connect",
		});
	}
	logger.info("relay.start", {
		version: VERSION,
		url: publicUrl,
		port,
		store: ownsStore ? config.store : "custom",
		origins: siteCount,
	});

	return {
		url: publicUrl,
		port,
		config,
		addressFor: (secret) => `${publicUrl}/a/${addressIdFromSecret(secret)}/mcp`,
		get sessionCount() {
			return allSessions.size;
		},
		stop() {
			closing = true;
			stopping ??= (async () => {
				clearInterval(sweep);
				for (const set of [...waiters.values()]) {
					for (const wake of [...set]) wake(undefined);
				}
				for (const session of [...allSessions]) {
					session.end(
						CloseCode.shuttingDown,
						"relay shutting down",
						"shutdown",
					);
				}
				await Bun.sleep(20); // let close frames leave
				await server.stop(true);
				if (ownsStore) await store.close?.();
				logger.info("relay.stop", {});
			})();
			return stopping;
		},
	};
}
