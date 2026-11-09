/**
 * The questions of tools that ask first, now that the connection has no page
 * of its own to ask in (DEC-116). A question shows in every open side panel;
 * unless a side panel is open in the focused window of the tab the call acts
 * on, it also goes out as a Chrome notification, with Allow and Always allow:
 * closing it, a click on its body, nobody answering within the time limit or
 * the AI app cancelling is Don't allow. The first answer counts. Each
 * notification carries its call: a click answers only that call, and a click
 * on a call that is already settled is dropped.
 */

import type { ConfirmRequest } from "@ractive-ch/tab-mcp-client";
import type { Answer, QuestionView } from "../protocol.ts";
import { allowable } from "./allowed.ts";

/** A question nobody answers in this time is Don't allow. */
export const QUESTION_TIMEOUT_MS = 60_000;
/** An Allow or Always allow this soon after a notification showed does not count. */
export const NOTIFICATION_GUARD_MS = 500;
/** The arguments shown in the panel, and in a notification, are cut to this. */
export const MAX_ARGS = 4000;
export const MAX_ARGS_NOTIFICATION = 150;

/**
 * The buttons of a notification, in order. Don't allow is closing it (or a
 * click on its body): Chrome gives a notification at most two buttons.
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

const INVISIBLE =
	/(?![\t\n ])[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Zs}\u2800\u3164\u115F\u1160\uFFA0]/gu;

/** The page's title of a tool in a notification's title is cut to this. */
export const MAX_NOTIFICATION_TITLE = 60;

const cut = (text: string, max: number) =>
	text.length > max ? `${text.slice(0, max - 1)}…` : text;

/**
 * Characters that are invisible, blank or turn the text's direction (U+202E,
 * say) written as `\uXXXX`, so the AI app cannot make the arguments look like
 * something else: controls, format characters, line and paragraph
 * separators, every space but the plain one (U+00A0, U+2007, U+3000…) and
 * the blank letters (U+2800 Braille blank, U+3164, U+115F, U+1160, U+FFA0
 * Hangul fillers). The tool gets them unchanged.
 */
export function visible(text: string): string {
	// Line breaks and tabs stay: in JSON they are only the layout.
	return text.replace(INVISIBLE, (c) => {
		const code = c.codePointAt(0) ?? 0;
		return code > 0xffff
			? `\\u{${code.toString(16)}}`
			: `\\u${code.toString(16).padStart(4, "0")}`;
	});
}

/** The AI app as a question names it: its declared name beside its verified host. */
export function appName(client: ConfirmRequest["client"]): string {
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
): NotificationText {
	const what = cut(view.title ?? view.tool, MAX_NOTIFICATION_TITLE);
	const site = hostOf(view.origin);
	return {
		title: `Allow ${what}?`,
		message: cut(
			`${view.app} wants to run ${view.tool}${summary === "{}" ? "." : `: ${summary}`}`,
			300,
		),
		contextMessage: site
			? `On ${site} · tab-mcp for Chrome`
			: "tab-mcp for Chrome",
		buttons: view.always
			? [...NOTIFICATION_BUTTONS]
			: [NOTIFICATION_BUTTONS[0]],
	};
}

interface Pending {
	view: QuestionView;
	summary: string;
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
	 * answered in time, `"deny"` when the AI app cancelled.
	 */
	ask(
		request: ConfirmRequest,
		where: { tabId?: number; origin?: string },
	): Promise<Answer | "timeout"> {
		const id = crypto.randomUUID();
		const json = visible(JSON.stringify(request.arguments, null, 2) ?? "{}");
		const view: QuestionView = {
			id,
			app: appName(request.client),
			host: request.client.host,
			tool: request.tool.name,
			...(request.tool.title ? { title: visible(request.tool.title) } : {}),
			...(where.origin ? { origin: where.origin } : {}),
			args: cut(json, MAX_ARGS),
			always: where.origin !== undefined && allowable(where.origin),
		};
		const summary = cut(
			visible(JSON.stringify(request.arguments) ?? "{}"),
			MAX_ARGS_NOTIFICATION,
		);
		return new Promise((resolve) => {
			let timer: ReturnType<typeof setTimeout> | undefined;
			const cancelled = () => pending.settle("deny");
			const pending: Pending = {
				view,
				summary,
				windowId: undefined,
				shownAt: 0,
				settle: (answer) => {
					if (this.#pending.get(id) !== pending) return;
					this.#pending.delete(id);
					clearTimeout(timer);
					request.signal.removeEventListener("abort", cancelled);
					if (pending.notification !== undefined)
						this.#host.clear(pending.notification);
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
			void this.#route(pending, where.tabId);
		});
	}

	/** In the panel of the tab's focused window, or else in a notification too. */
	async #route(pending: Pending, tabId: number | undefined): Promise<void> {
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
		const id = `${pending.view.id}:${++this.#shown}`;
		pending.notification = id;
		pending.shownAt = this.#host.now();
		this.#host
			.notify(id, notificationText(pending.view, pending.summary))
			.catch((error: unknown) =>
				// Notifications off for Chrome: the badge and the panel remain.
				console.warn("tab-mcp: notification", error),
			);
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
			this.#notify(pending);
			this.#host.clear(id);
			return;
		}
		pending.settle(answer);
	}

	/** A click on the notification's body, or its closing: Don't allow. */
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
