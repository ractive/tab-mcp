/**
 * An AI app pairs with a group by signing in (DEC-232): on the pairing page
 * of an app whose browsers may sign in (`TAB_MCP_SIGN_IN_APPS`), the person
 * signs in with Google, Microsoft or GitHub, as in the tab-mcp browser
 * extension's panel, and the AI app gets one grant for every browser signed
 * in with that account (the account's group). The providers are the
 * browsers' (`providers.ts`); the flow comes back to the one callback
 * `/authorize/callback`, told apart by its `state`'s `account.` prefix.
 *
 * A group pairs once it exists: at least one browser is signed in with the
 * account, online or not. A code still pairs with one browser, as before.
 */

import { groupAddress } from "../address.ts";
import type { SignInProviderId } from "../config.ts";
import { randomBase64url } from "../crypto.ts";
import { JwtError } from "../jwt.ts";
import type { Logger } from "../log.ts";
import { escapeHtml } from "../oauth/html.ts";
import { OidcError } from "../oauth/oidc.ts";
import type { PairingContext, PairingResult } from "../oauth/pairing.ts";
import type { TokenStore } from "../store/types.ts";
import type { SignInProvider } from "./providers.ts";

/** How long a sign-in at the provider may take (a pending request lives 10 minutes). */
const FLOW_TTL_MS = 10 * 60_000;
/** Open sign-ins at most, as for identity binding's. */
const MAX_FLOWS = 10_000;
/** The `state` of an AI app's sign-in starts with this (a browser's: `browser.`). */
const STATE_PREFIX = "account.";
/** The form's `action` of a provider's button: `account.<provider>`. */
const ACTION_PREFIX = "account.";

export interface AccountPairingHost {
	readonly logger: Logger;
	/** A store with the binding methods (the relay offers sign-in only with one). */
	readonly store: TokenStore;
	publicUrl(): string;
}

interface Flow {
	requestId: string;
	browserId: string;
	provider: SignInProvider;
	nonce: string;
	verifier: string;
	expiresAt: number;
}

/** An AI app's sign-in at `/authorize`. */
export class AccountPairing {
	readonly #providers: ReadonlyMap<SignInProviderId, SignInProvider>;
	readonly #host: AccountPairingHost;
	readonly #allowed: (app: string) => boolean;
	/** state → flow; insertion order is expiry order. */
	readonly #flows = new Map<string, Flow>();
	/** Pending request → its one flow's state: a new click replaces the earlier sign-in. */
	readonly #flowOf = new Map<string, string>();
	/** The origins of the providers' authorization endpoints, as last known. */
	readonly #origins = new Map<SignInProviderId, string>();

	constructor(
		providers: ReadonlyMap<SignInProviderId, SignInProvider>,
		host: AccountPairingHost,
		allowed: (app: string) => boolean,
	) {
		this.#providers = providers;
		this.#host = host;
		this.#allowed = allowed;
	}

	/** Whether a callback's `state` is an AI app's sign-in. */
	static owns(state: string | null): boolean {
		return state?.startsWith(STATE_PREFIX) === true;
	}

	/** Whether a form's `action` is a provider's button. */
	static isAction(action: string | null): boolean {
		return action?.startsWith(ACTION_PREFIX) === true;
	}

	/** Whether the pairing page of `app` offers the sign-in. */
	offers(app: string): boolean {
		return this.#providers.size > 0 && this.#allowed(app);
	}

