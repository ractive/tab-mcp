/**
 * Pairing (DEC-028, DEC-042): the step at `/authorize` that proves the browser
 * belongs to the tab's user. The authorization server only knows the
 * `PairingMethod` interface; which method a session uses comes from its site
 * (DEC-045): the 6-digit code shown in the tab, or identity binding at an
 * OpenID Connect provider (`oidc.ts`, DEC-079).
 */

import { timingSafeEqual } from "node:crypto";
import type { PairingKind } from "../config.ts";

/** What a pairing method sees of a tab session. */
export interface PairingTarget {
	/** The code state of the session (used by the code method). */
	readonly codes: PairingCodes;
	/** The binding key of the page's user, if signed in (DEC-077). */
	readonly identity: string | undefined;
	/** Whether the page's "Connect your AI app" dialog is open. */
	readonly pairingOpen: boolean;
}

/** The pending request a check belongs to (for methods that leave the page). */
export interface PairingContext {
	requestId: string;
	browserId: string;
}

export type PairingResult =
	/** Paired; `subject` is recorded on the grant (identity binding, DEC-077). */
	| { ok: true; subject?: string }
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
 * A way to pair a browser at `/authorize` with an address. The authorization
 * server renders `render()` inside its form (CSRF token, buttons and the
 * request id are its own) and passes the submitted form to `check()`.
 */
export interface PairingMethod {
	readonly kind: PairingKind;
	/** HTML of the method's step (escaped by the method). */
	render(target: PairingTarget): string;
	/**
	 * Check the submitted form fields. Call `admit()` right before judging an
	 * answer that could be right (a real guess); if it returns false, refuse
	 * with reason `rate_limited` without judging. Malformed input and a state
	 * that cannot succeed are answered without calling it (DEC-061).
	 */
	check(
		target: PairingTarget,
		form: URLSearchParams,
		admit: () => boolean,
		context?: PairingContext,
	): PairingResult | Promise<PairingResult>;
	/** Work before the page is shown (e.g. provider discovery); throws if unavailable. */
	prepare?(): Promise<void>;
	/** Extra origins the page's form may lead to (CSP `form-action`). */
	formTargets?(): readonly string[];
	/** The answer of a method that redirected (`/authorize/callback`). */
	callback?(
		params: URLSearchParams,
		browserId: string,
		targetFor: (requestId: string) => PairingTarget | undefined,
	): Promise<{ requestId?: string; result: PairingResult }>;
}

/** Code lifetime and attempts (DEC-028). */
export const PAIRING_CODE_TTL_MS = 120_000;
export const PAIRING_MAX_ATTEMPTS = 5;

export type CodeCheck =
	| "ok"
	| "limited"
	| "wrong"
	| "expired"
	| "locked"
	| "inactive"
	| "malformed";

/** Six uniformly distributed digits. */
export function newPairingCode(): string {
	// 4 294 000 000 is the largest multiple of 10^6 below 2^32: rejecting the
	// values above it keeps every code equally likely.
	const buffer = new Uint32Array(1);
	for (;;) {
		crypto.getRandomValues(buffer);
		const n = buffer[0] ?? 0;
		if (n < 4_294_000_000) return String(n % 1_000_000).padStart(6, "0");
	}
}

