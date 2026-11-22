/**
 * The confirmation of consequential tools, loaded on demand: a `<dialog>`
 * per call, one shown at a time per document, and Always allow (or Allow
 * until reload) for the tools a user allows (`always-allowed.ts`).
 */

import { allowedFor, type ConfirmHost } from "./always-allowed.ts";
import {
	button,
	clientLabel,
	el,
	fill,
	newDialog,
	plural,
	stringsOf,
	visible,
} from "./dialog.ts";
import type { DialogStrings } from "./strings.ts";
import type { TabMcp } from "./tab-mcp.ts";
import type {
	ConfirmAnswer,
	ConfirmHandler,
	ConfirmRequest,
	DialogOptions,
	LocalClient,
	RelayClient,
} from "./types.ts";

/** A request the dialog is shown for: never a WebMCP call's (DEC-215). */
export type AskedRequest = ConfirmRequest & {
	client: RelayClient | LocalClient;
};

/**
 * The arguments as text, in full: what the user approves must be visible.
 * (The relay caps a request at 1 MiB, so this stays bounded.) Invisible and
 * direction characters are shown as escapes, so the text is still JSON for
 * the same arguments; the tool gets them unchanged. `undefined` when they
 * cannot be shown, and then "Allow once" is not offered.
 */
function showArguments(args: Record<string, unknown>): string | undefined {
	try {
		return visible(JSON.stringify(args, null, 2));
	} catch {
		return undefined;
	}
}

/**
 * How long "Allow once" stays disabled after the confirmation is shown, while the
 * page is visible and focused (CU 17: a constant; tests pass `allowDelayMs`).
 */
export const ALLOW_DELAY_MS = 750;

/** The user's answer: "always" allows this tool for this AI app (Always allow, or until reload). */
export type DialogAnswer = "allow" | "always" | "deny";

/** Arguments up to this many characters are read out with the question. */
const DESCRIBED_ARGUMENTS = 500;

/** Options of `confirmDialog`. */
export interface ConfirmDialogOptions {
	/** Tests only: another delay than {@link ALLOW_DELAY_MS}. */
	allowDelayMs?: number | undefined;
	/**
	 * Offer a third button: `true` "Always allow" (kept until the app is
	 * disconnected), `"until-reload"` "Allow until reload" (kept in memory).
	 */
	alwaysAllow?: boolean | "until-reload" | undefined;
	/** Asked when a waiting call's turn comes: `true` answers "allow" unseen. */
	allowedNow?: () => boolean;
	strings?: DialogStrings;
}

/**
 * The confirmations of one document: one is shown at a time, the others
 * wait in order, so that the click that answered one cannot answer the next
 * (each starts its own delay when it is shown).
 */
interface ConfirmQueue {
	shown: boolean;
	waiting: (() => void)[];
	/** Updates the shown dialog's line about the calls that wait. */
	changed?: (() => void) | undefined;
}

const queues = new WeakMap<Document, ConfirmQueue>();

/**
 * Ask whether a consequential tool may run. "Always allow" (or "Allow until
 * reload") is offered only with `alwaysAllow` (DEC-096, DEC-200); never
 * "allow everything": that is a deliberate act in the connect dialog, not
 * an answer to one question. One confirmation is shown at a time per
 * document; the others wait their turn, and a call cancelled while it waits
 * is never shown. "Allow once" and "Always allow" stay disabled until the
 * page has been visible and focused for 750 ms while the dialog is open and
 * is the top one, so a click meant for the page, the click that brings the
 * tab or window back, or the one that closed another dialog, cannot
 * approve; leaving the page disables them again. They also wait until the
 * arguments have been scrolled to their end. Before the delay has run out,
 * Enter or Space on a button and Escape are ignored, so typing meant for the
 * page cannot refuse either. Everything else (Don't allow, Escape, an
 * aborted call) is "deny". `allowedNow` is asked when a waiting call's turn
 * comes: `true` (the user allowed it meanwhile) answers "allow"
 * without showing it.
 */