	/**
	 * The providers to show: those whose authorization endpoint is known (its
	 * origin goes into the page's `form-action`). One that cannot be reached
	 * is left out and logged.
	 */
	async prepare(): Promise<SignInProvider[]> {
		const shown: SignInProvider[] = [];
		for (const provider of this.#providers.values()) {
			try {
				this.#origins.set(provider.id, await provider.authorizationOrigin());
				shown.push(provider);
			} catch (error) {
				this.#host.logger.warn("signin.provider_unavailable", {
					provider: provider.id,
					reason: error instanceof OidcError ? error.reason : "fetch",
				});
			}
		}
		return shown;
	}

	/** The providers' origins, for the page's CSP `form-action`. */
	formTargets(): string[] {
		return [...new Set(this.#origins.values())];
	}

	/**
	 * The sign-in's part of the pairing page: one button per provider. The
	 * buttons skip the code field's check (`formnovalidate`).
	 */
	render(clientName: string, providers: readonly SignInProvider[]): string {
		const buttons = providers
			.map(
				(p) =>
					`<button type="submit" class="secondary" name="action" value="${ACTION_PREFIX}${escapeHtml(p.id)}" formnovalidate>Sign in with ${escapeHtml(p.name)}</button>`,
			)
			.join("\n");
		return `<div class="alternative">
<p>Or sign in with the account you signed in with in the tab-mcp browser extension: ${escapeHtml(clientName)} is then connected to every browser signed in with it, also those that are not open now. No code is needed.</p>
<div class="actions">
${buttons}
</div>
</div>`;
	}

	/** A provider's button: send the browser to the provider. */
	async check(
		form: URLSearchParams,
		admit: () => boolean,
		context: PairingContext,
	): Promise<PairingResult> {
		const id = (form.get("action") ?? "").slice(ACTION_PREFIX.length);
		const provider = this.#providers.get(id as SignInProviderId);
		if (provider === undefined) {
			return {
				ok: false,
				message: "This relay does not offer that sign-in.",
				reason: "not_offered",
			};
		}
		this.#sweep();
		this.#dropFlow(context.requestId);
		if (this.#flows.size >= MAX_FLOWS) {
			return {
				ok: false,
				message:
					"Too many sign-ins are open right now. Wait a few minutes and try again.",
				reason: "busy",
			};
		}
		// A sign-in could pair: charged like a code guess (DEC-061), and given
		// back if it pairs.
		if (!admit()) {
			return {
				ok: false,
				message:
					"Too many attempts from your network. Wait a few minutes and try again.",
				reason: "rate_limited",
			};
		}
		const state = `${STATE_PREFIX}${provider.id}.${randomBase64url(24)}`;
		const flow: Flow = {
			requestId: context.requestId,
			browserId: context.browserId,
			provider,
			nonce: randomBase64url(24),
			verifier: randomBase64url(32),
			expiresAt: Date.now() + FLOW_TTL_MS,
		};
		let location: string;
		try {
			location = await provider.authorizationUrl(this.#secrets(state, flow));
		} catch (error) {
			this.#host.logger.warn("signin.provider_unavailable", {
				provider: provider.id,
				reason: error instanceof OidcError ? error.reason : "fetch",
			});
			return {
				ok: false,
				message: `${provider.name} cannot be reached right now. Try again in a minute, or type the code.`,
				reason: "provider_unavailable",
			};
		}
		this.#flows.set(state, flow);
		this.#flowOf.set(context.requestId, state);
		return { ok: "redirect", location };
	}

	/**
	 * The provider sent the browser back: check the account, then the group.
	 * Returns the pending request the sign-in belongs to (if the state is
	 * known) and the result.
	 */
	async callback(
		params: URLSearchParams,
		browserId: string,
	): Promise<{ requestId?: string; result: PairingResult }> {
		this.#sweep();
		const state = params.get("state") ?? "";
		const flow = this.#flows.get(state);
		if (flow === undefined || flow.expiresAt <= Date.now()) {
			return {
				result: {
					ok: false,
					message:
						"This sign-in has expired or was already used. Start again from your AI app.",
					reason: "unknown_state",
				},
			};
		}
		this.#flows.delete(state); // single use
		const { requestId, provider } = flow;
		this.#flowOf.delete(requestId);
		const fail = (reason: string, message: string) => ({
			requestId,
			result: { ok: false as const, message, reason },
		});
		if (flow.browserId !== browserId) {
			return fail(
				"browser",
				"This sign-in was started in another browser. Start again from your AI app.",
			);
		}
		const error = params.get("error");
		const code = params.get("code");
		if (error !== null || code === null || code === "") {
			this.#host.logger.info("signin.provider_error", {
				provider: provider.id,
				error: (error ?? "no_code").slice(0, 64),
			});
			return fail(
				`provider_${(error ?? "no_code").slice(0, 32)}`,
				`The sign-in with ${provider.name} did not finish. Try again, or type the code.`,
			);
		}
		let key: string;
		try {
			key = (await provider.complete(code, this.#secrets(state, flow))).key;
		} catch (e) {
			const reason =
				e instanceof OidcError || e instanceof JwtError ? e.reason : "exchange";
			this.#host.logger.warn("signin.unchecked", {
				provider: provider.id,
				reason,
				message: (e instanceof Error ? e.message : "unknown").slice(0, 200),
			});
			return fail(
				reason,
				`The sign-in with ${provider.name} could not be checked. Try again, or type the code.`,
			);
		}
		let members: number;
		try {
			const list = this.#host.store.listBindings;
			if (list === undefined) throw new Error("the store has no bindings");
			members = (await list.call(this.#host.store, key, Date.now())).length;
		} catch (error) {
			this.#host.logger.error("store.error", {
				op: "listBindings",
				message: error instanceof Error ? error.message.slice(0, 200) : "",
			});
			return fail(
				"store_unavailable",
				"The relay cannot check the sign-in right now. Try again shortly.",
			);
		}
		if (members === 0) {
			return fail(
				"no_group",
				`No browser is signed in with this ${provider.name} account. In the tab-mcp browser extension, sign in with the same account, then sign in here again, or type the code.`,
			);
		}
		return {
			requestId,
			result: { ok: true, addressId: groupAddress(key), group: key },
		};
	}

	/** The pending request ended: its sign-in goes. */
	forget(requestId: string): void {
		this.#dropFlow(requestId);
	}

	#secrets(state: string, flow: Flow) {
		return {
			state,
			nonce: flow.nonce,
			verifier: flow.verifier,
			redirectUri: `${this.#host.publicUrl()}/authorize/callback`,
		};
	}

	#dropFlow(requestId: string): void {
		const state = this.#flowOf.get(requestId);
		if (state !== undefined) this.#flows.delete(state);
		this.#flowOf.delete(requestId);
	}

	#sweep(): void {
		const now = Date.now();
		for (const [state, flow] of this.#flows) {
			if (flow.expiresAt > now) break;
			this.#flows.delete(state);
			if (this.#flowOf.get(flow.requestId) === state) {
				this.#flowOf.delete(flow.requestId);
			}
		}
	}
}
