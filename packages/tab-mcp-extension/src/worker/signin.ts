/**
 * This browser signed in at the relay, and its group (iteration 53,
 * DEC-231 to DEC-233): every browser signed in with the same account at
 * Google, Microsoft or GitHub is a member of one group, and an AI app
 * connected to the group reaches all of them. The relay's side is
 * `docs/protocol.md`, "Browser sign-in" and "Group grants"; it speaks of it
 * only to a session whose `hello` named `signin.v1`, and a relay that does
 * not offer it (an older or a self-hosted one) gets nothing new from here.
 *
 * The sign-in runs in `identity.launchWebAuthFlow` at the relay's own URL,
 * the relay being the only OAuth client at the providers; the code the
 * flow's last address carries (`?signin=`) goes back over the WebSocket of
 * the session that started it, and only then is the browser bound.
 *
 * What the extension keeps (in the worker's IndexedDB, `kv.ts`): the
 * provider, the name to show ("Signed in as …") and, for Microsoft, whether
 * the account is personal or a work or school one, which the relay sends
 * once and keeps nowhere; and the ids of the group's members it has seen,
 * so that a browser that joins while this one was off is announced too.
 * None of it is sent anywhere. While signed in, the group's mode and pin
 * (the relay's record) are where calls go (`TargetStore`), not the
 * browser's own setting.
 */

import type { GrantView } from "../protocol.ts";
import type { Kv } from "./kv.ts";
import type { TargetSetting, TargetStore } from "./targets.ts";

/** What `hello.capabilities` names for this module's messages. */
export const SIGN_IN_CAPABILITY = "signin.v1";

/** A provider the relay offers, in the order to show them. */
export interface Provider {
	id: string;
	name: string;
}

/** A Microsoft account: personal, or work or school. */
export type AccountKind = "personal" | "work";

/** What the extension keeps of its sign-in. */
export interface Account {
	provider: string;
	providerName: string;
	/** What "Signed in as …" shows: Google's address, Microsoft's user name, GitHub's login. */
	displayName: string;
	kind?: AccountKind;
}

/** A member of the group, as the relay lists it. */
export interface GroupMember {
	id: string;
	label: string;
	online: boolean;
}

/** The group's state, from the relay's `group` message. */
export interface GroupRecord {
	/** This browser's member id. */
	self: string;
	members: GroupMember[];
	maxMembers: number;
	mode: "front" | "pinned";
	/** The pinned tab: a member's, its own tab id (decimal). */
	pin?: { member: string; tab: string };
	/** In mode "front": the member calls without `tab` go to now. */
	focus?: string;
	/** The AI apps connected to the whole group. */
	grants: GrantView[];
}

/** What the panel shows of it. */
export interface SignInView {
	/** The providers to sign in with, while connected to a relay that offers them. */
	providers: Provider[];
	/** Connected: sign-in, sign-out and the group's controls work. */
	connected: boolean;
	account?: Omit<Account, "provider">;
	/** The group's members, while connected and signed in. */
	members?: (GroupMember & { self: boolean })[];
	maxMembers?: number;
	/** The AI apps connected to every browser of the group. */
	grants?: GrantView[];
	/** A sign-in with this provider (its name) is under way. */
	pending?: string;
	problem?: string;
	/** A browser joined, or this one's sign-in ended. */
	notice?: string;
}

/** `identity.launchWebAuthFlow` and its redirect address. */
export interface AuthFlow {
	/** `identity.getRedirectURL()`: `https://<id>.chromiumapp.org/`, Firefox `https://<hash>.extensions.allizom.org/`. */
	redirectUrl(): string;
	/** The flow, interactive, from `url`; resolves with the address it ended at. */
	launch(url: string): Promise<string | undefined>;
}

/** What the sign-in needs from the connection and the browser. */
export interface SignInHost {
	/** Send a message on the session now; `false` when not connected. */
	send(message: { type: string } & Record<string, unknown>): boolean;
	auth: AuthFlow;
	/** The label a new member gets: "Chrome on macOS". */
	label(): Promise<string>;
	/** The relay's own origin (`https://relay.example`), which the sign-in URL must have. */
	relayOrigin(): string | undefined;
	/** A notification of the system. */
	notify(id: string, title: string, message: string): void;
	/** Something the panel shows changed. */
	changed(): void;
	/** Where calls go may have changed: the mode, the pin, or which store holds them. */
	targetsChanged(): void;
	/** Only what the panel's target line names changed: the focus, a label. */
	targetShown(): void;
	/** Whether a window of this browser has the focus now. */
	focusedHere(): Promise<boolean>;
}

