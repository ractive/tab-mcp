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

import { groupAddress, shortAddress } from "../address.ts";
import { readBodyWithDeadline } from "../body.ts";
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
	type GrantInfo,
	type GroupMessage,
	type GroupMode,
	type GroupPin,
	SIGN_IN_CAPABILITY,
	type SignInFailure,
	type SignInRedirectError,
} from "../protocol.ts";
import { RateLimiter } from "../ratelimit.ts";
import { clientHost, type TabSession } from "../session.ts";
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
/**
 * Flows whose link nobody opened yet, per network (`networkKey`): one
 * browser needs one; a few allow several profiles behind one address.
 */
const MAX_UNVISITED_PER_NETWORK = 3;
/** The interstitial's form body is two short fields. */
const MAX_FORM_BYTES = 1024;
/** How long the extension has to hand back the completion code. */
const COMPLETION_TTL_MS = 2 * 60_000;
/** The `state` of a browser's sign-in starts with this (an AI app's has none). */
const STATE_PREFIX = "browser.";
/** The label of a member whose browser sent none. */
const DEFAULT_LABEL = "Browser";
/**
 * `focus` messages per member (DEC-232): 20, then two a second. They do
 * not count against the session's control budget, so switching windows
 * quickly never ends a session; past this they are dropped.
 */
const FOCUS_BURST = 20;
const FOCUS_PER_SECOND = 2;
/** Groups whose routing state is kept while none of their members is online. */
const MAX_IDLE_GROUPS = 10_000;
/** Requests that wait for a member of one group to come online, at most. */
const MAX_WAITING_PER_GROUP = 64;

/** What sign-in needs from its relay. */
export interface SignInHost {
	readonly config: RelayConfig;
	readonly logger: Logger;
	/** A store with the five binding methods (`hasBindings`). */
	readonly store: TokenStore & Required<BindingMethods>;
	publicUrl(): string;
	/** The ready session that holds an address now, if any. */
	sessionOf(addressId: string): TabSession | undefined;
	/**
	 * A group grant ended (DEC-232): its requests in flight on the members'
	 * sessions end, as a page grant's do, and the members hear of it.
	 */
	groupGrantRemoved(
		group: string,
		grantId: string,
		reason: "revoked" | "expired",
	): void;
}

type BindingMethods = Pick<
	TokenStore,
	| "putBinding"
	| "getBinding"
	| "listBindings"
	| "renameBinding"
	| "deleteBinding"
	| "getGroupMode"
	| "setGroupMode"
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
	/** The session that started it; `undefined` once that session ended. */
	session: TabSession | undefined;
	addressId: string;
	/** The app the interstitial names: the site's name, else the app id. */
	appName: string;
	/** The network of the session that started it (`networkKey`). */
	network: string;
	redirectUrl: string;
	label: string;
	expiresAt: number;
	/** The cookie set when the browser opened the relay's URL (the flow is visited). */
	cookie?: string;
	/**
	 * The interstitial's single-use token, while it waits for Continue: the
	 * link was opened from another network than the session's.
	 */
	proceed?: string;
}

/**
 * Where a group's calls go (DEC-232): its mode (kept in the store), its pin
 * (in memory: a relay that restarts forgets it, and the next call in mode
 * `pinned` pins again), and when each member last had the focus or came
 * online (the relay's own clock).
 */
interface GroupState {
	mode: GroupMode;
	/** The mode was read from the store (a failed read is tried again). */
	loaded: boolean;
	pin?: GroupPin;
	/** Member id → when one of its windows last gained the focus (mode `front`). */
	readonly focusAt: Map<string, number>;
	/** Member id → when it last came online. */
	readonly onlineAt: Map<string, number>;
	/** Member id → label, as the store last listed them. */
	labels: Map<string, string>;
	/** The member `group.focus` last named, to announce only a change. */
	shownFocus?: string | undefined;
	/** The group's grant ids as last announced, to tell members of a change. */
	grantIds?: string[];
}