function sameCode(a: string, b: string): boolean {
	const x = Buffer.from(a);
	const y = Buffer.from(b);
	return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * The pairing codes of one tab session: on while the tab's dialog is open
 * (`pairing.start` … `pairing.stop`); a fresh code after expiry, after use and
 * after too many wrong attempts. Codes are never logged.
 */
export class PairingCodes {
	readonly #send: (code: string, expiresAt: number) => void;
	readonly #ttlMs: number;
	readonly #maxAttempts: number;
	#current: { code: string; expiresAt: number; attempts: number } | undefined;
	#previous: string | undefined;
	#timer: Timer | undefined;

	constructor(
		send: (code: string, expiresAt: number) => void,
		options: { ttlMs?: number; maxAttempts?: number } = {},
	) {
		this.#send = send;
		this.#ttlMs = options.ttlMs ?? PAIRING_CODE_TTL_MS;
		this.#maxAttempts = options.maxAttempts ?? PAIRING_MAX_ATTEMPTS;
	}

	/** Whether the tab is showing codes. */
	get active(): boolean {
		return this.#current !== undefined;
	}

	/** Attempts left for the current code. */
	get attemptsLeft(): number {
		return this.#current === undefined
			? 0
			: this.#maxAttempts - this.#current.attempts;
	}

	start(): void {
		if (this.#current !== undefined) {
			// Already on (e.g. a second dialog): show the same code again.
			this.#send(this.#current.code, this.#current.expiresAt);
			return;
		}
		this.#issue();
	}

	stop(): void {
		clearTimeout(this.#timer);
		this.#timer = undefined;
		this.#current = undefined;
		this.#previous = undefined;
	}

	/**
	 * Check a typed code; a correct one is used up and replaced. `admit` is
	 * asked only for a well-formed code while a code is active.
	 */
	check(
		input: string,
		now: number = Date.now(),
		admit: () => boolean = () => true,
	): CodeCheck {
		const current = this.#current;
		if (current === undefined) return "inactive";
		const typed = input.replace(/[\s-]/g, "");
		if (!/^\d{6}$/.test(typed)) return "malformed";
		if (!admit()) return "limited";
		if (now >= current.expiresAt) {
			this.#previous = current.code;
			this.#issue();
			return "expired";
		}
		if (sameCode(typed, current.code)) {
			this.#previous = undefined;
			this.#issue();
			return "ok";
		}
		current.attempts++;
		const expired =
			this.#previous !== undefined && sameCode(typed, this.#previous);
		if (current.attempts >= this.#maxAttempts) {
			this.#previous = undefined;
			this.#issue();
			return "locked";
		}
		return expired ? "expired" : "wrong";
	}

	#issue(): void {
		clearTimeout(this.#timer);
		const expiresAt = Date.now() + this.#ttlMs;
		this.#current = { code: newPairingCode(), expiresAt, attempts: 0 };
		this.#timer = setTimeout(() => {
			if (this.#current === undefined) return;
			this.#previous = this.#current.code;
			this.#issue();
		}, this.#ttlMs);
		this.#send(this.#current.code, expiresAt);
	}
}

const MESSAGES: Record<Exclude<CodeCheck, "ok">, string> = {
	wrong:
		"That code is not right. Check the code shown in the page and try again.",
	expired:
		"That code has expired. The page now shows a new code: enter that one.",
	locked:
		"Too many wrong codes. The page now shows a new code: enter that one.",
	inactive:
		"The page is not showing a code right now. In the page, open “Connect your AI app” to see one, then enter it here.",
	malformed: "Enter the 6 digits shown in the page.",
	limited:
		"Too many attempts for this page. Wait a few minutes and try again. If it keeps happening, someone else may be guessing: use “New address” in the page.",
};

/** The 6-digit code typed at `/authorize` (DEC-028). */
export const codePairing: PairingMethod = {
	kind: "code",
	render(): string {
		return `<p><label for="code">Code shown in the page</label>
<input id="code" name="code" type="text" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9 ]{6,7}" maxlength="7" required autofocus aria-describedby="code-help"></p>
<p id="code-help" class="help">In the page, “Connect your AI app” shows a 6-digit code. It changes every 2 minutes.</p>`;
	},
	check(target, form, admit): PairingResult {
		const result = target.codes.check(
			form.get("code") ?? "",
			Date.now(),
			admit,
		);
		if (result === "ok") return { ok: true };
		let message = MESSAGES[result];
		if (result === "wrong") {
			const left = target.codes.attemptsLeft;
			message += ` ${left === 1 ? "1 try is" : `${left} tries are`} left for this code.`;
		}
		return {
			ok: false,
			message,
			reason: result === "limited" ? "rate_limited" : result,
		};
	},
};

/** The methods without settings; `oidc` is added by the server when configured. */
export const PAIRING_METHODS: Partial<Record<PairingKind, PairingMethod>> = {
	code: codePairing,
};
