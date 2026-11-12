/**
 * The questions of tools that ask first, now that the connection has no page
 * of its own to ask in (DEC-116). A question shows in every open side panel;
 * unless a side panel is open in the focused window of the tab the call acts
 * on, it also goes out as a Chrome notification, with Allow and Always allow.
 * A click on its body shows the whole question (the arguments in full) in
 * the side panel of the tab's window, or in a window of its own, where it
 * waits on; closing the notification, nobody answering within the time
 * limit or the AI app cancelling is Don't allow. The first answer counts.
 * Each notification carries its call: a click answers only that call, and a
 * click on a call that is already settled is dropped.
 */

import type { ConfirmRequest, RelayClient } from "@ractive-ch/tab-mcp-client";
import { escapeInvisible } from "@ractive-ch/tab-mcp-client/visible";
import type { Answer, QuestionView } from "../protocol.ts";
import { allowable } from "./allowed.ts";

/** A question nobody answers in this time is Don't allow. */
export const QUESTION_TIMEOUT_MS = 60_000;
/**
 * At most this many questions of one AI app wait at once; a call beyond
 * them is declined without asking ("busy"), so an AI app cannot pile up
 * questions (each with up to 1 MiB of arguments) faster than they are read.
 */
export const MAX_QUESTIONS_PER_APP = 5;
/** An Allow or Always allow this soon after a notification showed does not count. */
export const NOTIFICATION_GUARD_MS = 500;
/**
 * The arguments in a notification are cut to this; the side panel and the
 * question's window show them in full (the relay caps a request at 1 MiB).
 */
export const MAX_ARGS_NOTIFICATION = 150;
/** What a notification says when it cut the arguments. */
export const ARGS_CUT_NOTE = "Arguments cut: click to see them in full.";

/**
 * The buttons of a notification, in order. Don't allow is closing it:
 * Chrome gives a notification at most two buttons. A click on its body
 * shows the whole question.
 */
export const NOTIFICATION_BUTTONS = ["Allow", "Always allow"] as const;

/** What a question needs from Chrome and from the panels. */
export interface QuestionsHost {
	/** The window of tab `tabId`, `undefined` if it is gone. */
	windowOf(tabId: number): Promise<number | undefined>;
	/** A side panel is open in window `windowId`, and the window is focused. */
	panelInFocus(windowId: number): Promise<boolean>;
	/** Show notification `id`; rejects if it could not be shown. */
	notify(id: string, text: NotificationText): Promise<void>;
	clear(id: string): void;
	/**
	 * Show question `id` whole, for tab `tabId` in window `windowId`: called
	 * at once from a click on a notification's body (the user gesture
	 * `sidePanel.open` needs is only there before any `await`).
	 */
	showQuestion(where: {
		id: string;
		tabId: number | undefined;
		windowId: number | undefined;
	}): void;
	/** The list of questions changed: tell the panels, set the badge. */
	changed(): void;
	now(): number;
}

export interface NotificationText {
	title: string;
	message: string;
	contextMessage: string;
	/** Allow, and Always allow where it is offered (a page of an http(s) site). */
	buttons: string[];
}

/** The page's title of a tool in a notification's title is cut to this. */
export const MAX_NOTIFICATION_TITLE = 60;

const cut = (text: string, max: number) =>
	text.length > max ? `${text.slice(0, max - 1)}…` : text;

/**
 * Characters that are invisible, blank or turn the text's direction (U+202E,
 * say) written as `\uXXXX`, so the AI app cannot make the arguments look like
 * something else: the client library's set (`escapeInvisible`), which the
 * library's own confirmation uses too. The tool gets them unchanged.
 */
export const visible: (text: string) => string = escapeInvisible;

/** A confirmation request of an AI app through the relay (the extension's only caller). */
export type AppRequest = ConfirmRequest & { client: RelayClient };

/** The AI app as a question names it: its declared name beside its verified host. */
export function appName(client: RelayClient): string {
	return client.name ? `${visible(client.name)} (${client.host})` : client.host;
}

/** The host of `origin`, or the origin as it is. */
function hostOf(origin: string | undefined): string | undefined {
	if (origin === undefined) return undefined;
	try {
		return new URL(origin).host || origin;
	} catch {
		return origin;
	}
}

