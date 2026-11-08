// The content script, in the extension's isolated world, from document_start.
// The harness calls `spike.*` in this world over CDP.

const toolchanges = [];
document.modelContext?.addEventListener("toolchange", () =>
	toolchanges.push(Math.round(performance.now())),
);

let asked = 0;

globalThis.spike = {
	probe: webmcpProbe,
	/** When `toolchange` fired in this world (ms since the document started). */
	toolchanges: () => toolchanges,
	/**
	 * Ask the declared main-world script (main.js) over a CustomEvent and
	 * return every answer that comes back within `waitMs`: the page sees the
	 * question and can answer too.
	 */
	viaMain(op, arg = {}, waitMs = 1500) {
		const id = `${Date.now()}-${++asked}`;
		const answers = [];
		const listener = (event) => {
			const answer = JSON.parse(event.detail);
			if (answer.id === id) answers.push(answer);
		};
		document.addEventListener("webmcp-spike:answer", listener);
		document.dispatchEvent(
			new CustomEvent("webmcp-spike:ask", {
				detail: JSON.stringify({ id, op, arg }),
			}),
		);
		return new Promise((resolve) =>
			setTimeout(() => {
				document.removeEventListener("webmcp-spike:answer", listener);
				resolve(answers);
			}, waitMs),
		);
	},
};
