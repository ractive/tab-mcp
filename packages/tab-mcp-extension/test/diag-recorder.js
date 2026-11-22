// DIAGNOSTIC (temporary, not for merging): records what moves in the
// questions dialog, evaluated in the side panel before the page that asks.
(() => {
	const t0 = performance.now();
	const t = () => Math.round((performance.now() - t0) * 10) / 10;
	const name = (n) =>
		n.nodeType === 1
			? `${n.tagName}${n.id ? `#${n.id}` : ""}.${n.className}:${(n.textContent ?? "").slice(0, 24)}`
			: `#text:${(n.textContent ?? "").slice(0, 40)}`;
	const events = [];
	globalThis.__events = events;
	for (const type of ["pointerdown", "click", "focus", "blur"])
		document.addEventListener(
			type,
			(e) =>
				events.push([
					type,
					t(),
					e.clientX ?? null,
					e.clientY ?? null,
					name(e.target),
				]),
			true,
		);
	for (const type of ["focus", "blur", "visibilitychange"])
		window.addEventListener(type, (e) =>
			e.target === window || e.target === document
				? events.push(["window-" + type, t(), document.hasFocus()])
				: undefined,
		);
	const dialog = document.getElementById("questions");
	const sizes = new ResizeObserver((entries) => {
		for (const entry of entries)
			events.push([
				"size",
				t(),
				name(entry.target),
				Math.round(entry.contentRect.height),
			]);
	});
	const watch = (el) => {
		sizes.observe(el);
		for (const child of el.querySelectorAll("*")) sizes.observe(child);
	};
	watch(dialog);
	new MutationObserver((ms) => {
		for (const m of ms) {
			if (m.type === "attributes") {
				const now = m.target.getAttribute(m.attributeName);
				if (now !== m.oldValue)
					events.push([
						"attr",
						t(),
						name(m.target),
						m.attributeName,
						m.oldValue,
						now,
					]);
				continue;
			}
			for (const n of m.addedNodes) {
				events.push(["add", t(), name(n), "in", name(m.target)]);
				if (n.nodeType === 1) watch(n);
			}
			for (const n of m.removedNodes)
				events.push(["remove", t(), name(n), "from", name(m.target)]);
		}
	}).observe(dialog, {
		childList: true,
		subtree: true,
		characterData: true,
		attributes: true,
		attributeOldValue: true,
		attributeFilter: ["hidden", "open", "class", "style"],
	});
	// The newest deny button's top, every frame, while a card is there.
	const frame = () => {
		const b = [
			...document.querySelectorAll(
				'[data-question] button[data-answer="deny"]',
			),
		].at(-1);
		if (b) {
			const top = Math.round(b.getBoundingClientRect().top);
			if (top !== globalThis.__lastTop) events.push(["deny-top", t(), top]);
			globalThis.__lastTop = top;
		}
		requestAnimationFrame(frame);
	};
	requestAnimationFrame(frame);
	return "recording";
})();
