// A content script declared with "world": "MAIN", from document_start: it runs
// before the page's own scripts, in the page's world. It keeps the native
// document.modelContext from before the page could replace it, and answers
// the isolated world's questions over CustomEvents. (probe.js is not listed
// here: listed in both content_scripts entries, it ran only in the isolated
// world.)

(() => {
	const captured = document.modelContext;
	const toolchanges = [];
	captured?.addEventListener("toolchange", () =>
		toolchanges.push(Math.round(performance.now())),
	);
	const answer = (id, result) =>
		document.dispatchEvent(
			new CustomEvent("webmcp-spike:answer", {
				detail: JSON.stringify({ id, from: "main.js", result }),
			}),
		);
	document.addEventListener("webmcp-spike:ask", async (event) => {
		const { id, op, arg } = JSON.parse(event.detail);
		if (op === "toolchanges") return answer(id, toolchanges);
		if (op === "captured") {
			// The object captured at document_start, whatever the page did since.
			const tools = captured ? await captured.getTools() : [];
			return answer(id, {
				present: !!captured,
				same: captured === document.modelContext,
				tools: tools.map((t) => t.name),
			});
		}
		if (op === "call") {
			// Through the captured object, as a bridge in this world would.
			const tool = (await captured.getTools()).find((t) => t.name === arg.name);
			try {
				return answer(id, {
					ok: true,
					value: await captured.executeTool(tool, arg.input ?? {}),
				});
			} catch (error) {
				return answer(id, { ok: false, error: String(error) });
			}
		}
		answer(id, { ok: false, error: `unknown op ${op}` });
	});
})();
