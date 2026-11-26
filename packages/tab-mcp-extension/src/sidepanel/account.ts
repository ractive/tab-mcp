/**
 * "Your browsers" (DEC-233): signing this browser in at the relay, and its
 * group. Shown only where the relay offers sign-in (or while signed in):
 * the buttons "Sign in with …", then "Signed in as …", the group's members
 * with Rename and Remove (asked in the panel first, no `confirm()`), the
 * AI apps connected to all of them with Disconnect, a notice when a browser
 * joined, and Sign out. The worker does the rest (`worker/signin.ts`).
 *
 * A sign-in grants something: an AI app connected to the group reaches this
 * browser from then on. So its buttons take no click for a moment after
 * they came or moved, as "Always allow" and "Work here" (ES 5, DEC-228):
 * the panel's `arm()` calls `arm` here.
 */

import type {
	GrantView,
	PanelCommand,
	PanelState,
	SignInView,
} from "../protocol.ts";
import type { AccountKind } from "../worker/signin.ts";
import { confirms } from "./card.ts";
import { isUnavailable, setAvailable } from "./question.ts";

/** "(personal account)", "(work or school account)": the kind of a Microsoft account. */
export function kindText(kind: AccountKind | undefined): string {
	return kind === "personal"
		? " (personal account)"
		: kind === "work"
			? " (work or school account)"
			: "";
}

/** "Signed in as …": the name, the provider, and for Microsoft the kind. */
export function signedInText(view: SignInView): string {
	const account = view.account;
	if (account === undefined) return "Signed in.";
	return `Signed in as ${account.displayName} with ${account.providerName}${kindText(account.kind)}`;
}

/** The line in "Connect your AI app" while signed in. */
export function pairingGroupText(view: SignInView | undefined): string {
	const name = view?.account?.providerName;
	if (name === undefined || view?.members === undefined) return "";
	return `Or, on the sign-in page, sign in with your ${name} account instead of typing the code: the AI app then works with all your browsers.`;
}

export interface AccountElements {
	card: HTMLElement;
	intro: HTMLElement;
	signIn: HTMLElement;
	pending: HTMLElement;
	signedIn: HTMLElement;
	noticeBox: HTMLElement;
	notice: HTMLElement;
	noticeOk: HTMLElement;
	problem: HTMLElement;
	members: HTMLElement;
	membersNote: HTMLElement;
	grantsHeading: HTMLElement;
	grants: HTMLElement;
	off: HTMLElement;
	signOut: HTMLElement;
}

const setText = (element: HTMLElement, text: string) => {
	if (element.textContent !== text) element.textContent = text;
};

/** How long an armed Remove or Disconnect waits for its second click. */
const ARMED_MS = 4000;

