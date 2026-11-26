/**
 * A browser's sign-in and its account's group (DEC-231, iteration 53).
 *
 * The tab-mcp browser extension, over its tab session, asks to sign in with
 * a provider; the relay answers with a single-use URL of its own, which the
 * extension opens with `identity.launchWebAuthFlow`. That URL sets a cookie
 * and sends the browser to the provider; the provider sends it back to
 * `/authorize/callback` (the one callback of every flow, told apart by the
 * `state`'s `browser.` prefix). The relay checks the account but binds
 * nothing yet: it sends the browser to the extension's redirect URL with a
 * single-use completion code, a URL that only the `launchWebAuthFlow` the
 * extension started sees. The extension hands the code back over its own
 * session (`signin.complete`), and only then does the relay bind the
 * session's address id to the account and tell it who signed in. A user who
 * finishes someone else's link is left with the code in their own address
 * bar; the other session never gets it, and nothing is bound.
 *
 * Every browser bound to the same account is a member of one group. The
 * group's state goes to every member's session when it changes and when a
 * member connects. Members see each other's labels and whether they are
 * online, never their address ids, and nothing of their tabs.
 */

import { shortAddress } from "../address.ts";
import type { RelayConfig, SignInProviderId } from "../config.ts";
import { signInAllowed } from "../config.ts";
import { constantTimeEqual, randomBase64url } from "../crypto.ts";
import { networkKey } from "../ip.ts";
import { JwtError } from "../jwt.ts";
import { errorFields, type Logger, truncateKey } from "../log.ts";
import { displayName } from "../oauth/cimd.ts";
import { escapeHtml, pageHeaders, renderPage } from "../oauth/html.ts";
import { OidcError } from "../oauth/oidc.ts";
import {
	type GroupMessage,
	SIGN_IN_CAPABILITY,
	type SignInFailure,
	type SignInRedirectError,
} from "../protocol.ts";
import { RateLimiter } from "../ratelimit.ts";
import type { TabSession } from "../session.ts";
import type { BindingRecord, TokenStore } from "../store/types.ts";
import { newId } from "../tokens.ts";
import {
	type SignInAccount,
	type SignInEndpoints,
	type SignInProvider,
	signInProviders,
} from "./providers.ts";

/** Members per group (DEC-231): a 17th browser's sign-in is refused. */
export const MAX_MEMBERS = 16;
/** A browser's sign-in lasts 90 days, then it signs in again (DEC-231, as DEC-062). */
export const BINDING_LIFETIME_MS: number = 90 * 86_400_000;
/** How long a sign-in may take from `signin.start` to the callback. */
const FLOW_TTL_MS = 10 * 60_000;
/** Open sign-ins on the relay; one per session at most. */
const MAX_FLOWS = 10_000;
/** How long the extension has to hand back the completion code. */
const COMPLETION_TTL_MS = 2 * 60_000;
/** The `state` of a browser's sign-in starts with this (an AI app's has none). */
const STATE_PREFIX = "browser.";
/** The label of a member whose browser sent none. */
const DEFAULT_LABEL = "Browser";

/** What sign-in needs from its relay. */
export interface SignInHost {
	readonly config: RelayConfig;
	readonly logger: Logger;
	/** A store with the five binding methods (`hasBindings`). */
	readonly store: TokenStore & Required<BindingMethods>;
	publicUrl(): string;
	/** The ready session that holds an address now, if any. */
	sessionOf(addressId: string): TabSession | undefined;
}

type BindingMethods = Pick<
	TokenStore,
	| "putBinding"
	| "getBinding"
	| "listBindings"
	| "renameBinding"
	| "deleteBinding"
>;

/** Test-only settings (`createTestRelay`). */
export interface SignInTestMode {
	endpoints?: SignInEndpoints;
	bindingLifetimeMs?: number;
}

/** A session's place in a group, while it is signed in. */
export interface Membership {
	group: string;
	memberId: string;
	provider: string;
	expiresAt: number;
}