/** The prefix of a "browser joined" notification's id. */
export const JOINED_PREFIX = "joined:";

/** A Microsoft sign-in refused until the user's company approves the app. */
export const ADMIN_APPROVAL =
	"Your organisation's administrator has to approve tab-mcp relay first.";

/** Microsoft's codes for "an administrator has to consent" (Entra ID). */
const ADMIN_CODES = /\bAADSTS(65001|90094|90095)\b/;

/** What changing the group's setting says while not connected. */
export const SETTING_WHILE_DOWN =
	"Turn on AI access to change where AI apps work: while signed in, it is the setting of all your browsers.";

/** How long a call waits for the group's state after the session came. */
const GROUP_WAIT_MS = 2_000;

const ACCOUNT = "signInAccount";
const KNOWN = "signInKnown";

const NAMES: Readonly<Record<string, string>> = {
	google: "Google",
	microsoft: "Microsoft",
	github: "GitHub",
};

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json =>
	typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): v is string => typeof v === "string";
/** A provider's id or a member's: short, plain characters only. */
const isId = (v: unknown): v is string =>
	str(v) && /^[A-Za-z0-9_-]{1,64}$/.test(v);
/** Text from the relay for the panel: cut, on one line. */
const text = (v: string, max: number) =>
	v.replace(/[\p{Cc}\p{Cf}]/gu, "").slice(0, max);

/** `session.signIn`, checked: the providers and this browser's member id. */
export function parseSessionSignIn(
	v: unknown,
): { providers: Provider[]; member?: string } | undefined {
	if (!isObject(v) || !Array.isArray(v["providers"])) return undefined;
	const providers = v["providers"]
		.filter(
			(p): p is { id: string; name: string } =>
				isObject(p) && isId(p["id"]) && str(p["name"]),
		)
		.slice(0, 8)
		.map((p) => ({ id: p.id, name: text(p.name, 32) || p.id }));
	return isId(v["member"]) ? { providers, member: v["member"] } : { providers };
}

function parseGrant(v: unknown): GrantView | undefined {
	if (!isObject(v) || !str(v["grantId"]) || !isObject(v["client"]))
		return undefined;
	const { name, host } = v["client"];
	return str(host)
		? {
				grantId: v["grantId"],
				name: str(name) ? text(name, 64) : "",
				host: text(host, 253),
			}
		: undefined;
}

/** The relay's `group` message, checked; `undefined` if it is not one. */
export function parseGroup(m: Json): GroupRecord | undefined {
	const { self, members, mode, pin, focus, grants, maxMembers } = m;
	if (!isId(self) || !Array.isArray(members)) return undefined;
	const listed = members
		.filter(
			(x): x is { id: string; label: string; online: boolean } =>
				isObject(x) &&
				isId(x["id"]) &&
				str(x["label"]) &&
				typeof x["online"] === "boolean",
		)
		.slice(0, 64)
		.map((x) => ({
			id: x.id,
			label: text(x.label, 64) || "Browser",
			online: x.online,
		}));
	const record: GroupRecord = {
		self,
		members: listed,
		maxMembers:
			typeof maxMembers === "number" && Number.isSafeInteger(maxMembers)
				? maxMembers
				: 16,
		// Anything but "pinned" is the tab in front, the relay's default.
		mode: mode === "pinned" ? "pinned" : "front",
		grants: Array.isArray(grants)
			? grants.flatMap((g) => parseGrant(g) ?? [])
			: [],
	};
	if (
		record.mode === "pinned" &&
		isObject(pin) &&
		isId(pin["member"]) &&
		str(pin["tab"]) &&
		/^\d{1,15}$/.test(pin["tab"])
	)
		record.pin = { member: pin["member"], tab: pin["tab"] };
	if (record.mode === "front" && isId(focus)) record.focus = focus;
	return record;
}

/** A stored account, checked. */
function parseAccount(v: unknown): Account | undefined {
	if (
		!isObject(v) ||
		!isId(v["provider"]) ||
		!str(v["providerName"]) ||
		!str(v["displayName"])
	)
		return undefined;
	const account: Account = {
		provider: v["provider"],
		providerName: v["providerName"],
		displayName: v["displayName"],
	};
	if (v["kind"] === "personal" || v["kind"] === "work")
		account.kind = v["kind"];
	return account;
}