export function confirmDialog(
	request: AskedRequest,
	doc: Document,
	options: ConfirmDialogOptions = {},
): Promise<DialogAnswer> {
	if (request.signal.aborted) return Promise.resolve("deny");
	let queue = queues.get(doc);
	if (queue === undefined) {
		queue = { shown: false, waiting: [] };
		queues.set(doc, queue);
	}
	const q = queue;
	/** The shown confirmation closed: the next one, if any. */
	const next = () => {
		const start = q.waiting.shift();
		q.shown = start !== undefined;
		start?.();
		q.changed?.();
	};
	const show = () => {
		try {
			return showConfirm(request, doc, options, q, next);
		} catch (error) {
			next(); // not shown: the queue goes on
			return Promise.reject(error);
		}
	};
	if (!q.shown) {
		q.shown = true;
		return show();
	}
	return new Promise((resolve) => {
		const start = () => {
			request.signal.removeEventListener("abort", onAbort);
			if (options.allowedNow?.() === true) {
				resolve("allow");
				next();
				return;
			}
			resolve(show());
		};
		const onAbort = () => {
			q.waiting.splice(q.waiting.indexOf(start), 1);
			q.changed?.();
			resolve("deny");
		};
		request.signal.addEventListener("abort", onAbort, { once: true });
		q.waiting.push(start);
		q.changed?.();
	});
}