interface Flow {
	state: string;
	/** The single-use token of the relay's own URL (`/signin?flow=`). */
	start: string;
	nonce: string;
	verifier: string;
	provider: SignInProvider;
	/** The provider's authorization URL, made at the start. */
	authorizationUrl: string;
	session: TabSession;
	addressId: string;
	redirectUrl: string;
	label: string;
	expiresAt: number;
	/** The cookie set when the browser opened the relay's URL. */
	cookie?: string;
}

/** A checked sign-in that waits for its extension's `signin.complete`. */
interface Completion {
	flow: Flow;
	account: SignInAccount;
	expiresAt: number;
}

/** The cookie's name for a flow: one per flow, so two sign-ins at once do not clash. */
function cookieName(flow: Flow, secure: boolean): string {
	return `${secure ? "__Host-" : ""}tab-mcp-signin-${flow.start.slice(0, 8)}`;
}

function cookieValue(req: Request, name: string): string | undefined {
	for (const part of (req.headers.get("cookie") ?? "").split(";")) {
		const [k, v] = part.trim().split("=");
		if (k === name && v !== undefined) return v;
	}
	return undefined;
}

/**
 * Whether `url` is the redirect URL of the extension whose page `origin`
 * is (`identity.getRedirectURL()` without a path): Chrome and Edge
 * `https://<extension id>.chromiumapp.org/` with the origin's own id,
 * Firefox `https://<40 hex digits>.extensions.allizom.org/` (a hash of the
 * extension's id, which its per-installation origin does not show).
 */
export function redirectUrlFits(url: string, origin: string): boolean {
	const chrome = /^chrome-extension:\/\/([a-p]{32})$/.exec(origin)?.[1];
	if (chrome !== undefined) return url === `https://${chrome}.chromiumapp.org/`;
	if (
		/^moz-extension:\/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
			origin,
		)
	) {
		return /^https:\/\/[0-9a-f]{40}\.extensions\.allizom\.org\/$/.test(url);
	}
	return false;
}

const FAILURE_TEXT: Record<SignInFailure, string> = {
	not_offered: "This relay does not offer that sign-in.",
	bad_redirect: "This relay cannot send the sign-in back to this browser.",
	rate_limited:
		"Too many sign-ins from this browser or network. Wait a few minutes and try again.",
	busy: "Too many sign-ins are open right now. Wait a few minutes and try again.",
	provider_unavailable:
		"The sign-in provider cannot be reached right now. Try again in a minute.",
	code_refused:
		"This sign-in has expired or belongs to another sign-in. Sign in again.",
	group_full: `This account already has ${MAX_MEMBERS} browsers signed in. Remove one in another browser's panel, then sign in again.`,
	store_unavailable:
		"The relay cannot save the sign-in right now. Try again shortly.",
};