/**
 * A notification's text for a question. The page's title is cut on its own,
 * so that however long it is, the site (the part that is verified) stays
 * whole, in the context line.
 */
export function notificationText(
	view: QuestionView,
	summary: string,
	argsCut = false,
): NotificationText {
	const what = cut(view.title ?? view.tool, MAX_NOTIFICATION_TITLE);
	const site = hostOf(view.origin);
	// The note stays whole, however long the rest.
	const note = argsCut ? `\n${ARGS_CUT_NOTE}` : "";
	return {
		title: `Allow ${what}?`,
		message:
			cut(
				`${view.app} wants to run ${view.tool}${summary === "{}" ? "." : `: ${summary}`}`,
				300 - note.length,
			) + note,
		contextMessage: site
			? `On ${site} · tab-mcp for Chrome`
			: "tab-mcp for Chrome",
		buttons: view.always
			? [...NOTIFICATION_BUTTONS]
			: [NOTIFICATION_BUTTONS[0]],
	};
}

/**
 * The `question-args` messages a panel still needs: the arguments of each
 * waiting question it has not had, once. `sent` is updated: ids of questions
 * that went are dropped, the ones returned are added.
 */
export function argsToSend(
	questions: QuestionView[],
	sent: Set<string>,
): { type: "question-args"; id: string; args: string }[] {
	const waiting = new Set(questions.map((q) => q.id));
	for (const id of sent) if (!waiting.has(id)) sent.delete(id);
	const messages = questions
		.filter((q) => !sent.has(q.id))
		.map((q) => ({ type: "question-args" as const, id: q.id, args: q.args }));
	for (const m of messages) sent.add(m.id);
	return messages;
}

interface Pending {
	view: QuestionView;
	/** The AI app's grant that asks. */
	grantId: string;
	summary: string;
	/** The summary is cut: the notification says so. */
	argsCut: boolean;
	tabId: number | undefined;
	windowId: number | undefined;
	/** The notification showing it, if one does. */
	notification?: string;
	shownAt: number;
	settle(answer: Answer | "timeout"): void;
}

export class Questions {
	readonly #host: QuestionsHost;
	readonly #timeoutMs: number;
	readonly #pending = new Map<string, Pending>();
	#shown = 0;
	/** Each notification's `create`, until it is cleared. */
	readonly #creating = new Map<string, Promise<void>>();

	constructor(host: QuestionsHost, timeoutMs = QUESTION_TIMEOUT_MS) {
		this.#host = host;
		this.#timeoutMs = timeoutMs;
	}