/** Where a call without a pin goes now (`target`). */
export interface GroupTarget {
	session: TabSession;
	member: string;
	/**
	 * Why it is not the browser whose window had the focus last: that one
	 * is offline (`offline`, with its label), or no member said (`unknown`).
	 */
	fallback?: { kind: "offline"; label: string } | { kind: "unknown" };
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
	/** Open flows whose link was not opened yet, per network. */
	readonly #unvisited = new Map<string, number>();
	/** The members' sessions that are online, per group. */
	readonly #online = new Map<string, Set<TabSession>>();
	/** Routing state per group (DEC-232); insertion order is last use. */
	readonly #groups = new Map<string, GroupState>();
	/** Requests waiting for a member of a group to come online. */
	readonly #waiters = new Map<string, Set<(stop?: boolean) => void>>();
	/** The last stamp of a member's focus or coming online: the relay's clock, never twice the same. */
	#focusClock = 0;
	readonly #focusPerSession = new RateLimiter({
		capacity: FOCUS_BURST,
		refillPerSecond: FOCUS_PER_SECOND,
		onLimited: () => this.#host.logger.warn("group.focus_limited", {}),
	});
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

	/** The providers, for an AI app's sign-in on the pairing page too (DEC-232). */
	get providers(): ReadonlyMap<SignInProviderId, SignInProvider> {
		return this.#providers;
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

	/**
	 * After `session` was sent: the member is online; its group hears of it.
	 * The binding is read once more first: a member may have removed this
	 * browser while its `hello` was being answered (the read in `attach` may
	 * have come before the removal). Removed meanwhile, it is told so.
	 */
	async connected(session: TabSession): Promise<void> {
		const member = session.member;
		const addressId = session.addressId;
		if (member === undefined || addressId === undefined) return;
		let live: BindingRecord | undefined;
		try {
			live = await this.#host.store.getBinding(addressId, Date.now());
		} catch (error) {
			this.#host.logger.error("store.error", {
				op: "getBinding",
				...errorFields(error),
			});
			return; // unknown: not counted online until it connects again
		}
		if (!session.ready || session.member !== member) return;
		if (!sameMember(live, member)) {
			this.#end(session, "removed");
			return;
		}
		await this.#loadMode(member.group);
		if (!session.ready || session.member !== member) return;
		this.#join(session, member.group);
		void this.#announce(member.group);
	}

	/**
	 * The session ended: its group sees it offline. Its flow goes if nobody
	 * opened the link yet; an opened one stays until it expires, without the
	 * session, so a sign-in that comes back for it goes back to the extension
	 * as failed (and binds nothing) instead of ending on an error page in the
	 * sign-in window. Its completion codes go.
	 */
	released(session: TabSession): void {
		const state = this.#flowOf.get(session);
		this.#flowOf.delete(session);
		const flow = state === undefined ? undefined : this.#flows.get(state);
		if (flow !== undefined) {
			if (flow.cookie === undefined) this.#dropFlow(flow.state);
			else flow.session = undefined;
		}
		for (const [code, completion] of this.#completions) {
			if (completion.flow.session === session) this.#completions.delete(code);
		}
		const group = session.member?.group;
		if (group === undefined) return;
		if (this.#leave(session, group)) void this.#announce(group);
	}

	/**
	 * Whether a session's own binding in the store is still the one it holds:
	 * rename and remove act only for a browser that is still the member it
	 * thinks it is. A stale one is told it was removed.
	 */
	async #stillMember(
		session: TabSession,
		member: Membership,
	): Promise<boolean> {
		const live = await this.#host.store.getBinding(
			session.addressId ?? "",
			Date.now(),
		);
		if (sameMember(live, member)) return true;
		if (session.member === member) this.#end(session, "removed");
		return false;
	}

	#join(session: TabSession, group: string): void {
		const set = this.#online.get(group) ?? new Set();
		set.add(session);
		this.#online.set(group, set);
		const member = session.member?.memberId;
		if (member !== undefined) {
			this.#focusClock = Math.max(Date.now(), this.#focusClock + 1);
			this.#state(group).onlineAt.set(member, this.#focusClock);
		}
		for (const wake of [...(this.#waiters.get(group) ?? [])]) wake();
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
		let grants: GrantInfo[];
		try {
			grants = (
				await this.#host.store.listGrants(groupAddress(group), Date.now())
			).map((g) => ({
				grantId: g.grantId,
				client: {
					id: g.clientId,
					name: g.clientName,
					host: clientHost(g.clientId),
				},
				createdAt: new Date(g.createdAt).toISOString(),
			}));
		} catch (error) {
			this.#host.logger.error("store.error", {
				op: "listGrants",
				...errorFields(error),
			});
			return;
		}
		const sessions = this.onlineMembers(group);
		const online = new Set(sessions.map((s) => s.member?.memberId));
		const members = bindings.map((b) => ({
			id: b.memberId,
			label: b.label,
			online: online.has(b.memberId),
			signedInAt: new Date(b.createdAt).toISOString(),
		}));
		const state = this.#state(group);
		state.labels = new Map(bindings.map((b) => [b.memberId, b.label]));
		state.grantIds = grants.map((g) => g.grantId);
		const focus =
			state.mode === "front" ? this.target(group)?.member : undefined;
		state.shownFocus = focus;
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
				mode: state.mode,
				...(state.mode === "pinned" && state.pin !== undefined
					? { pin: { ...state.pin } }
					: {}),
				...(focus === undefined ? {} : { focus }),
				grants,
			};
			s.send(message);
		}
	}

	// The group's routing (DEC-232)

	/** The group's routing state, made on first use; the least recently used idle ones go. */
	#state(group: string): GroupState {
		let state = this.#groups.get(group);
		if (state === undefined) {
			state = {
				mode: "front",
				loaded: false,
				focusAt: new Map(),
				onlineAt: new Map(),
				labels: new Map(),
			};
			if (this.#groups.size >= MAX_IDLE_GROUPS + this.#online.size) {
				for (const key of this.#groups.keys()) {
					if (this.#online.has(key)) continue;
					this.#groups.delete(key);
					break;
				}
			}
		} else {
			this.#groups.delete(group);
		}
		this.#groups.set(group, state);
		return state;
	}

	/** Read the group's mode from the store once; a failure leaves `front` and is tried again. */
	async #loadMode(group: string): Promise<void> {
		const state = this.#state(group);
		if (state.loaded) return;
		try {
			const mode = await this.#host.store.getGroupMode(group);
			if (state.loaded) return; // set meanwhile
			state.loaded = true;
			if (mode !== undefined) state.mode = mode;
		} catch (error) {
			this.#host.logger.error("store.error", {
				op: "getGroupMode",
				...errorFields(error),
			});
		}
	}

	/** The members of a group online now, oldest session first. */
	onlineMembers(group: string): TabSession[] {
		return [...(this.#online.get(group) ?? [])].filter(
			(s) => s.ready && s.member?.group === group,
		);
	}

	/** The session of one member of a group, if it is online. */
	memberSession(group: string, member: string): TabSession | undefined {
		return this.onlineMembers(group).find((s) => s.member?.memberId === member);
	}

	/**
	 * The group's members and their labels, as the store lists them (the
	 * last announcement's while a member is online, else read now).
	 */
	async labels(group: string): Promise<Map<string, string>> {
		const state = this.#state(group);
		if (state.labels.size > 0 && this.#online.has(group)) return state.labels;
		const bindings = await this.#host.store.listBindings(group, Date.now());
		state.labels = new Map(bindings.map((b) => [b.memberId, b.label]));
		return state.labels;
	}

	/** The group's mode and pin now (the mode read from the store first). */
	async routing(group: string): Promise<{ mode: GroupMode; pin?: GroupPin }> {
		await this.#loadMode(group);
		const state = this.#state(group);
		return state.mode === "pinned" && state.pin !== undefined
			? { mode: state.mode, pin: { ...state.pin } }
			: { mode: state.mode };
	}

	/**
	 * Where a call without a pin goes: the online member whose window had
	 * the focus last; without one, the member that came online last, with
	 * the reason. `undefined` when no member is online.
	 */
	target(group: string): GroupTarget | undefined {
		const sessions = this.onlineMembers(group);
		const first = sessions[0];
		if (first === undefined) return undefined;
		const state = this.#state(group);
		let focused: string | undefined;
		let at = Number.NEGATIVE_INFINITY;
		for (const [member, t] of state.focusAt) {
			if (t > at) {
				at = t;
				focused = member;
			}
		}
		const session = sessions.find((s) => s.member?.memberId === focused);
		if (session !== undefined && focused !== undefined) {
			return { session, member: focused };
		}
		const since = (s: TabSession) =>
			state.onlineAt.get(s.member?.memberId ?? "") ?? 0;
		let latest = first;
		for (const s of sessions) if (since(s) >= since(latest)) latest = s;
		return {
			session: latest,
			member: latest.member?.memberId ?? "",
			fallback:
				focused === undefined
					? { kind: "unknown" }
					: {
							kind: "offline",
							label: state.labels.get(focused) ?? DEFAULT_LABEL,
						},
		};
	}

	/**
	 * Wait until a member of the group (that member, if named) is online,
	 * up to `ms`; false if it did not come or the request was aborted.
	 */
	waitForMember(
		group: string,
		member: string | undefined,
		signal: AbortSignal,
		ms: number,
	): Promise<boolean> {
		const here = () =>
			member === undefined
				? this.onlineMembers(group).length > 0
				: this.memberSession(group, member) !== undefined;
		if (here()) return Promise.resolve(true);
		if (ms <= 0 || signal.aborted) return Promise.resolve(false);
		const set = this.#waiters.get(group) ?? new Set<(stop?: boolean) => void>();
		// A waiting request holds its body and a socket, as one waiting for a
		// page: at most so many per group, and the relay's session cap in all.
		if (
			set.size >= MAX_WAITING_PER_GROUP ||
			this.waitingCount >= this.#host.config.maxSessions
		) {
			return Promise.resolve(false);
		}
		return new Promise((resolve) => {
			let timer: Timer | undefined;
			const done = (found: boolean) => {
				clearTimeout(timer);
				signal.removeEventListener("abort", onAbort);
				set.delete(wake);
				if (set.size === 0 && this.#waiters.get(group) === set) {
					this.#waiters.delete(group);
				}
				resolve(found);
			};
			const wake = (stop = false) => {
				if (stop || here()) done(!stop && here());
			};
			const onAbort = () => done(false);
			set.add(wake);
			this.#waiters.set(group, set);
			timer = setTimeout(() => done(false), ms);
			signal.addEventListener("abort", onAbort, { once: true });
		});
	}

	/** Requests waiting for a member of a group, in all. */
	get waitingCount(): number {
		let n = 0;
		for (const set of this.#waiters.values()) n += set.size;
		return n;
	}

	/** End every wait for a group's member (the relay stops). */
	wakeAll(): void {
		for (const set of [...this.#waiters.values()]) {
			for (const wake of [...set]) wake(true);
		}
	}

	/**
	 * Pin a member's tab for the group and switch it to mode `pinned`: an
	 * AI app's `use_tab` that the member answered without an error, or the
	 * member's own `group.pin`. Every member hears of it. The mode is saved;
	 * if that fails, it holds in memory until the relay restarts.
	 */
	async pin(group: string, member: string, tab: string): Promise<void> {
		const state = this.#state(group);
		const changed = state.mode !== "pinned";
		state.mode = "pinned";
		state.pin = { member, tab };
		state.loaded = true;
		if (changed) {
			try {
				await this.#host.store.setGroupMode(group, "pinned");
			} catch (error) {
				this.#host.logger.error("store.error", {
					op: "setGroupMode",
					...errorFields(error),
				});
			}
		}
		this.#host.logger.info("group.pinned", { modeChanged: changed });
		await this.#announce(group);
	}

	/** `group.mode`: any member sets the mode; `front` drops the pin. */
	async setMode(session: TabSession, mode: GroupMode): Promise<void> {
		const member = session.member;
		const about = { type: "group.mode" as const, mode };
		if (member === undefined) {
			session.refused("unknown_id", "this browser is not signed in", about);
			return;
		}
		try {
			await this.#host.store.setGroupMode(member.group, mode);
		} catch (error) {
			this.#host.logger.error("store.error", {
				op: "setGroupMode",
				...errorFields(error),
			});
			session.refused("store_unavailable", STORE_TEXT, about);
			return;
		}
		const state = this.#state(member.group);
		state.loaded = true;
		state.mode = mode;
		if (mode === "front") delete state.pin;
		this.#host.logger.info("group.mode", {
			address: shortAddress(session.addressId ?? ""),
			mode,
		});
		await this.#announce(member.group);
	}

	/** `group.pin`: a member pins one of its own tabs ("Work here"). */
	async pinHere(session: TabSession, tab: string): Promise<void> {
		const member = session.member;
		if (member === undefined) {
			session.refused("unknown_id", "this browser is not signed in", {
				type: "group.pin",
				tab,
			});
			return;
		}
		await this.pin(member.group, member.memberId, tab);
	}

	/**
	 * `focus`: one of the member's windows gained the focus. Only in mode
	 * `front` (members send it only then; in mode `pinned` the relay does
	 * not want to know), stamped with the relay's clock. A change of the
	 * member that calls go to is announced.
	 */
	focus(session: TabSession): void {
		const member = session.member;
		if (member === undefined) return;
		const state = this.#state(member.group);
		if (state.mode !== "front") return;
		if (!this.#focusPerSession.take(session.sessionId)) return;
		// The relay's clock, strictly increasing: two in one millisecond
		// keep their order.
		this.#focusClock = Math.max(Date.now(), this.#focusClock + 1);
		state.focusAt.set(member.memberId, this.#focusClock);
		const now = this.target(member.group)?.member;
		if (now !== state.shownFocus) void this.#announce(member.group);
	}

	/** `group.grant.revoke`: any member disconnects an AI app from the whole group. */
	async revokeGroupGrant(session: TabSession, grantId: string): Promise<void> {
		const member = session.member;
		const about = { type: "group.grant.revoke" as const, grantId };
		if (member === undefined) {
			session.refused("unknown_id", "this browser is not signed in", about);
			return;
		}
		const address = groupAddress(member.group);
		const now = Date.now();
		try {
			const grants = await this.#host.store.listGrants(address, now);
			if (!grants.some((g) => g.grantId === grantId)) {
				session.refused("unknown_id", "unknown grant", about);
				return;
			}
			await this.#host.store.revoke(
				{ grantId },
				{ now, keepUntil: now + this.#host.config.grantLifetimeMs },
			);
		} catch (error) {
			this.#host.logger.error("store.error", {
				op: "revokeGroupGrant",
				...errorFields(error),
			});
			session.refused(
				"store_unavailable",
				"the relay cannot change grants right now; try again shortly",
				about,
			);
			return;
		}
		this.#host.logger.info("oauth.revoked", {
			address: shortAddress(address),
			by: "member",
		});
		this.#host.groupGrantRemoved(member.group, grantId, "revoked");
	}

	/** A group's grants changed (one added or removed): its members hear of it. */
	grantsChanged(group: string): void {
		if (this.#online.has(group)) void this.#announce(group);
	}

	/**
	 * The sweep's part for group grants: a grant whose tokens all ran out
	 * ends for the group, with its requests in flight, and the members get
	 * `group` without it.
	 */
	async sweepGroupGrants(now: number): Promise<void> {
		for (const group of [...this.#online.keys()]) {
			const known = this.#groups.get(group)?.grantIds;
			if (known === undefined || known.length === 0) continue;
			const live = new Set(
				(await this.#host.store.listGrants(groupAddress(group), now)).map(
					(g) => g.grantId,
				),
			);
			for (const grantId of known) {
				if (!live.has(grantId)) {
					this.#host.groupGrantRemoved(group, grantId, "expired");
				}
			}
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
		const network = networkKey(session.ip);
		if (
			!this.#startsPerSession.take(session.sessionId) ||
			!this.#startsPerNetwork.take(network)
		) {
			return failed("rate_limited");
		}
		this.#sweep(Date.now());
		const previous = this.#flowOf.get(session);
		if (previous !== undefined) this.#dropFlow(previous);
		// Flows nobody opened yet, per network: filling the relay's flows
		// takes opening each link, not only asking for it.
		if ((this.#unvisited.get(network) ?? 0) >= MAX_UNVISITED_PER_NETWORK) {
			this.#limited("signin_unvisited", network);
			return failed("rate_limited");
		}
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
			appName: session.appName ?? session.app ?? "",
			network,
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
		const replaced = this.#flowOf.get(session);
		if (replaced !== undefined) this.#dropFlow(replaced);
		this.#flows.set(flow.state, flow);
		this.#starts.set(flow.start, flow.state);
		this.#flowOf.set(session, flow.state);
		this.#unvisited.set(network, (this.#unvisited.get(network) ?? 0) + 1);
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
			if (!(await this.#stillMember(session, member))) {
				session.refused("unknown_id", "this browser is not signed in", about);
				return;
			}
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
			if (!(await this.#stillMember(session, member))) {
				session.refused("unknown_id", "this browser is not signed in", about);
				return;
			}
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
	 * the flow's cookie. Opened from the network of the session that asked
	 * for it, it sends the browser on to the provider. From another network
	 * it first shows a page that says who asked and warns, with Continue and
	 * Cancel (`proceed`): someone may have sent the user their own link.
	 */
	visit(req: Request, ip: string): Response {
		const network = networkKey(ip);
		if (!this.#viewsPerNetwork.take(network)) {
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
		this.#visited(flow);
		const secure = this.#host.publicUrl().startsWith("https:");
		const maxAge = Math.max(1, Math.ceil((flow.expiresAt - Date.now()) / 1000));
		const cookie = `${cookieName(flow, secure)}=${flow.cookie}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;
		const same = network === flow.network;
		this.#host.logger.info("signin.opened", {
			address: shortAddress(flow.addressId),
			network: same ? "same" : "different",
		});
		if (same) {
			return new Response(null, {
				status: 302,
				headers: {
					location: flow.authorizationUrl,
					"cache-control": "no-store",
					"referrer-policy": "no-referrer",
					"set-cookie": cookie,
				},
			});
		}
		flow.proceed = randomBase64url(24);
		const headers = pageHeaders({
			formAction: ["'self'", ...originList(flow.authorizationUrl)],
		});
		headers.append("set-cookie", cookie);
		return new Response(
			renderPage(
				"Sign in",
				`<h1>Sign in with ${escapeHtml(flow.provider.name)}?</h1>
<p>A browser asks to sign in with ${escapeHtml(flow.provider.name)} and to join the browsers of your account as <strong>“${escapeHtml(flow.label)}”</strong> (${escapeHtml(flow.appName)}). This link was opened on another network than that browser's.</p>
<p class="error">Only continue if you started this yourself in the tab-mcp panel of that browser.</p>
<p>After the sign-in, never paste or send the address you land on to anyone. It would let them sign in as you.</p>
<form method="post" action="/signin">
<input type="hidden" name="flow" value="${escapeHtml(flow.start)}">
<input type="hidden" name="proceed" value="${escapeHtml(flow.proceed)}">
<div class="actions"><button type="submit" class="primary" name="action" value="continue">Continue</button>
<button type="submit" class="secondary" name="action" value="cancel">Cancel</button></div>
</form>`,
			),
			{ status: 200, headers },
		);
	}

	/**
	 * POST `/signin`: Continue or Cancel on the page that `visit` showed.
	 * Needs the flow's cookie and the page's single-use token, so no link
	 * alone can go past the page. Continue goes on to the provider; Cancel
	 * ends the flow and goes back to the extension (`signin_error=cancelled`).
	 */
	async proceed(req: Request, ip: string): Promise<Response> {
		if (!this.#viewsPerNetwork.take(networkKey(ip))) {
			return this.#page(
				429,
				"Too many requests from your network. Wait a minute and try again.",
			);
		}
		const origin = req.headers.get("origin");
		if (origin !== null && origin !== this.#host.publicUrl()) {
			return this.#page(403, "This form was sent from another site.");
		}
		const read = await readBodyWithDeadline(
			req,
			MAX_FORM_BYTES,
			this.#host.config.bodyTimeoutMs,
		);
		if (!read.ok) return this.#page(400, "The form could not be read.");
		const form = new URLSearchParams(new TextDecoder().decode(read.bytes));
		this.#sweep(Date.now());
		const state = this.#starts.get(form.get("flow") ?? "");
		const flow = state === undefined ? undefined : this.#flows.get(state);
		const token = form.get("proceed") ?? "";
		const secure = this.#host.publicUrl().startsWith("https:");
		const sent =
			flow === undefined
				? undefined
				: cookieValue(req, cookieName(flow, secure));
		if (
			flow === undefined ||
			flow.proceed === undefined ||
			flow.cookie === undefined ||
			sent === undefined ||
			!constantTimeEqual(sent, flow.cookie) ||
			!constantTimeEqual(token, flow.proceed)
		) {
			return this.#page(
				400,
				"This sign-in has expired or was already used. Start it again in your browser extension.",
			);
		}
		delete flow.proceed; // single use
		if (form.get("action") !== "continue") {
			this.#dropFlow(flow.state);
			this.#host.logger.info("signin.failed", {
				address: shortAddress(flow.addressId),
				reason: "cancelled",
				provider: flow.provider.id,
			});
			return this.#backToExtension(flow, { signin_error: "cancelled" }, 303);
		}
		return new Response(null, {
			status: 303,
			headers: {
				location: flow.authorizationUrl,
				"cache-control": "no-store",
				"referrer-policy": "no-referrer",
			},
		});
	}

	/** The flow's link was opened: it no longer counts as unvisited. */
	#visited(flow: Flow): void {
		const n = (this.#unvisited.get(flow.network) ?? 1) - 1;
		if (n <= 0) this.#unvisited.delete(flow.network);
		else this.#unvisited.set(flow.network, n);
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
		// A flow still waiting for Continue on its page has not been sent on.
		if (
			flow === undefined ||
			flow.expiresAt <= Date.now() ||
			flow.proceed !== undefined
		) {
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
			// Where the sign-in came back from, against the session's network.
			network: networkKey(ip) === flow.network ? "same" : "different",
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
		await this.#bind(session, completion.flow, completion.account);
	}

	/** The flow's session still holds its address: a sign-in for it may bind. */
	#current(flow: Flow): boolean {
		const session = flow.session;
		return (
			session !== undefined &&
			session.ready &&
			this.#host.sessionOf(flow.addressId) === session
		);
	}

	/** Bind the flow's address to the account; tell the session and the groups. */
	async #bind(
		session: TabSession,
		flow: Flow,
		account: SignInAccount,
	): Promise<boolean> {
		const { provider, addressId } = flow;
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
		await this.#loadMode(record.group);
		if (!session.ready || session.member?.group !== record.group) return true;
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
		status = 302,
	): Response {
		const url = new URL(flow.redirectUrl);
		for (const [k, v] of Object.entries(param)) url.searchParams.set(k, v);
		return new Response(null, {
			status,
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
		if (flow.cookie === undefined) this.#visited(flow);
		const session = flow.session;
		if (session !== undefined && this.#flowOf.get(session) === state) {
			this.#flowOf.delete(session);
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
		this.#focusPerSession.sweep(now);
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

/** Whether the store's binding is the member a session holds. */
function sameMember(
	live: BindingRecord | undefined,
	member: Membership,
): boolean {
	return (
		live !== undefined &&
		live.group === member.group &&
		live.memberId === member.memberId
	);
}

/** The origin of a URL, as a list for a CSP source list (empty if it is no URL). */
function originList(url: string): string[] {
	try {
		return [new URL(url).origin];
	} catch {
		return [];
	}
}

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