/** `confirmDialog` once it is this request's turn; calls `next` when it closes. */
function showConfirm(
	request: AskedRequest,
	doc: Document,
	options: ConfirmDialogOptions,
	queue: ConfirmQueue,
	next: () => void,
): Promise<DialogAnswer> {
	const s = options.strings ?? stringsOf(undefined);
	const delay = options.allowDelayMs ?? ALLOW_DELAY_MS;
	const tool = request.tool.title ?? request.tool.name;
	const client = clientLabel(request.client, s);
	const names = { tool, client };
	const { dialog, id } = newDialog(
		doc,
		"tab-mcp-confirm",
		s,
		...fill(doc, s.confirmTitle, names),
	);
	const waiting = el(doc, "p", { className: "tab-mcp-waiting" });
	const showWaiting = () => {
		const n = queue.waiting.length;
		waiting.hidden = n === 0;
		waiting.textContent = plural(s.waiting, n, s);
	};
	queue.changed = showWaiting;
	showWaiting();
	// The safe choice is the default: focused, and the one that stands out.
	const deny = button(
		doc,
		s.deny,
		() => dialog.close("deny"),
		"tab-mcp-deny",
		"primary",
	);
	const approving = (text: string, answer: DialogAnswer, className: string) => {
		const node = button(
			doc,
			text,
			() => {
				if (!node.disabled) dialog.close(answer);
			},
			className,
		);
		return node;
	};
	// The approving buttons: Allow, and Always allow (or Allow until reload)
	// when the page offers it, saying how long it lasts.
	const approve = [approving(s.allow, "allow", "tab-mcp-allow")];
	const extra: HTMLElement[] = [];
	const mode = options.alwaysAllow;
	if (mode === true || mode === "until-reload") {
		const kept = mode === true;
		// Left of Allow: not where most platforms put the default (CU 11).
		approve.unshift(
			approving(
				kept ? s.alwaysAllow : s.allowUntilReload,
				"always",
				"tab-mcp-always",
			),
		);
		extra.push(
			el(
				doc,
				"p",
				{ className: "tab-mcp-always-note" },
				...fill(doc, kept ? s.alwaysAllowNote : s.allowUntilReloadNote, names),
			),
		);
	}
	const actions = el(
		doc,
		"div",
		{ className: "tab-mcp-actions" },
		deny,
		...approve.flatMap((b) => [" ", b]),
	);
	// Approving needs both: the delay ran out while the user saw the page
	// (`settled`), and the arguments were seen to their end (`seen`).
	let settled = false;
	let seen = false;
	const enable = () => {
		for (const b of approve) b.disabled = !(settled && seen);
	};
	enable();
	const shown = showArguments(request.arguments);
	const args = el(doc, "pre", {
		className: "tab-mcp-arguments",
		id: `${id}-arguments`,
		text: shown ?? s.argumentsHidden,
	});
	if (shown === undefined) {
		for (const node of [...approve, ...extra]) node.hidden = true;
	}
	args.dir = "ltr";
	// Inline, so the arguments stay readable in full without the stylesheet:
	// wrapped (also a long word, at 360 px), scrolling when long.
	args.style.setProperty("white-space", "pre-wrap");
	args.style.setProperty("overflow-wrap", "anywhere");
	args.style.setProperty(
		"max-height",
		"var(--tab-mcp-arguments-height, min(50vh, 24rem))",
	);
	args.style.setProperty("overflow", "auto");
	args.hidden = Object.keys(request.arguments).length === 0;
	// The caller chooses the order of the keys, so what matters may come
	// last: below the end of the box, the user is told, and Allow waits.
	const scrollNote = el(doc, "p", {
		className: "tab-mcp-scroll-note",
		text: s.scrollToAllow,
	});
	scrollNote.hidden = true;
	const who = el(
		doc,
		"p",
		{ id: `${id}-who` },
		...fill(doc, s.confirmWho, names),
	);
	dialog.setAttribute(
		"aria-describedby",
		shown !== undefined && !args.hidden && shown.length <= DESCRIBED_ARGUMENTS
			? `${who.id} ${args.id}`
			: who.id,
	);
	dialog.append(
		who,
		el(doc, "p", {
			className: "tab-mcp-description",
			text: request.tool.description,
		}),
		args,
		scrollNote,
		actions,
		...extra,
		waiting,
	);
	doc.body.append(dialog);
	const view = doc.defaultView;
	return new Promise((resolve, reject) => {
		const onAbort = () => dialog.close("deny");
		request.signal.addEventListener("abort", onAbort, { once: true });
		let timer: ReturnType<typeof setTimeout> | undefined;
		// In a hidden tab, the tab's title says that the page asks (CU 9): the
		// AI app waits meanwhile. Put back when the tab is shown or the dialog
		// closes, unless the page changed its title since.
		let title: { page: string; shown: string } | undefined;
		const untitle = () => {
			if (title !== undefined && doc.title === title.shown)
				doc.title = title.page;
			title = undefined;
		};
		const retitle = () => {
			if (doc.visibilityState !== "hidden") untitle();
			else if (title === undefined) {
				title = { page: doc.title, shown: `${s.titlePrefix}${doc.title}` };
				doc.title = title.shown;
			}
		};
		// The delay counts only while the user can see the page: tools are
		// called while the user is in the AI app, so the dialog often opens in
		// a background tab or window. Any change starts it again from zero
		// (DEC-087), and so does another dialog of the page that closes over
		// this one.
		const arm = (event?: Event) => {
			if (event?.type === "close" && event.target === dialog) return;
			retitle();
			clearTimeout(timer);
			timer = undefined;
			settled = false;
			enable();
			if (
				event?.type === "blur" ||
				doc.visibilityState === "hidden" ||
				!doc.hasFocus()
			)
				return;
			timer = setTimeout(() => {
				settled = true;
				enable();
			}, delay);
		};
		// Scrolled to the end, or nothing to scroll (also without layout).
		const check = () => {
			if (seen) return;
			if (args.scrollTop + args.clientHeight < args.scrollHeight - 2) {
				scrollNote.hidden = false;
				args.tabIndex = 0; // to scroll it with the keyboard
				return;
			}
			seen = true;
			scrollNote.hidden = true;
			enable();
		};
		// Not answered by a key before the delay has run out.
		const guard = (event: KeyboardEvent) => {
			if (settled) return;
			const onButton = (event.target as Element | null)?.localName === "button";
			if (
				event.key === "Escape" ||
				(onButton && (event.key === "Enter" || event.key === " "))
			)
				event.preventDefault();
		};
		const onCancel = (event: Event) => {
			if (!settled) event.preventDefault();
		};
		doc.addEventListener("visibilitychange", arm);
		doc.addEventListener("close", arm, true); // `close` does not bubble
		view?.addEventListener("focus", arm);
		view?.addEventListener("blur", arm);
		view?.addEventListener("resize", check);
		args.addEventListener("scroll", check);
		dialog.addEventListener("keydown", guard);
		dialog.addEventListener("keyup", guard);
		dialog.addEventListener("cancel", onCancel);
		const cleanup = () => {
			clearTimeout(timer);
			untitle();
			doc.removeEventListener("visibilitychange", arm);
			doc.removeEventListener("close", arm, true);
			view?.removeEventListener("focus", arm);
			view?.removeEventListener("blur", arm);
			view?.removeEventListener("resize", check);
			request.signal.removeEventListener("abort", onAbort);
			dialog.remove();
			if (queue.changed === showWaiting) queue.changed = undefined;
		};
		dialog.addEventListener(
			"close",
			() => {
				const value = dialog.returnValue;
				cleanup();
				resolve(value === "allow" || value === "always" ? value : "deny");
				next();
			},
			{ once: true },
		);
		try {
			dialog.showModal();
		} catch (error) {
			// Never shown, so never closed: the queue must not wait for it.
			cleanup();
			reject(error);
			next();
			return;
		}
		deny.focus(); // the safe choice is the default
		// Counted from when the dialog is shown, not from when it was built.
		arm();
		check();
	});
}