export function accountPanel(
	el: AccountElements,
	send: (command: PanelCommand) => void,
	options: { quiet: () => boolean; waitMs: number },
) {
	let view: SignInView | undefined;
	/** Until when the sign-in buttons take no click: they came or moved. */
	let until = 0;
	let shownAs = "";
	/** The member being renamed, if any. */
	let renaming: string | undefined;
	/** Renaming just started: its field takes the focus once. */
	let focusRename = false;
	/** Armed: the members whose Remove, the grants whose Disconnect, was clicked once. */
	const armed = new Map<
		string,
		{ at: number; timer: ReturnType<typeof setTimeout> }
	>();

	function arm(key: string): boolean {
		const was = armed.get(key);
		if (was === undefined) {
			armed.set(key, {
				at: Date.now(),
				timer: setTimeout(() => {
					armed.delete(key);
					draw();
				}, ARMED_MS),
			});
			draw();
			return false;
		}
		// The second click of a double click confirms nothing.
		if (!confirms(was.at, Date.now())) return false;
		clearTimeout(was.timer);
		armed.delete(key);
		draw();
		return true;
	}

	function button(
		label: string,
		data: Record<string, string>,
		onClick: () => void,
		className = "small",
	): HTMLButtonElement {
		const b = document.createElement("button");
		b.type = "button";
		b.className = className;
		b.textContent = label;
		for (const [k, v] of Object.entries(data)) b.dataset[k] = v;
		b.addEventListener("click", onClick);
		return b;
	}

	function signInButtons(providers: SignInView["providers"]): HTMLElement[] {
		return providers.map((p) => {
			const b = button(
				`Sign in with ${p.name}`,
				{ provider: p.id },
				() => {
					// During the wait after they came or moved, the click does nothing.
					if (isUnavailable(b) || options.quiet()) return;
					send({ type: "sign-in", provider: p.id });
				},
				"",
			);
			setAvailable(b, Date.now() >= until);
			return b;
		});
	}

	function memberRow(
		member: NonNullable<SignInView["members"]>[number],
		connected: boolean,
	): HTMLElement {
		const li = document.createElement("li");
		li.dataset["member"] = member.id;
		if (renaming === member.id) {
			const form = document.createElement("form");
			form.className = "member-rename";
			const input = document.createElement("input");
			input.type = "text";
			input.value = member.label;
			input.maxLength = 64;
			input.setAttribute("aria-label", `New name for ${member.label}`);
			const save = document.createElement("button");
			save.type = "submit";
			save.className = "small strong";
			save.textContent = "Save";
			const cancel = button("Cancel", {}, () => {
				renaming = undefined;
				draw();
			});
			form.append(input, save, cancel);
			form.addEventListener("submit", (event) => {
				event.preventDefault();
				const label = input.value.trim();
				if (label !== "" && label !== member.label)
					send({ type: "rename-member", member: member.id, label });
				renaming = undefined;
				draw();
			});
			li.append(form);
			if (focusRename) {
				focusRename = false;
				queueMicrotask(() => input.focus());
			}
			return li;
		}
		const who = document.createElement("span");
		who.className = "app";
		const dot = document.createElement("span");
		dot.className = member.online ? "dot on" : "dot";
		dot.setAttribute("aria-hidden", "true");
		const name = document.createElement("span");
		name.className = "app-name";
		name.textContent = member.label;
		const state = document.createElement("span");
		state.className = "host";
		state.textContent = [
			member.self ? "this browser" : "",
			member.online ? "online" : "not online",
		]
			.filter((t) => t !== "")
			.join(" · ");
		who.append(dot, name, " ", state);
		li.append(who);
		if (connected) {
			const actions = document.createElement("span");
			actions.className = "member-buttons";
			actions.append(
				button("Rename", { rename: member.id }, () => {
					renaming = member.id;
					focusRename = true;
					draw();
				}),
			);
			if (!member.self) {
				const key = `member:${member.id}`;
				const isArmed = armed.has(key);
				const remove = button(
					isArmed ? "Remove? Click again" : "Remove",
					{ remove: member.id },
					() => {
						if (arm(key)) send({ type: "remove-member", member: member.id });
					},
				);
				// Armed, it is another button to the eye too (DEC-160).
				remove.toggleAttribute("data-armed", isArmed);
				actions.append(remove);
			}
			li.append(actions);
		}
		return li;
	}

	function grantRow(grant: GrantView, connected: boolean): HTMLElement {
		const li = document.createElement("li");
		const app = document.createElement("span");
		app.className = "app";
		const dot = document.createElement("span");
		dot.className = connected ? "dot on" : "dot";
		dot.setAttribute("aria-hidden", "true");
		const name = document.createElement("span");
		name.className = "app-name";
		name.textContent = grant.name || grant.host;
		app.append(dot, name);
		if (grant.name) {
			const host = document.createElement("span");
			host.className = "host";
			host.textContent = grant.host;
			app.append(" ", host);
		}
		li.append(app);
		if (connected) {
			const key = `grant:${grant.grantId}`;
			const isArmed = armed.has(key);
			const disconnect = button(
				isArmed ? "Disconnect? Click again" : "Disconnect",
				{ groupGrant: grant.grantId },
				() => {
					if (arm(key))
						send({ type: "revoke-group-grant", grantId: grant.grantId });
				},
			);
			disconnect.toggleAttribute("data-armed", isArmed);
			li.append(disconnect);
		}
		return li;
	}

	/** Draw `view` again: after a state, a click that armed something, a rename. */
	function draw(): void {
		const v = view;
		el.card.hidden = v === undefined;
		if (v === undefined) return;
		const signedIn = v.members !== undefined || v.account !== undefined;
		const offered = v.providers.length > 0 && v.pending === undefined;
		el.intro.hidden = signedIn || v.providers.length === 0;
		// Made again only when they change: a keyboard user's focus stays.
		const providers = JSON.stringify(offered ? v.providers : []);
		if (el.signIn.dataset["shown"] !== providers) {
			el.signIn.dataset["shown"] = providers;
			el.signIn.replaceChildren(...(offered ? signInButtons(v.providers) : []));
		}
		el.signIn.hidden = !offered;
		el.pending.hidden = v.pending === undefined;
		setText(
			el.pending,
			v.pending === undefined
				? ""
				: `Signing in with ${v.pending}… Finish it in the window that opened.`,
		);
		el.signedIn.hidden = !signedIn;
		setText(el.signedIn, signedIn ? signedInText(v) : "");
		el.noticeBox.hidden = v.notice === undefined;
		setText(el.notice, v.notice ?? "");
		el.problem.hidden = v.problem === undefined;
		setText(el.problem, v.problem ?? "");
		// The rows are made anew: a keyboard user's focus goes back to the
		// same button of the same row.
		const focused =
			document.activeElement instanceof HTMLElement &&
			el.card.contains(document.activeElement)
				? Object.entries(document.activeElement.dataset)[0]
				: undefined;
		const members = v.members ?? [];
		if (renaming !== undefined && !members.some((m) => m.id === renaming))
			renaming = undefined;
		// The row being renamed stays as it is, with what was typed, its
		// selection and its focus: a state that comes meanwhile (a member
		// online, a notice) must not take the draft away.
		const editing =
			renaming === undefined
				? null
				: el.members.querySelector<HTMLElement>(
						`li[data-member="${CSS.escape(renaming)}"]`,
					);
		const field = editing?.querySelector("input") ?? null;
		const draft =
			field !== null && document.activeElement === field
				? [field.selectionStart, field.selectionEnd]
				: undefined;
		el.members.replaceChildren(
			...members.map((m) =>
				m.id === renaming && field !== null && editing !== null
					? editing
					: memberRow(m, v.connected),
			),
		);
		if (field !== null && draft !== undefined) {
			field.focus();
			field.setSelectionRange(draft[0] ?? null, draft[1] ?? null);
		}
		const removing = [...armed.keys()].some((k) => k.startsWith("member:"));
		el.membersNote.hidden = members.length === 0;
		setText(
			el.membersNote,
			members.length === 0
				? ""
				: removing
					? "Removing a browser signs it out: AI apps connected to all your browsers no longer reach it. It can sign in again, which is announced here."
					: `Every browser signed in with this account, up to ${v.maxMembers ?? 16}. Rename gives one a name you know it by.`,
		);
		const grants = v.grants ?? [];
		el.grantsHeading.hidden = grants.length === 0;
		el.grants.replaceChildren(...grants.map((g) => grantRow(g, v.connected)));
		el.off.hidden = v.connected;
		el.signOut.hidden = !v.connected || v.members === undefined;
		if (focused !== undefined) {
			const [key, value] = focused;
			const attribute = `data-${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
			el.card
				.querySelector<HTMLElement>(
					`[${attribute}="${CSS.escape(value ?? "")}"]`,
				)
				?.focus();
		}
	}

	el.noticeOk.addEventListener("click", () =>
		send({ type: "dismiss-sign-in-notice" }),
	);
	el.signOut.addEventListener("click", () => send({ type: "sign-out" }));

	return {
		show(s: PanelState): void {
			view = s.signIn;
			draw();
			// The buttons came, went or moved: they wait again (ES 5).
			const at = JSON.stringify([
				el.signIn.hidden ? "" : el.signIn.dataset["shown"],
				el.signIn.offsetTop,
			]);
			if (at !== shownAs) {
				shownAs = at;
				if (!el.signIn.hidden) until = Date.now() + options.waitMs;
			}
		},
		/** The sign-in buttons ready or not, from `now`; the panel's other waits in `movedUntil`. */
		arm(now: number, movedUntil: number): void {
			for (const b of el.signIn.querySelectorAll<HTMLElement>("button"))
				setAvailable(b, now >= Math.max(movedUntil, until));
		},
		/** Until when the buttons wait (the panel's timer looks again till then). */
		until: () => until,
	};
}
