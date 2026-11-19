/**
 * Pairing (DEC-028, DEC-042, DEC-196): the step at `/authorize` that finds the
 * page the browser's user means and proves they can see it. The address
 * names an app, not a page, so the method finds the page among the app's:
 * by the code it shows, or by the person signed in to it (`oidc.ts`,
 * DEC-079). The authorization server only knows the `PairingMethod` interface.
 */

import type { PairingKind } from "../config.ts";
import { sha256Base64url } from "../crypto.ts";

/** A page a pairing method found: the grant is made for its address. */
export interface PairingTarget {
	/** The page's address id (DEC-027). */
	readonly addressId: string;
}

/** The pages of one app, as a pairing method finds its page among them. */
export interface PairingPool {
	/**
	 * The page that shows this code (as `normalizeCode` gives it) right now;
	 * the code is used up and the page shows a new one.
	 */
	redeem(code: string): PairingTarget | undefined;
	/**
	 * The page whose user is `identity` (DEC-077) and whose "Connect your AI
	 * app" dialog is open; of several, the one that connected last.
	 */
	signedIn(identity: string): PairingTarget | undefined;
}

/** The pending request a check belongs to (for methods that leave the page). */
export interface PairingContext {
	requestId: string;
	browserId: string;
}

export type PairingResult =
	/**
	 * Paired with the page of `addressId`; `subject` is recorded on the grant
	 * (identity binding, DEC-077).
	 */
	| { ok: true; addressId: string; subject?: string }
	/** Continue elsewhere (the provider's sign-in); the answer comes to `callback`. */
	| { ok: "redirect"; location: string }
	| {
			ok: false;
			/** Plain English for the page (plain text; the page escapes it). */
			message: string;
			/** A short reason for the log. */
			reason: string;
	  };

/**
 * A way to pair a browser at `/authorize` with a page of an app. The
 * authorization server renders `render()` inside its form (CSRF token,
 * buttons and the request id are its own) and passes the submitted form to
 * `check()`.
 */
export interface PairingMethod {
	readonly kind: PairingKind;
	/** HTML of the method's step (escaped by the method). */
	render(): string;
	/**
	 * Check the submitted form fields. Call `admit()` right before judging an
	 * answer that could be right (a real guess); if it returns false, refuse
	 * with reason `rate_limited` without judging. Malformed input is answered
	 * without calling it (DEC-061).
	 */
	check(
		pool: PairingPool,
		form: URLSearchParams,
		admit: () => boolean,
		context: PairingContext,
	): PairingResult | Promise<PairingResult>;
	/** Work before the page is shown (e.g. provider discovery); throws if unavailable. */
	prepare?(): Promise<void>;
	/** Extra origins the page's form may lead to (CSP `form-action`). */
	formTargets?(): readonly string[];
	/** The pending request ended (paired, cancelled, expired, evicted): drop its state. */
	forget?(requestId: string): void;
	/** The answer of a method that redirected (`/authorize/callback`). */
	callback?(
		params: URLSearchParams,
		browserId: string,
		poolFor: (requestId: string) => PairingPool | undefined,
	): Promise<{ requestId?: string; result: PairingResult }>;
}

/** Code lifetime (DEC-028). */
export const PAIRING_CODE_TTL_MS = 120_000;

/**
 * The letters of a code (RFC 8628 §6.1): 20 consonants, so no code spells a
 * word and none has a letter that reads like a digit.
 */
export const CODE_ALPHABET = "BCDFGHJKLMNPQRSTVWXZ";
/** Letters in a code: 20^8 = 2.56 × 10^10 codes (DEC-196). */
export const CODE_LENGTH = 8;

/** Eight uniformly distributed letters of `CODE_ALPHABET`. */
export function newPairingCode(): string {
	// 240 is the largest multiple of 20 a byte holds: rejecting the values
	// from it up keeps every letter equally likely.
	let code = "";
	const buffer = new Uint8Array(CODE_LENGTH * 2);
	while (code.length < CODE_LENGTH) {
		crypto.getRandomValues(buffer);
		for (const byte of buffer) {
			if (byte >= 240 || code.length === CODE_LENGTH) continue;
			code += CODE_ALPHABET[byte % CODE_ALPHABET.length];
		}
	}
	return code;
}

/** A code as pages show it: `XXXX-XXXX`. */
export function shownCode(code: string): string {
	return `${code.slice(0, CODE_LENGTH / 2)}-${code.slice(CODE_LENGTH / 2)}`;
}

const CODE_PATTERN = new RegExp(`^[${CODE_ALPHABET}]{${CODE_LENGTH}}$`);

/**
 * A typed code without spaces and dashes, in upper case; `undefined` when it
 * is not eight letters of the alphabet (then it is no guess: DEC-061).
 */
export function normalizeCode(input: string): string | undefined {
	const typed = input.replace(/[\s-]/g, "").toUpperCase();
	return CODE_PATTERN.test(typed) ? typed : undefined;
}

/**
 * Why the relay sends a code (`pairing.code` `reason`): `start` the dialog
 * opened (a new code, or the current one again), `used` the last one was
 * entered, `expired` it timed out.
 */
export type CodeReason = "start" | "used" | "expired";

