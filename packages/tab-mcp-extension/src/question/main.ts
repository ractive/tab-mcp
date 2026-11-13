/**
 * A question's own window: a click on a notification's body where the side
 * panel of the tab's window could not open. It shows the one question the
 * worker opened it for, with the arguments in full, and sends the answer;
 * the worker closes it once the question is settled, and closing it is
 * Don't allow. Allow and "Don't ask again" count once the window has been
 * visible and focused for 750 ms, as in the side panel.
 */

import { QUESTION_PORT, type WorkerMessage } from "../protocol.ts";
import { questionCard } from "../sidepanel/question.ts";

const ALLOW_DELAY_MS = 750;

const list = document.getElementById("questions") as HTMLElement;
let shown: string | undefined;
let shownAt = 0;
let focusedSince: number | undefined;

const port = chrome.runtime.connect({ name: QUESTION_PORT });

function arm(): void {
	const now = Date.now();
	if (document.visibilityState === "visible" && document.hasFocus())
		focusedSince ??= now;
	else focusedSince = undefined;
	const ready =
		focusedSince !== undefined &&
		now - Math.max(shownAt, focusedSince) >= ALLOW_DELAY_MS;
	for (const b of list.querySelectorAll<HTMLButtonElement>(
		'button[data-answer]:not([data-answer="deny"])',
	))
		b.disabled = !ready;
}

port.onMessage.addListener((message: WorkerMessage) => {
	if (message?.type !== "question") return;
	const q = message.question;
	if (q === undefined) {
		list.replaceChildren();
		(document.getElementById("done") as HTMLElement).hidden = false;
		return;
	}
	if (q.id === shown) return;
	shown = q.id;
	shownAt = Date.now();
	list.replaceChildren(
		questionCard(q, (answer) => {
			try {
				port.postMessage({ type: "answer", answer });
			} catch {
				// The worker went away: the question went with it.
			}
		}),
	);
	arm();
});
port.onDisconnect.addListener(() => window.close());

setInterval(arm, 100);
for (const type of ["focus", "blur", "visibilitychange"])
	window.addEventListener(type, arm);