/** Browsers' sign-ins and their groups. */
export class BrowserSignIn {
	readonly #host: SignInHost;
	readonly #providers: Map<SignInProviderId, SignInProvider>;
	readonly #lifetimeMs: number;
	/** state → flow; insertion order is expiry order. */
	readonly #flows = new Map<string, Flow>();
	/** start token → state. */
	readonly #starts = new Map<string, string>();
	/** Each session's one open flow. */
	readonly #flowOf = new Map<TabSession, string>();
	/** Completion code → checked sign-in; insertion order is expiry order. */
	readonly #completions = new Map<string, Completion>();
	/** The members' sessions that are online, per group. */
	readonly #online = new Map<string, Set<TabSession>>();
	/** Sign-ins a session may start: 5, then one every 30 s. */
	readonly #startsPerSession = new RateLimiter({
		capacity: 5,
		refillPerSecond: 1 / 30,
	});
	/** Sign-ins one network may start: 20, then one every 30 s. */
	readonly #startsPerNetwork = new RateLimiter({
		capacity: 20,
		refillPerSecond: 1 / 30,
		onLimited: (key) => this.#limited("signin_starts", key),
	});
	/**
	 * Views of the relay's sign-in URL and its callback per network: two per
	 * sign-in, so 30 sign-ins at once, then one every two seconds.
	 */
	readonly #viewsPerNetwork = new RateLimiter({
		capacity: 60,
		refillPerSecond: 1,
		onLimited: (key) => this.#limited("signin_views", key),
	});

	constructor(host: SignInHost, testMode: SignInTestMode = {}) {
		this.#host = host;
		this.#providers = signInProviders(
			host.config.signIn?.providers ?? {},
			host.config.development,
			testMode.endpoints,
		);
		this.#lifetimeMs = testMode.bindingLifetimeMs ?? BINDING_LIFETIME_MS;
	}

	#limited(limit: string, key: string): void {
		this.#host.logger.warn("signin.rate_limited", {
			limit,
			ip: truncateKey(key),
		});
	}

	/** Whether a session gets the sign-in messages: it named the capability, and its app may sign in. */
	offers(app: string, capabilities: readonly string[]): boolean {
		return (
			capabilities.includes(SIGN_IN_CAPABILITY) &&
			signInAllowed(this.#host.config, app) &&
			this.#providers.size > 0
		);
	}

	/** The providers for `session.signIn`, in the order of the buttons. */
	providerList(): { id: string; name: string }[] {
		return [...this.#providers.values()].map((p) => ({
			id: p.id,
			name: p.name,
		}));
	}

	// The session's life

	/**
	 * Before `session` is sent: the address's binding, if it has one. A store
	 * failure leaves the session signed out until it connects again.
	 */
	async attach(session: TabSession): Promise<void> {
		const addressId = session.addressId;
		if (addressId === undefined) return;
		try {
			const b = await this.#host.store.getBinding(addressId, Date.now());
			session.member = b === undefined ? undefined : membership(b);
		} catch (error) {
			this.#host.logger.error("store.error", {
				op: "getBinding",
				...errorFields(error),
			});
		}
	}

	/** After `session` was sent: the member is online; its group hears of it. */
	connected(session: TabSession): void {
		const member = session.member;
		if (member === undefined) return;
		this.#join(session, member.group);
		void this.#announce(member.group);
	}

	/**
	 * The session ended: its group sees it offline. Its open flow stays until
	 * it expires, so a sign-in that comes back for it goes back to the
	 * extension as failed (and binds nothing) instead of ending on an error
	 * page in the sign-in window.
	 */
	released(session: TabSession): void {
		const group = session.member?.group;
		if (group === undefined) return;
		if (this.#leave(session, group)) void this.#announce(group);
	}

	#join(session: TabSession, group: string): void {
		const set = this.#online.get(group) ?? new Set();
		set.add(session);
		this.#online.set(group, set);
	}

	/** Whether the session was online in the group. */
	#leave(session: TabSession, group: string): boolean {
		const set = this.#online.get(group);
		if (set === undefined || !set.delete(session)) return false;
		if (set.size === 0) this.#online.delete(group);
		return true;
	}

	/**
	 * Send the group's state to each of its online members. Who is online is
	 * read after the store answered, so of two announcements in a row the
	 * later one never shows an older state.
	 */
	async #announce(group: string): Promise<void> {
		let bindings: BindingRecord[];
		try {
			bindings = await this.#host.store.listBindings(group, Date.now());
		} catch (error) {
			this.#host.logger.error("store.error", {
				op: "listBindings",
				...errorFields(error),
			});
			return;
		}
		const sessions = [...(this.#online.get(group) ?? [])].filter(
			(s) => s.ready && s.member?.group === group,
		);
		const online = new Set(sessions.map((s) => s.member?.memberId));
		const members = bindings.map((b) => ({
			id: b.memberId,
			label: b.label,
			online: online.has(b.memberId),
			signedInAt: new Date(b.createdAt).toISOString(),
		}));
		for (const s of sessions) {
			const member = s.member;
			if (member === undefined) continue;
			const message: GroupMessage = {
				type: "group",
				provider: member.provider,
				self: member.memberId,
				expiresAt: new Date(member.expiresAt).toISOString(),
				maxMembers: MAX_MEMBERS,
				members,
			};
			s.send(message);
		}
	}

	// The session's messages

	/** `signin.start`: answers `signin.url` or `signin.failed`. */
	async start(
		session: TabSession,
		providerId: string,
		redirectUrl: string,
		label: string | undefined,
	): Promise<void> {
		const addressId = session.addressId;
		if (addressId === undefined) return;
		const provider = this.#providers.get(providerId as SignInProviderId);
		const failed = (reason: SignInFailure) =>
			this.#failed(session, reason, provider?.id);
		if (provider === undefined) return failed("not_offered");
		if (!redirectUrlFits(redirectUrl, session.origin)) {
			return failed("bad_redirect");
		}
		if (
			!this.#startsPerSession.take(session.sessionId) ||
			!this.#startsPerNetwork.take(networkKey(session.ip))
		) {
			return failed("rate_limited");
		}
		this.#sweep(Date.now());
		const previous = this.#flowOf.get(session);
		if (previous !== undefined) this.#dropFlow(previous);
		if (this.#flows.size >= MAX_FLOWS) return failed("busy");
		const flow: Flow = {
			state: `${STATE_PREFIX}${provider.id}.${randomBase64url(24)}`,
			start: randomBase64url(24),
			nonce: randomBase64url(24),
			verifier: randomBase64url(32),
			provider,
			authorizationUrl: "",
			session,
			addressId,
			redirectUrl,
			label: cleanLabel(label) ?? DEFAULT_LABEL,
			expiresAt: Date.now() + FLOW_TTL_MS,
		};
		try {
			flow.authorizationUrl = await provider.authorizationUrl(
				this.#secrets(flow),
			);
		} catch (error) {
			this.#host.logger.warn("signin.provider_unavailable", {
				provider: provider.id,
				reason: error instanceof OidcError ? error.reason : "fetch",
			});
			return failed("provider_unavailable");
		}
		if (!session.ready) return;
		this.#flows.set(flow.state, flow);
		this.#starts.set(flow.start, flow.state);
		this.#flowOf.set(session, flow.state);
		this.#host.logger.info("signin.started", {
			address: shortAddress(addressId),
			provider: provider.id,
		});
		session.send({
			type: "signin.url",
			provider: provider.id,
			url: `${this.#host.publicUrl()}/signin?flow=${flow.start}`,
			expiresAt: new Date(flow.expiresAt).toISOString(),
		});
	}

	/** `signin.out`: the binding ends; answered with `signin.ended`. */
	async signOut(session: TabSession): Promise<void> {
		const addressId = session.addressId;
		if (addressId === undefined) return;
		try {
			await this.#host.store.deleteBinding({ addressId });
		} catch (error) {
			this.#host.logger.error("store.error", {
				op: "deleteBinding",
				...errorFields(error),
			});
			session.refused("store_unavailable", STORE_TEXT, { type: "signin.out" });
			return;
		}
		const group = session.member?.group;
		this.#end(session, "signed_out");
		if (group !== undefined) void this.#announce(group);
	}

	/** `member.rename`: any member renames any member of its group. */
	async rename(
		session: TabSession,
		memberId: string,
		raw: string,
	): Promise<void> {
		const member = session.member;
		const about = {
			type: "member.rename" as const,
			member: memberId,
			label: raw,
		};
		const label = cleanLabel(raw);
		if (label === undefined) {
			session.sendError(
				"bad_message",
				"member.rename.label has no visible characters",
			);
			return;
		}
		if (member === undefined) {
			session.refused("unknown_id", "this browser is not signed in", about);
			return;
		}
		let renamed: boolean;
		try {
			renamed = await this.#host.store.renameBinding(
				member.group,
				memberId,
				label,
				Date.now(),
			);
		} catch (error) {
			this.#host.logger.error("store.error", {
				op: "renameBinding",
				...errorFields(error),
			});
			session.refused("store_unavailable", STORE_TEXT, about);
			return;
		}
		if (!renamed) {
			session.refused("unknown_id", "no such member in this group", about);
			return;
		}
		this.#host.logger.info("signin.renamed", {
			address: shortAddress(session.addressId ?? ""),
			self: memberId === member.memberId,
		});
		void this.#announce(member.group);
	}

	/**
	 * `member.remove`: any member removes any member of its group; the
	 * removed browser's binding ends and it is told (`signin.ended`
	 * `removed`). A browser that removes itself has signed out.
	 */
	async remove(session: TabSession, memberId: string): Promise<void> {
		const member = session.member;
		const about = { type: "member.remove" as const, member: memberId };
		if (member === undefined) {
			session.refused("unknown_id", "this browser is not signed in", about);
			return;
		}
		if (memberId === member.memberId) {
			await this.signOut(session);
			return;
		}
		let removed: BindingRecord | undefined;
		try {
			removed = await this.#host.store.deleteBinding({
				group: member.group,
				memberId,
			});
		} catch (error) {
			this.#host.logger.error("store.error", {
				op: "deleteBinding",
				...errorFields(error),
			});
			session.refused("store_unavailable", STORE_TEXT, about);
			return;
		}
		if (removed === undefined) {
			session.refused("unknown_id", "no such member in this group", about);
			return;
		}
		const target = this.#host.sessionOf(removed.addressId);
		if (target?.member?.memberId === memberId) this.#end(target, "removed");
		this.#host.logger.info("signin.removed", {
			address: shortAddress(session.addressId ?? ""),
			removed: shortAddress(removed.addressId),
		});
		void this.#announce(member.group);
	}

	/** A session's binding ended: it leaves the group and is told why. */
	#end(
		session: TabSession,
		reason: "signed_out" | "removed" | "expired",
	): void {
		const member = session.member;
		if (member !== undefined) this.#leave(session, member.group);
		session.member = undefined;
		session.send({ type: "signin.ended", reason });
		this.#host.logger.info("signin.ended", {
			address: shortAddress(session.addressId ?? ""),
			reason,
		});
	}

	#failed(
		session: TabSession,
		reason: SignInFailure,
		provider: string | undefined,
	): void {
		this.#host.logger.info("signin.failed", {
			address: shortAddress(session.addressId ?? ""),
			reason,
			...(provider === undefined ? {} : { provider }),
		});
		session.send({
			type: "signin.failed",
			...(provider === undefined ? {} : { provider }),
			reason,
			message: FAILURE_TEXT[reason],
		});
	}

	// HTTP

	/** Whether a callback's `state` is a browser's sign-in. */
	static owns(state: string | null): boolean {
		return state?.startsWith(STATE_PREFIX) === true;
	}

	/**
	 * GET `/signin?flow=`: the URL the extension opened. Once only: it sets
	 * the flow's cookie and sends the browser to the provider.
	 */
	visit(req: Request, ip: string): Response {
		if (!this.#viewsPerNetwork.take(networkKey(ip))) {
			return this.#page(
				429,
				"Too many requests from your network. Wait a minute and try again.",
			);
		}
		this.#sweep(Date.now());
		const token = new URL(req.url).searchParams.get("flow") ?? "";
		const state = this.#starts.get(token);
		const flow = state === undefined ? undefined : this.#flows.get(state);
		if (flow === undefined || flow.cookie !== undefined) {
			return this.#page(
				400,
				"This sign-in link has expired or was already used. Start the sign-in again in your browser extension.",
			);
		}
		flow.cookie = randomBase64url(16);
		const secure = this.#host.publicUrl().startsWith("https:");
		const maxAge = Math.max(1, Math.ceil((flow.expiresAt - Date.now()) / 1000));
		return new Response(null, {
			status: 302,
			headers: {
				location: flow.authorizationUrl,
				"cache-control": "no-store",
				"referrer-policy": "no-referrer",
				"set-cookie": `${cookieName(flow, secure)}=${flow.cookie}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? "; Secure" : ""}`,
			},
		});
	}

	/**
	 * GET `/authorize/callback` with a browser's `state`: check the flow,
	 * redeem the code and check the account, then send the browser to the
	 * extension's redirect URL with a completion code (`?signin=<code>`), or
	 * the reason it failed (`?signin_error=<reason>`). Nothing is bound and
	 * nothing goes to the session here: only the extension that started the
	 * `launchWebAuthFlow` sees that URL, and it hands the code back itself
	 * (`complete`).
	 */
	async callback(req: Request, ip: string): Promise<Response> {
		if (!this.#viewsPerNetwork.take(networkKey(ip))) {
			return this.#page(
				429,
				"Too many requests from your network. Wait a minute and try again.",
			);
		}
		this.#sweep(Date.now());
		const params = new URL(req.url).searchParams;
		const state = params.get("state") ?? "";
		const flow = this.#flows.get(state);
		if (flow === undefined || flow.expiresAt <= Date.now()) {
			return this.#page(
				400,
				"This sign-in has expired or was already used. Start it again in your browser extension.",
			);
		}
		this.#dropFlow(state); // single use
		const { provider } = flow;
		const secure = this.#host.publicUrl().startsWith("https:");
		const sent = cookieValue(req, cookieName(flow, secure));
		if (
			flow.cookie === undefined ||
			sent === undefined ||
			!constantTimeEqual(sent, flow.cookie)
		) {
			// Not the browser that opened the link: show nothing of the extension.
			this.#host.logger.info("signin.failed", {
				address: shortAddress(flow.addressId),
				reason: "browser",
				provider: provider.id,
			});
			return this.#page(
				403,
				"The sign-in came back in another browser than the one that started it.",
			);
		}
		const failed = (reason: SignInRedirectError) => {
			this.#host.logger.info("signin.failed", {
				address: shortAddress(flow.addressId),
				reason,
				provider: provider.id,
			});
			return this.#backToExtension(flow, { signin_error: reason });
		};
		const error = params.get("error");
		const code = params.get("code");
		if (error !== null || code === null || code === "") {
			this.#host.logger.info("signin.provider_error", {
				provider: provider.id,
				error: (error ?? "no_code").slice(0, 64),
			});
			return failed("provider_error");
		}
		if (!this.#current(flow)) return failed("session_gone");
		let account: SignInAccount;
		try {
			account = await provider.complete(code, this.#secrets(flow));
		} catch (e) {
			const reason =
				e instanceof OidcError || e instanceof JwtError ? e.reason : "exchange";
			const cause = e instanceof Error ? e.cause : undefined;
			const detail =
				e instanceof Error
					? cause instanceof Error
						? `${e.message}: ${cause.message}`
						: e.message
					: "unknown";
			// The provider's answer, for the operator; never the secret, never shown.
			this.#host.logger.warn("signin.unchecked", {
				provider: provider.id,
				reason,
				message: detail.slice(0, 200),
			});
			return failed("unchecked");
		}
		if (this.#completions.size >= MAX_FLOWS) {
			const oldest = this.#completions.keys().next().value;
			if (oldest !== undefined) this.#completions.delete(oldest);
		}
		const completion = randomBase64url(24);
		this.#completions.set(completion, {
			flow,
			account,
			expiresAt: Date.now() + COMPLETION_TTL_MS,
		});
		this.#host.logger.info("signin.checked", {
			address: shortAddress(flow.addressId),
			provider: provider.id,
		});
		return this.#backToExtension(flow, { signin: completion });
	}

	/**
	 * `signin.complete`: the extension hands back the completion code of its
	 * redirect URL. It binds only for the session whose flow made it, once,
	 * within two minutes; anything else is `code_refused`, and the code is
	 * spent either way.
	 */
	async complete(session: TabSession, code: string): Promise<void> {
		this.#sweep(Date.now());
		const completion = this.#completions.get(code);
		if (completion !== undefined) this.#completions.delete(code);
		if (
			completion === undefined ||
			completion.expiresAt <= Date.now() ||
			completion.flow.session !== session
		) {
			this.#failed(session, "code_refused", completion?.flow.provider.id);
			return;
		}
		await this.#bind(completion.flow, completion.account);
	}

	/** The flow's session still holds its address: a sign-in for it may bind. */
	#current(flow: Flow): boolean {
		return (
			flow.session.ready &&
			this.#host.sessionOf(flow.addressId) === flow.session
		);
	}

	/** Bind the flow's address to the account; tell the session and the groups. */
	async #bind(flow: Flow, account: SignInAccount): Promise<boolean> {
		const { session, provider, addressId } = flow;
		if (!this.#current(flow)) return false;
		const now = Date.now();
		const store = this.#host.store;
		let result: "ok" | "full";
		let record: BindingRecord;
		let before: BindingRecord | undefined;
		try {
			before = await store.getBinding(addressId, now);
			const same = before?.group === account.key;
			record = {
				addressId,
				group: account.key,
				// Signing in again with the same account keeps the member and its name.
				memberId: same && before !== undefined ? before.memberId : newId("m"),
				provider: provider.id,
				app: session.app ?? "",
				label: same && before !== undefined ? before.label : flow.label,
				createdAt: now,
				expiresAt: now + this.#lifetimeMs,
			};
			result = await store.putBinding(record, MAX_MEMBERS, now);
		} catch (error) {
			this.#host.logger.error("store.error", {
				op: "putBinding",
				...errorFields(error),
			});
			this.#failed(session, "store_unavailable", provider.id);
			return false;
		}
		if (result === "full") {
			this.#failed(session, "group_full", provider.id);
			return false;
		}
		const previous = session.member?.group ?? before?.group;
		if (session.member !== undefined)
			this.#leave(session, session.member.group);
		if (!session.ready) {
			// Closed meanwhile: bound all the same, online once it connects again.
			if (previous !== undefined && previous !== record.group) {
				void this.#announce(previous);
			}
			return true;
		}
		session.member = membership(record);
		this.#join(session, record.group);
		this.#host.logger.info("signin.bound", {
			address: shortAddress(addressId),
			provider: provider.id,
			renewed: before?.group === record.group,
		});
		session.send({
			type: "signin.done",
			provider: provider.id,
			displayName: account.displayName,
			...(account.kind === undefined ? {} : { kind: account.kind }),
			member: record.memberId,
		});
		void this.#announce(record.group);
		if (previous !== undefined && previous !== record.group) {
			void this.#announce(previous);
		}
		return true;
	}

	/** The extension's redirect URL with one parameter: the completion code or the reason. */
	#backToExtension(
		flow: Flow,
		param: { signin: string } | { signin_error: SignInRedirectError },
	): Response {
		const url = new URL(flow.redirectUrl);
		for (const [k, v] of Object.entries(param)) url.searchParams.set(k, v);
		return new Response(null, {
			status: 302,
			headers: {
				location: url.href,
				"cache-control": "no-store",
				"referrer-policy": "no-referrer",
			},
		});
	}

	#page(status: number, message: string): Response {
		return new Response(
			renderPage(
				"Sign-in",
				`<h1>The sign-in cannot be finished</h1>
<p role="alert">${escapeHtml(message)}</p>
<p>Close this window. Nothing was signed in.</p>`,
			),
			{ status, headers: pageHeaders() },
		);
	}

	#secrets(flow: Flow) {
		return {
			state: flow.state,
			nonce: flow.nonce,
			verifier: flow.verifier,
			redirectUri: `${this.#host.publicUrl()}/authorize/callback`,
		};
	}

	#dropFlow(state: string): void {
		const flow = this.#flows.get(state);
		if (flow === undefined) return;
		this.#flows.delete(state);
		this.#starts.delete(flow.start);
		if (this.#flowOf.get(flow.session) === state) {
			this.#flowOf.delete(flow.session);
		}
	}

	/** Open sign-ins (for `relay.stats`). */
	get flowCount(): number {
		return this.#flows.size;
	}

	#sweep(now: number): void {
		for (const [state, flow] of this.#flows) {
			if (flow.expiresAt > now) break;
			this.#dropFlow(state);
		}
		for (const [code, completion] of this.#completions) {
			if (completion.expiresAt > now) break;
			this.#completions.delete(code);
		}
	}

	/**
	 * The relay's sweep: old flows go, and members whose 90 days are over
	 * leave their groups (`signin.ended` `expired`); the store's
	 * `deleteExpired` drops their bindings.
	 */
	sweep(now: number): void {
		this.#sweep(now);
		for (const [group, set] of [...this.#online]) {
			let changed = false;
			for (const s of [...set]) {
				if (s.member !== undefined && s.member.expiresAt <= now) {
					this.#end(s, "expired");
					changed = true;
				}
			}
			if (changed) void this.#announce(group);
		}
	}
}

const STORE_TEXT =
	"the relay cannot change the sign-in right now; try again shortly";

function membership(b: BindingRecord): Membership {
	return {
		group: b.group,
		memberId: b.memberId,
		provider: b.provider,
		expiresAt: b.expiresAt,
	};
}

/** A label as members see it: no invisible characters; `undefined` if nothing is left. */
function cleanLabel(raw: string | undefined): string | undefined {
	if (raw === undefined) return undefined;
	const cleaned = displayName(raw);
	return cleaned === "" ? undefined : cleaned;
}