/**
 * The codes the relay's pages show right now, each with the page that shows
 * it (DEC-196): a typed code finds its page here, so no two pages show the
 * same code. Kept by the code's hash, so how long a lookup takes says
 * nothing about a live code's letters.
 */
export class CodeIndex<T> {
	readonly #owners = new Map<string, T>();

	/** A new code no page shows, kept for `owner`. */
	issue(owner: T): string {
		for (;;) {
			const code = newPairingCode();
			const key = sha256Base64url(code);
			if (this.#owners.has(key)) continue;
			this.#owners.set(key, owner);
			return code;
		}
	}

	release(code: string): void {
		this.#owners.delete(sha256Base64url(code));
	}

	/** Who shows `code` (as `normalizeCode` gives it). */
	owner(code: string): T | undefined {
		return this.#owners.get(sha256Base64url(code));
	}

	get size(): number {
		return this.#owners.size;
	}
}

/**
 * The pairing codes of one tab session: on while the tab's dialog is open
 * (`pairing.start` … `pairing.stop`); a fresh code after expiry and after
 * use. Codes are never logged.
 */
export class PairingCodes<T> {
	readonly #index: CodeIndex<T>;
	readonly #owner: T;
	readonly #send: (code: string, expiresAt: number, reason: CodeReason) => void;
	readonly #ttlMs: number;
	#current: { code: string; expiresAt: number } | undefined;
	#timer: Timer | undefined;

	constructor(
		index: CodeIndex<T>,
		owner: T,
		/** `code` as pages show it (`shownCode`). */
		send: (code: string, expiresAt: number, reason: CodeReason) => void,
		options: { ttlMs?: number } = {},
	) {
		this.#index = index;
		this.#owner = owner;
		this.#send = send;
		this.#ttlMs = options.ttlMs ?? PAIRING_CODE_TTL_MS;
	}

	/** Whether the tab is showing codes. */
	get active(): boolean {
		return this.#current !== undefined;
	}

	start(): void {
		if (this.#current !== undefined) {
			// Already on (e.g. a second dialog): show the same code again.
			this.#send(
				shownCode(this.#current.code),
				this.#current.expiresAt,
				"start",
			);
			return;
		}
		this.#issue("start");
	}

	stop(): void {
		clearTimeout(this.#timer);
		this.#timer = undefined;
		if (this.#current !== undefined) this.#index.release(this.#current.code);
		this.#current = undefined;
	}

	/**
	 * Use up `code` (as `normalizeCode` gives it) if it is the one shown now;
	 * the tab then shows a new one.
	 */
	redeem(code: string, now: number = Date.now()): boolean {
		const current = this.#current;
		if (current === undefined || current.code !== code) return false;
		if (now >= current.expiresAt) {
			this.#issue("expired");
			return false;
		}
		this.#issue("used");
		return true;
	}

	#issue(reason: CodeReason): void {
		clearTimeout(this.#timer);
		if (this.#current !== undefined) this.#index.release(this.#current.code);
		const expiresAt = Date.now() + this.#ttlMs;
		this.#current = { code: this.#index.issue(this.#owner), expiresAt };
		this.#timer = setTimeout(() => {
			if (this.#current !== undefined) this.#issue("expired");
		}, this.#ttlMs);
		this.#send(shownCode(this.#current.code), expiresAt, reason);
	}
}

const WRONG =
	"That code is not right, or it has expired. Enter the code the page shows now: “Connect your AI app” in the page shows it.";
const MALFORMED = `Enter the ${CODE_LENGTH} letters shown in the page.`;
const LIMITED =
	"Too many wrong codes from your network. Wait a few minutes and try again.";

/** The code typed at `/authorize` (DEC-028, DEC-196). */
export const codePairing: PairingMethod = {
	kind: "code",
	render(): string {
		// `data-tab-mcp-field` is for a browser extension that fills in its own
		// code after asking its user (DEC-199); the attribute never holds one.
		return `<p><label for="code">Code shown in the page</label>
<input id="code" name="code" type="text" data-tab-mcp-field="code" autocomplete="one-time-code" autocapitalize="characters" spellcheck="false" pattern="[A-Za-z \\-]{${CODE_LENGTH},${CODE_LENGTH + 4}}" maxlength="${CODE_LENGTH + 4}" required autofocus aria-describedby="code-help"></p>
<p id="code-help" class="help">In the page or app you want to connect, “Connect your AI app” shows a code of ${CODE_LENGTH} letters. It changes every 2 minutes.</p>`;
	},
	check(pool, form, admit): PairingResult {
		const code = normalizeCode(form.get("code") ?? "");
		if (code === undefined) {
			return { ok: false, message: MALFORMED, reason: "malformed" };
		}
		if (!admit()) {
			return { ok: false, message: LIMITED, reason: "rate_limited" };
		}
		const target = pool.redeem(code);
		if (target === undefined) {
			return { ok: false, message: WRONG, reason: "wrong" };
		}
		return { ok: true, addressId: target.addressId };
	},
};

/** The methods without settings; `oidc` is added by the server when configured. */
export const PAIRING_METHODS: Partial<Record<PairingKind, PairingMethod>> = {
	code: codePairing,
};