	/** The questions waiting, oldest first. */
	get list(): QuestionView[] {
		return [...this.#pending.values()].map((p) => p.view);
	}

	/**
	 * Ask whether `request` may run, for the page tool on `origin` in tab
	 * `tabId`. Resolves with the first answer, `"timeout"` when nobody
	 * answered in time, `"deny"` when the AI app cancelled, `"busy"` (without
	 * asking) when that AI app has MAX_QUESTIONS_PER_APP waiting already.
	 */
	ask(
		request: AppRequest,
		where: { tabId?: number; origin?: string },
	): Promise<Answer | "timeout" | "busy"> {
		const { grantId } = request.client;
		let open = 0;
		for (const p of this.#pending.values()) if (p.grantId === grantId) open++;
		if (open >= MAX_QUESTIONS_PER_APP) return Promise.resolve("busy");
		const id = crypto.randomUUID();
		const json = visible(JSON.stringify(request.arguments, null, 2) ?? "{}");
		const view: QuestionView = {
			id,
			app: appName(request.client),
			host: request.client.host,
			tool: request.tool.name,
			...(request.tool.title ? { title: visible(request.tool.title) } : {}),
			...(where.origin ? { origin: where.origin } : {}),
			// In full: what the user approves must be there to read.
			args: json,
			always: where.origin !== undefined && allowable(where.origin),
		};
		const compact = visible(JSON.stringify(request.arguments) ?? "{}");
		const summary = cut(compact, MAX_ARGS_NOTIFICATION);
		return new Promise((resolve) => {
			let timer: ReturnType<typeof setTimeout> | undefined;
			const cancelled = () => pending.settle("deny");
			const pending: Pending = {
				view,
				grantId,
				summary,
				argsCut: summary !== compact,
				tabId: where.tabId,
				windowId: undefined,
				shownAt: 0,
				settle: (answer) => {
					if (this.#pending.get(id) !== pending) return;
					this.#pending.delete(id);
					clearTimeout(timer);
					request.signal.removeEventListener("abort", cancelled);
					if (pending.notification !== undefined)
						this.#clear(pending.notification);
					this.#host.changed();
					resolve(answer);
				},
			};
			if (request.signal.aborted) {
				resolve("deny");
				return;
			}
			this.#pending.set(id, pending);
			timer = setTimeout(() => pending.settle("timeout"), this.#timeoutMs);
			request.signal.addEventListener("abort", cancelled, { once: true });
			this.#host.changed();
			void this.#route(pending);
		});
	}

	/** In the panel of the tab's focused window, or else in a notification too. */
	async #route(pending: Pending): Promise<void> {
		const { tabId } = pending;
		try {
			pending.windowId =
				tabId === undefined ? undefined : await this.#host.windowOf(tabId);
			if (
				pending.windowId !== undefined &&
				(await this.#host.panelInFocus(pending.windowId))
			)
				return;
		} catch {
			// Not known where: a notification.
		}
		this.#notify(pending);
	}

	#notify(pending: Pending): void {
		if (this.#pending.get(pending.view.id) !== pending) return;
		// One notification per question: a panel that went away may have sent
		// it out already while the question was still being routed.
		if (pending.notification !== undefined) return;
		const id = `${pending.view.id}:${++this.#shown}`;
		pending.notification = id;
		pending.shownAt = this.#host.now();
		this.#creating.set(
			id,
			this.#host
				.notify(
					id,
					notificationText(pending.view, pending.summary, pending.argsCut),
				)
				.catch((error: unknown) =>
					// Notifications off for Chrome: the badge and the panel remain.
					console.warn("tab-mcp: notification", error),
				),
		);
	}

	/**
	 * Clear notification `id` once Chrome has made it: cleared while
	 * `create` still runs, it would stay on screen with buttons that answer
	 * nothing (`requireInteraction`).
	 */
	#clear(id: string): void {
		const creating = this.#creating.get(id) ?? Promise.resolve();
		void creating.then(() => {
			this.#creating.delete(id);
			this.#host.clear(id);
		});
	}

	/** An answer from a side panel. */
	answer(id: string, answer: Answer): void {
		this.#pending.get(id)?.settle(answer);
	}

	#byNotification(id: string): Pending | undefined {
		for (const pending of this.#pending.values())
			if (pending.notification === id) return pending;
		return undefined;
	}

	/**
	 * A button of notification `id`: 0 Allow, 1 Always allow (only where it
	 * is offered; elsewhere it counts as nothing).
	 */
	notificationButton(id: string, index: number): void {
		const pending = this.#byNotification(id);
		if (pending === undefined) return; // settled, or an older notification
		const answer: Answer | undefined =
			index === 0
				? "allow"
				: index === 1 && pending.view.always
					? "always"
					: undefined;
		if (answer === undefined) return;
		if (this.#host.now() - pending.shownAt < NOTIFICATION_GUARD_MS) {
			// Too soon to be read: show it again rather than take it.
			delete pending.notification;
			this.#clear(id);
			this.#notify(pending);
			return;
		}
		pending.settle(answer);
	}

	/**
	 * A click on notification `id`'s body: the question, whole, where the
	 * host shows it (the side panel of the tab's window, or a window of its
	 * own). It waits there, its time limit running on; the notification goes,
	 * and closing it after the click answers nothing.
	 */
	notificationClicked(id: string): void {
		const pending = this.#byNotification(id);
		if (pending === undefined) return; // settled, or an older notification
		delete pending.notification;
		this.#clear(id);
		this.#host.showQuestion({
			id: pending.view.id,
			tabId: pending.tabId,
			windowId: pending.windowId,
		});
	}

	/** Notification `id` closed (by the user, or Chrome): Don't allow. */
	notificationDismissed(id: string): void {
		this.#byNotification(id)?.settle("deny");
	}

	/**
	 * The side panel of window `windowId` closed, or another extension's
	 * panel covered it: its questions that showed only there go out as
	 * notifications.
	 */
	panelClosed(windowId: number): void {
		for (const pending of this.#pending.values())
			if (pending.windowId === windowId && pending.notification === undefined)
				this.#notify(pending);
	}
}