/** Why a sign-in failed (`signin.failed`), in the panel's words. */
export function failedText(reason: string, provider: string): string {
	switch (reason) {
		case "not_offered":
			return `This relay does not offer sign-in with ${provider}.`;
		case "bad_redirect":
			return "The relay refused this browser's sign-in.";
		case "rate_limited":
			return "Too many sign-ins from here. Wait a minute, then try again.";
		case "busy":
			return "The relay is busy. Try again in a minute.";
		case "provider_unavailable":
			return `The relay cannot reach ${provider} now. Try again later.`;
		case "code_refused":
			return "The sign-in took too long or was already used. Sign in again.";
		case "group_full":
			return "Your account has as many browsers signed in as it may have. Remove one first, in this panel of another of your browsers.";
		case "store_unavailable":
			return "The relay cannot save the sign-in now. Try again shortly.";
		default:
			return "The relay did not sign this browser in. Try again.";
	}
}

/**
 * Why a sign-in came back without a code (`?signin_error=`), in the
 * panel's words. A Microsoft work account whose company did not let its
 * users consent to the app: the provider's code says so (a relay may pass
 * it on), or the relay's `admin_approval`; without either, the panel says
 * that it may be the reason.
 */
export function redirectErrorText(
	reason: string,
	provider: Provider,
	params: URLSearchParams,
): string {
	const details = [...params.values()].join(" ");
	if (reason === "admin_approval" || ADMIN_CODES.test(details))
		return ADMIN_APPROVAL;
	switch (reason) {
		case "provider_error":
			return provider.id === "microsoft"
				? `${provider.name} did not sign you in: cancelled or refused. With a work or school account, your organisation's administrator may have to approve tab-mcp relay first.`
				: `${provider.name} did not sign you in: cancelled or refused.`;
		case "unchecked":
			return `The relay could not check the sign-in with ${provider.name}. Try again.`;
		case "session_gone":
			return "The connection to the relay was renewed during the sign-in. Sign in again.";
		case "cancelled":
			return "The sign-in was cancelled.";
		default:
			return "The sign-in did not finish. Try again.";
	}
}

/** Why a message about the group was refused (`error` with `for`), in the panel's words. */
function refusedText(code: string, about: string): string | undefined {
	if (code === "store_unavailable")
		return "The relay cannot save the change now. Try again shortly.";
	if (code !== "unknown_id") return undefined;
	switch (about) {
		case "member.rename":
		case "member.remove":
			return "That browser is no longer signed in with your account.";
		case "group.grant.revoke":
			// Gone already: the next `group` lists the grants as they are.
			return undefined;
		default:
			return "This browser is not signed in at the relay any more. Sign in again.";
	}
}

/** The messages whose refusals are this module's (`error` with `for`). */
export const SIGN_IN_MESSAGES: ReadonlySet<string> = new Set([
	"signin.out",
	"member.rename",
	"member.remove",
	"group.mode",
	"group.pin",
	"group.grant.revoke",
]);

const quoted = (label: string) => `“${label}”`;

/** What the worker keeps of the sign-in between its starts. */
export interface StoredSignIn {
	account?: Account;
	known?: { self: string; members: string[] };
}

export class SignIn {
	readonly #kv: Kv;
	readonly #host: SignInHost;
	#account: Account | undefined;
	/** The members seen last, for the announcement of new ones. */
	#known: { self: string; members: string[] } | undefined;
	/** This session's: the providers offered (none: not offered, or not connected). */
	#providers: Provider[] | undefined;
	/** This session's member id: signed in. */
	#member: string | undefined;
	#group: GroupRecord | undefined;
	#connected = false;
	#pending: Provider | undefined;
	#problem: string | undefined;
	#notice: string | undefined;
	/** Settles with the session's first `group`. */
	#groupWait: { promise: Promise<void>; resolve: () => void } | undefined;
	/** The flow that runs (a newer start makes the one before count for nothing). */
	#flow = 0;
	/** This start's `signin.url` came: one per start. */
	#urlTaken = false;
	/** Messages to the relay, one after the other: the account's writes keep their order. */
	#queue: Promise<unknown> = Promise.resolve();

