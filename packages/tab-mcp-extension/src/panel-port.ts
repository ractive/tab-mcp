/**
 * A side panel's port in the service worker, from the moment it connects:
 * Chrome hands a message only to the listeners there are, so the panel's
 * messages are taken at once and each waits on the panel's attachment to the
 * connection. The callbacks of one promise run in the order they were added,
 * so the messages keep theirs, with no buffer of their own (EQ 19).
 */

import { startProblem, type WorkerMessage } from "./protocol.ts";

/** A side panel's port, as far as attaching it needs. */
export interface PanelPortLike {
	postMessage(message: WorkerMessage): void;
	onMessage(listener: (message: unknown) => void): void;
	onDisconnect(listener: () => void): void;
}

/**
 * What a panel says once when it connects (its window, whether it is on
 * screen, whether it pairs): the last of each is kept, to be said again to
 * a connection that attaches the panel after a failed start.
 */
const SAID_ON_CONNECT = new Set(["hello", "visible", "pair"]);

/**
 * Attach `port` once `ready()` gives the connection; `attach` returns what
 * takes the panel's messages. A failed start shows the panel why and drops
 * the messages that waited on it; the panel's next message tries again, and
 * an attachment after a failure first hears what the panel said on
 * connecting. A port gone before the start is never attached.
 */
export function attachPanel<C>(
	ready: () => Promise<C>,
	port: PanelPortLike,
	attach: (connection: C) => (message: unknown) => void,
): void {
	let gone = false;
	let failed = false;
	const said = new Map<string, unknown>();
	let attached: Promise<((message: unknown) => void) | undefined> | undefined;
	const attachNow = () => {
		attached ??= ready().then(
			(connection) => {
				if (gone) return undefined;
				const receive = attach(connection);
				if (failed) for (const message of said.values()) receive(message);
				return receive;
			},
			(error: unknown) => {
				attached = undefined;
				failed = true;
				try {
					if (!gone)
						port.postMessage({ type: "state", state: startProblem(error) });
				} catch {
					// Closed meanwhile.
				}
				return undefined;
			},
		);
		return attached;
	};
	port.onDisconnect(() => {
		gone = true;
	});
	port.onMessage((message) => {
		const type =
			typeof message === "object" && message !== null
				? (message as { type?: unknown }).type
				: undefined;
		if (typeof type === "string" && SAID_ON_CONNECT.has(type))
			said.set(type, message);
		void attachNow().then((receive) => receive?.(message));
	});
	void attachNow();
}