/** Options of this chunk's `confirmInPage`. */
export interface ConfirmInPageOptions {
	/**
	 * The third button, for an AI app through the relay (`kind: "relay"`):
	 * `true` "Always allow" (kept in the `TabMcp`'s `storage`; "Allow until
	 * reload" where it is kept in memory, as for a stand-in), `"until-reload"`
	 * "Allow until reload", `false` none. Default: the `TabMcp`'s
	 * `alwaysAllow`; none for a stand-in.
	 */
	alwaysAllow?: boolean | "until-reload" | undefined;
	/** Texts of the dialog, as `TabMcpOptions.ui`. */
	ui?: DialogOptions | undefined;
	/** Tests only: another delay than {@link ALLOW_DELAY_MS}. */
	allowDelayMs?: number | undefined;
}

/**
 * `TabMcp.confirmInPage`: the confirmation, and the tools the user allowed
 * (`always-allowed.ts`), which run unasked. Those only for an AI app through
 * the relay: a served port has no identity to remember an answer for
 * (DEC-115, DEC-124). A WebMCP call is never shown it (an agent that drives
 * the tab would answer it itself; DEC-215): it resolves `true`.
 *
 * Code that loads this chunk itself may pass a stand-in of its own for
 * `mcp` (`ConfirmHost`: `grants`, optionally `grantschange` events). Its
 * allowances live in memory, for its grants only, until the page is
 * reloaded, and exist only where the caller offers them with
 * `options.alwaysAllow`; without it nothing is allowed and nothing is kept.
 */
export function confirmInPage(
	mcp: TabMcp | ConfirmHost,
	request: ConfirmRequest,
	doc: Document,
	options: ConfirmInPageOptions = {},
): Promise<boolean> {
	const { client } = request;
	if (client.kind === "webmcp") return Promise.resolve(true);
	const strings = stringsOf(options.ui);
	const { allowDelayMs } = options;
	if (client.kind !== "relay")
		return confirmDialog({ ...request, client }, doc, {
			strings,
			allowDelayMs,
		}).then((answer) => answer === "allow");
	const { grantId } = client;
	const allowed = allowedFor(mcp);
	const allowedNow = () => allowed.allows(grantId, request.tool);
	if (allowedNow()) return Promise.resolve(true);
	const offer = options.alwaysAllow ?? allowed.offered;
	// Asked again when its turn comes: the call before it in the queue may
	// have been allowed meanwhile.
	return confirmDialog({ ...request, client }, doc, {
		strings,
		allowDelayMs,
		// "Always" only where it outlives a reload.
		alwaysAllow:
			offer !== false &&
			(offer === true && allowed.kept ? true : "until-reload"),
		allowedNow,
	}).then((answer) => {
		// Only while the grant is still there: a revoked app gets nothing
		// (`keep` checks).
		if (answer === "always") allowed.keep(grantId, request.tool);
		return answer !== "deny";
	});
}

/**
 * The core's question about a consequential call: an AI app's call that the
 * user allowed runs without asking, with the dialog and with the page's own
 * `onConfirm` alike; any other goes to `onConfirm`, else to the dialog.
 * Only AI apps through the relay have a grant to allow for.
 */
export function confirmCall(
	mcp: TabMcp,
	request: ConfirmRequest,
	onConfirm: ConfirmHandler | undefined,
): Promise<ConfirmAnswer> {
	const { client } = request;
	if (
		client.kind === "relay" &&
		allowedFor(mcp).allows(client.grantId, request.tool)
	)
		return Promise.resolve(true);
	if (onConfirm === undefined) return mcp.confirmInPage(request);
	// Anything but true or "unanswered" is a refusal.
	return Promise.resolve()
		.then(() => onConfirm(request))
		.then((answer) => (answer === "unanswered" ? answer : answer === true));
}