	/** `stored`: what `SignIn.stored()` read at the worker's start. */
	constructor(kv: Kv, host: SignInHost, stored: StoredSignIn = {}) {
		this.#kv = kv;
		this.#host = host;
		this.#account = stored.account;
		this.#known = stored.known;
	}

	/** What the worker kept of the sign-in, read from `kv`. */
	static async stored(kv: Kv): Promise<StoredSignIn> {
		const [account, known] = await Promise.all([
			kv.get(ACCOUNT),
			kv.get(KNOWN),
		]);
		const stored: StoredSignIn = {};
		const parsed = parseAccount(account);
		if (parsed !== undefined) stored.account = parsed;
		if (
			isObject(known) &&
			isId(known["self"]) &&
			Array.isArray(known["members"]) &&
			known["members"].every(isId)
		)
			stored.known = {
				self: known["self"],
				members: [...(known["members"] as string[])],
			};
		return stored;
	}

	/**
	 * Signed in: in this session (the relay said so), or, while not
	 * connected, as last known. The group's record is then where calls go.
	 */
	get active(): boolean {
		return this.#connected
			? this.#member !== undefined
			: this.#account !== undefined;
	}

	/** The group as last told, while signed in. */
	get group(): GroupRecord | undefined {
		return this.active ? this.#group : undefined;
	}

