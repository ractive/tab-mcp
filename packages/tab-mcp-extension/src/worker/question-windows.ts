/**
 * A question's own window: where a click on a notification's body shows the
 * whole question when Chrome does not open the side panel. The worker opens
 * one popup window per question and remembers it; the page in it gets that
 * question (the arguments in full, sent once) and may answer only that one.
 * A port from any other window is disconnected and never heard. Closing the
 * window is Don't allow; a question settled elsewhere closes its window.
 */

import type { Answer, QuestionView, WorkerMessage } from "../protocol.ts";

/** A question window's port, as far as this needs it. */
export interface QuestionPort {
	/** The window the page is in (Chrome's `sender.tab.windowId`). */
	windowId: number | undefined;
	postMessage(message: WorkerMessage): void;
	disconnect(): void;
	onMessage(listener: (message: unknown) => void): void;
	onDisconnect(listener: () => void): void;
}

/** What the windows need from Chrome and from the questions. */
export interface QuestionWindowsHost {
	/** Open a popup window with the question page; its id, `undefined` if none. */
	create(): Promise<number | undefined>;
	remove(windowId: number): void;
	/** The questions waiting now. */
	list(): QuestionView[];
	answer(id: string, answer: Answer): void;
	/** Parse a message from the page: an answer, or `undefined`. */
	parse(message: unknown): Answer | undefined;
}

interface Opened {
	question: string;
	port?: QuestionPort;
	/** The question was posted to the port (once: it does not change). */
	sent: boolean;
}

export class QuestionWindows {
	readonly #host: QuestionWindowsHost;
	readonly #windows = new Map<number, Opened>();

	constructor(host: QuestionWindowsHost) {
		this.#host = host;
	}

	#waiting(id: string): QuestionView | undefined {
		return this.#host.list().find((q) => q.id === id);
	}

	/** Open a window for question `id`, if it still waits. */
	async open(id: string): Promise<void> {
		if (this.#waiting(id) === undefined) return;
		const windowId = await this.#host.create();
		if (windowId === undefined) return;
		// Settled while the window opened: nothing to show.
		if (this.#waiting(id) === undefined) {
			this.#host.remove(windowId);
			return;
		}
		this.#windows.set(windowId, { question: id, sent: false });
	}

	/**
	 * The port of a question page, its sender already checked as this
	 * extension's question page: heard only if its window is one opened for
	 * a question, and then only for that question.
	 */
	addPort(port: QuestionPort): void {
		const { windowId } = port;
		const opened =
			windowId === undefined ? undefined : this.#windows.get(windowId);
		if (windowId === undefined || opened === undefined) {
			port.disconnect();
			return;
		}
		opened.port?.disconnect();
		opened.port = port;
		opened.sent = false;
		const { question } = opened;
		port.onMessage((raw) => {
			// Only while this port is the window's and the window is mapped.
			if (this.#windows.get(windowId)?.port !== port) return;
			const answer = this.#host.parse(raw);
			if (answer !== undefined) this.#host.answer(question, answer);
		});
		port.onDisconnect(() => {
			const now = this.#windows.get(windowId);
			if (now?.port === port) delete now.port;
		});
		this.sync();
	}

	/** A window closed: one opened for a question is its Don't allow, once. */
	windowRemoved(windowId: number): void {
		const opened = this.#windows.get(windowId);
		if (opened === undefined) return;
		this.#windows.delete(windowId);
		opened.port?.disconnect();
		this.#host.answer(opened.question, "deny");
	}

	/**
	 * After a change: each window's page gets its question once; a window
	 * whose question is settled is told so and closed (and answers nothing).
	 */
	sync(): void {
		for (const [windowId, opened] of this.#windows) {
			const question = this.#waiting(opened.question);
			if (question !== undefined && opened.sent) continue;
			if (opened.port !== undefined) {
				try {
					opened.port.postMessage({ type: "question", question });
					opened.sent = true;
				} catch {
					// Closed meanwhile.
				}
			}
			if (question === undefined) {
				this.#windows.delete(windowId);
				this.#host.remove(windowId);
			}
		}
	}
}
