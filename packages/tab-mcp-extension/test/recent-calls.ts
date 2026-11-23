/**
 * "Recent calls" (DEC-226) in a real panel, the same check in Chrome and in
 * Firefox: after an AI app's read-only call and one the user declined, the
 * opened section lists both, newest first, with how each went, the AI app,
 * the site and the arguments.
 */

import { expect } from "bun:test";

interface Row {
	tool: string;
	outcome: string;
	who: string;
	args: string;
}

const ROWS = `[...document.querySelectorAll("#calls-list > li")].map((li) => ({
	tool: li.querySelector(".call-tool").textContent,
	outcome: li.querySelector(".call-outcome").textContent,
	who: li.children[2].textContent,
	args: li.querySelector(".call-args").textContent,
}))`;

type Eval = <T>(expression: string) => Promise<T>;

/**
 * `greet` makes a read-only call (`page_get_greeting` with `{"name":"Ada"}`),
 * `decline` one of `page_place_order` with `{"item":"tea"}` the user
 * declines, `open` opens the section as the user does. `host`: the page's.
 * `app`: the AI app as the relay lists it, when it does.
 */
export async function listsTheCalls(
	panel: Eval,
	greet: () => Promise<unknown>,
	decline: () => Promise<unknown>,
	open: () => Promise<unknown>,
	host: string,
	app?: { name: string; host: string },
): Promise<void> {
	await greet();
	await decline();
	await open();
	const done = (rows: Row[]) =>
		rows[0]?.tool === "page_place_order" &&
		rows[0]?.outcome === "Declined by you" &&
		rows[1]?.tool === "page_get_greeting" &&
		rows[1]?.outcome === "Ran";
	const end = Date.now() + 10_000;
	let rows: Row[] = [];
	for (;;) {
		rows = await panel<Row[]>(ROWS);
		if (done(rows)) break;
		if (Date.now() > end)
			throw new Error(`the section never listed both: ${JSON.stringify(rows)}`);
		await Bun.sleep(50);
	}
	const [declined, greeted] = rows;
	// With the AI app listed, as the AI access card lists it: its name, then
	// its host. Unlisted (the relay did not announce it), its host alone.
	const who = app ? `${app.name} ${app.host} · on ${host}` : undefined;
	expect(declined?.args).toBe('{"item":"tea"}');
	expect(greeted?.args).toBe('{"name":"Ada"}');
	for (const row of [declined, greeted])
		if (who !== undefined) expect(row?.who).toBe(who);
		else expect(row?.who).toEndWith(` · on ${host}`);
	expect(
		await panel<string>(`document.getElementById("calls-summary").textContent`),
	).toBe(`Recent calls (${rows.length})`);
}