	/** A message from the relay (`relayMessages.receive`). */
	receive(m: Readonly<Json>): void {
		switch (m["type"]) {
			case "session":
				this.#session(m);
				return;
			case "signin.url":
				this.#url(m);
				return;
			case "signin.done":
				this.#run(() => this.#done(m));
				return;
			case "signin.failed": {
				const provider = this.#pending?.name ?? "the provider";
				this.#pending = undefined;
				this.#problem = failedText(
					str(m["reason"]) ? m["reason"] : "",
					provider,
				);
				this.#host.changed();
				return;
			}
			case "signin.ended":
				this.#run(() => this.#ended(str(m["reason"]) ? m["reason"] : ""));
				return;
			case "group":
				this.#run(() => this.#groupMessage(m));
				return;
		}
	}

	/**
	 * The relay refused a message of this module (`error` with `for`):
	 * whether it was one, and the panel says why.
	 */
	refused(about: string, code: string): boolean {
		if (!SIGN_IN_MESSAGES.has(about)) return false;
		const why = refusedText(code, about);
		if (why !== undefined) {
			this.#problem = why;
			this.#host.changed();
		}
		return true;
	}

	/** The session ended (or is not there yet). */
	disconnected(): void {
		const was = this.active;
		this.#connected = false;
		this.#providers = undefined;
		this.#member = undefined;
		this.#pending = undefined;
		this.#flow++;
		this.#groupWait?.resolve();
		this.#groupWait = undefined;
		// A kept sign-in: the setting is loaded again from what is known.
		if (this.active !== was || this.#account !== undefined)
			this.#host.targetsChanged();
		this.#host.changed();
	}

	/** Another relay: its sign-in is its own, nothing of this one's counts there. */
	async reset(): Promise<void> {
		this.disconnected();
		this.#problem = undefined;
		this.#notice = undefined;
		await this.#forget();
		this.#host.targetsChanged();
	}

	#session(m: Readonly<Json>): void {
		const was = this.active;
		const signIn = parseSessionSignIn(m["signIn"]);
		this.#connected = true;
		this.#providers = signIn?.providers;
		this.#member = signIn?.member;
		this.#group = undefined;
		if (this.#member !== undefined) {
			let resolve = () => {};
			const promise = new Promise<void>((r) => {
				resolve = r;
			});
			this.#groupWait = { promise, resolve };
		} else if (signIn === undefined && this.#account !== undefined) {
			// A relay that offers no sign-in: what was kept goes. Without a
			// member (the relay could not read the binding, say) it is kept,
			// unused and not shown, until `signin.ended` says it is over.
			this.#run(() => this.#forget());
		}
		// Signed in: a setting loaded before this session (after a worker
		// restart, the default) is not used; the next call waits for `group`.
		if (this.#member !== undefined || this.active !== was)
			this.#host.targetsChanged();
		this.#host.changed();
	}

	// --- Signing in and out ---

	/** "Sign in with <provider>": the relay's URL, then the browser's flow. */
	async start(provider: string): Promise<void> {
		const offered = this.#providers?.find((p) => p.id === provider);
		if (offered === undefined || this.#member !== undefined) return;
		this.#problem = undefined;
		this.#notice = undefined;
		this.#pending = offered;
		this.#urlTaken = false;
		this.#flow++;
		this.#host.changed();
		const sent = this.#host.send({
			type: "signin.start",
			provider,
			redirectUrl: this.#host.auth.redirectUrl(),
			label: await this.#host.label(),
		});
		if (!sent) {
			this.#pending = undefined;
			this.#problem = "Turn on AI access to sign in.";
			this.#host.changed();
		}
	}

	#url(m: Readonly<Json>): void {
		const provider = this.#pending;
		// One per start; none without one.
		if (provider === undefined || this.#urlTaken) return;
		this.#urlTaken = true;
		const url = m["url"];
		let start: URL | undefined;
		try {
			start = str(url) ? new URL(url) : undefined;
		} catch {
			start = undefined;
		}
		if (start === undefined || m["provider"] !== provider.id) {
			this.#fail(
				"The relay's answer to the sign-in could not be used. Try again.",
			);
			return;
		}
		// The relay's own page, nothing else.
		if (start.origin !== this.#host.relayOrigin()) {
			this.#fail("The relay sent a sign-in address that is not its own.");
			return;
		}
		const flow = this.#flow;
		const redirect = this.#host.auth.redirectUrl();
		this.#host.auth.launch(start.href).then(
			(back) => {
				if (flow !== this.#flow) return;
				this.#returned(back, redirect, provider);
			},
			() => {
				if (flow !== this.#flow) return;
				this.#fail(
					"The sign-in window was closed before the sign-in finished.",
				);
			},
		);
	}

	/** The address the flow ended at: the code to complete with, or why not. */
	#returned(
		back: string | undefined,
		redirect: string,
		provider: Provider,
	): void {
		let url: URL;
		try {
			url = new URL(back ?? "");
		} catch {
			this.#fail("The sign-in did not finish. Try again.");
			return;
		}
		if (url.origin !== new URL(redirect).origin) {
			this.#fail("The sign-in did not finish. Try again.");
			return;
		}
		const code = url.searchParams.get("signin");
		const error = url.searchParams.get("signin_error");
		if (code !== null && code !== "" && error === null) {
			if (!this.#host.send({ type: "signin.complete", code }))
				this.#fail(
					"The connection to the relay was lost during the sign-in. Sign in again.",
				);
			return;
		}
		this.#fail(redirectErrorText(error ?? "", provider, url.searchParams));
	}

	#fail(problem: string): void {
		this.#pending = undefined;
		this.#problem = problem;
		this.#host.changed();
	}

	async #done(m: Readonly<Json>): Promise<void> {
		const provider = m["provider"];
		const displayName = m["displayName"];
		const member = m["member"];
		if (!isId(provider) || !str(displayName) || !isId(member)) return;
		const was = this.active;
		const account: Account = {
			provider,
			providerName:
				this.#providers?.find((p) => p.id === provider)?.name ??
				NAMES[provider] ??
				provider,
			displayName: text(displayName, 256),
		};
		if (m["kind"] === "personal" || m["kind"] === "work")
			account.kind = m["kind"];
		this.#account = account;
		this.#member = member;
		this.#pending = undefined;
		this.#problem = undefined;
		// The members there now are not news: only those that come later.
		this.#known = undefined;
		this.#group = undefined;
		let resolve = () => {};
		const promise = new Promise<void>((r) => {
			resolve = r;
		});
		this.#groupWait = { promise, resolve };
		await this.#kv.set({ [ACCOUNT]: account });
		await this.#kv.remove(KNOWN);
		if (this.active !== was) this.#host.targetsChanged();
		this.#host.changed();
	}

	async #ended(reason: string): Promise<void> {
		const was = this.active;
		this.#member = undefined;
		await this.#forget();
		this.#notice =
			reason === "removed"
				? "Another of your browsers removed this one: it is no longer signed in."
				: reason === "expired"
					? "The sign-in ended after 90 days. Sign in again to keep this browser with your others."
					: undefined;
		if (this.active !== was) this.#host.targetsChanged();
		this.#host.changed();
	}

	async #forget(): Promise<void> {
		this.#account = undefined;
		this.#known = undefined;
		this.#group = undefined;
		await this.#kv.remove(ACCOUNT);
		await this.#kv.remove(KNOWN);
	}

	/** "Sign out": the relay ends the binding and answers `signin.ended`. */
	signOut(): void {
		if (this.#member === undefined) return;
		this.#problem = undefined;
		if (!this.#host.send({ type: "signin.out" })) this.#notConnected();
	}

	/** A member's new label, any member's. */
	rename(member: string, label: string): void {
		const clean = text(label.trim(), 64);
		if (this.#member === undefined || clean === "") return;
		if (!this.#group?.members.some((m) => m.id === member)) return;
		this.#problem = undefined;
		if (!this.#host.send({ type: "member.rename", member, label: clean }))
			this.#notConnected();
	}

	/** Remove another member from the group; this browser's own is "Sign out". */
	remove(member: string): void {
		if (this.#member === undefined) return;
		if (member === this.#member) {
			this.signOut();
			return;
		}
		if (!this.#group?.members.some((m) => m.id === member)) return;
		this.#problem = undefined;
		if (!this.#host.send({ type: "member.remove", member }))
			this.#notConnected();
	}

	/** Disconnect an AI app from the whole group. */
	revokeGrant(grantId: string): void {
		if (this.#member === undefined) return;
		if (!this.#group?.grants.some((g) => g.grantId === grantId)) return;
		this.#problem = undefined;
		if (!this.#host.send({ type: "group.grant.revoke", grantId }))
			this.#notConnected();
	}

	/** The panel's OK under a notice. */
	dismissNotice(): void {
		this.#notice = undefined;
		this.#host.changed();
	}

	#notConnected(): void {
		this.#problem = "Turn on AI access to change this.";
		this.#host.changed();
	}

	// --- The group ---

	async #groupMessage(m: Readonly<Json>): Promise<void> {
		const record = parseGroup(m);
		if (record === undefined || this.#member === undefined) return;
		// Another member's id than the session's: not this browser's group.
		if (record.self !== this.#member) return;
		const before = this.#group;
		this.#group = record;
		this.#groupWait?.resolve();
		this.#groupWait = undefined;
		const where = (g: GroupRecord | undefined) =>
			JSON.stringify([g?.mode, g?.pin, g?.self]);
		const named = (g: GroupRecord | undefined) =>
			JSON.stringify([g?.focus, g?.members.map((x) => x.label)]);
		// Before the write below: a call meanwhile goes where the group says.
		const moved = where(before) !== where(record);
		if (moved) this.#host.targetsChanged();
		const ids = record.members.map((x) => x.id);
		const known = this.#known;
		const joined =
			known === undefined || known.self !== record.self
				? []
				: record.members.filter(
						(x) => x.id !== record.self && !known.members.includes(x.id),
					);
		if (
			known === undefined ||
			known.self !== record.self ||
			ids.length !== known.members.length ||
			ids.some((id) => !known.members.includes(id))
		) {
			this.#known = { self: record.self, members: ids };
			await this.#kv.set({ [KNOWN]: this.#known });
		}
		if (joined.length > 0) this.#announce(joined.map((x) => x.label));
		if (!moved && named(before) !== named(record)) this.#host.targetShown();
		// The relay learns which browser is in use in mode "front" only: once
		// as the group comes after a connect, and as the mode turns to it.
		if (record.mode === "front" && before?.mode !== "front")
			void this.#host.focusedHere().then(
				(focused) => {
					if (focused) this.windowFocused();
				},
				() => {},
			);
		this.#host.changed();
	}

	/** A notice, and a notification, for browsers that joined the group. */
	#announce(labels: string[]): void {
		const names = labels.map(quoted).join(", ");
		const one = labels.length === 1;
		this.#notice = `${names} signed in with your account and joined your browsers. If you did not sign ${one ? "it" : "them"} in, remove ${one ? "it" : "them"} below.`;
		this.#host.notify(
			`${JOINED_PREFIX}${crypto.randomUUID()}`,
			one ? "A browser joined your browsers" : "Browsers joined your browsers",
			`${names} signed in with your account. If you did not sign ${one ? "it" : "them"} in, remove ${one ? "it" : "them"} in the tab-mcp panel.`,
		);
	}

	/**
	 * A window of this browser gained the focus: the relay hears it in mode
	 * "the tab in front" only (no address, no title, no tab), so that calls
	 * go to the browser in use; in mode "a pinned tab" it learns nothing of
	 * the user's switching.
	 */
	windowFocused(): void {
		const group = this.#group;
		if (this.#member === undefined || group?.mode !== "front") return;
		// Calls go here already: nothing to tell.
		if (group.focus === this.#member) return;
		this.#host.send({ type: "focus" });
	}

	// --- Where calls go, while signed in ---

	/**
	 * The group's mode and pin as a `TargetStore`: loaded from the relay's
	 * last `group` (waiting a moment for the first one after a connect),
	 * saved by telling the relay (`group.mode`, `group.pin`), which tells
	 * every member. Saved here at once too, so that the next call goes where
	 * this one pinned; the relay's `group` that follows confirms it.
	 */
	targetStore(): TargetStore {
		return {
			load: async () => {
				const wait = this.#groupWait;
				if (wait !== undefined)
					await Promise.race([
						wait.promise,
						new Promise((resolve) => setTimeout(resolve, GROUP_WAIT_MS)),
					]);
				return settingOf(this.group);
			},
			save: async ({ mode, pin }) => {
				const group = this.#group;
				const sent =
					this.#member !== undefined &&
					group !== undefined &&
					this.#host.send(
						pin === undefined
							? { type: "group.mode", mode }
							: { type: "group.pin", tab: String(pin) },
					);
				if (!sent || group === undefined) throw new Error(SETTING_WHILE_DOWN);
				if (pin !== undefined) {
					group.mode = "pinned";
					group.pin = { member: group.self, tab: String(pin) };
				} else {
					group.mode = mode;
					delete group.pin;
				}
				delete group.focus;
				// Back to the tab in front from this browser's panel: it is
				// the one in use (the relay takes `focus` in that mode only).
				if (pin === undefined && mode === "front")
					void this.#host.focusedHere().then(
						(focused) => {
							if (focused) this.windowFocused();
						},
						() => {},
					);
			},
		};
	}

	/** What the panel shows; `undefined` where the relay offers no sign-in. */
	view(): SignInView | undefined {
		const account = this.#account;
		if (this.#providers === undefined && account === undefined)
			return undefined;
		const connected = this.#connected;
		const group = connected ? this.group : undefined;
		const view: SignInView = {
			providers:
				connected && this.#member === undefined ? (this.#providers ?? []) : [],
			connected,
		};
		// Kept but not signed in at this session: not shown.
		if (account !== undefined && this.active) {
			const { provider: _, ...shown } = account;
			view.account = shown;
		}
		if (group !== undefined) {
			view.members = group.members.map((x) => ({
				...x,
				self: x.id === group.self,
			}));
			view.maxMembers = group.maxMembers;
			view.grants = group.grants;
		}
		if (this.#pending !== undefined) view.pending = this.#pending.name;
		if (this.#problem !== undefined) view.problem = this.#problem;
		if (this.#notice !== undefined) view.notice = this.#notice;
		return view;
	}

	/** The label of member `id` of the group, if it is in it. */
	labelOf(id: string): string | undefined {
		return this.#group?.members.find((x) => x.id === id)?.label;
	}

	#run(task: () => Promise<void>): void {
		const run = this.#queue.then(task);
		this.#queue = run.catch((error: unknown) => {
			console.warn("tab-mcp: sign-in", error);
		});
	}
}

/** The group's record as the targets' setting. */
export function settingOf(group: GroupRecord | undefined): TargetSetting {
	if (group === undefined || group.mode === "front") return { mode: "front" };
	if (group.pin === undefined) return { mode: "pinned" };
	return group.pin.member === group.self
		? { mode: "pinned", pin: Number(group.pin.tab) }
		: { mode: "pinned", elsewhere: true };
}

/** The operating system's name for a member's label (`runtime.getPlatformInfo().os`). */
export function osName(os: string): string {
	return (
		{
			mac: "macOS",
			win: "Windows",
			linux: "Linux",
			cros: "ChromeOS",
			android: "Android",
			openbsd: "OpenBSD",
			fuchsia: "Fuchsia",
		}[os] ?? os
	);
}

/** The browser's name for a member's label: Firefox, Edge, or Chrome for the rest of Chromium. */
export function browserName(firefox: boolean, userAgent: string): string {
	if (firefox) return "Firefox";
	return /\bEdg\//.test(userAgent) ? "Edge" : "Chrome";
}
