/**
 * A happy-dom window as the global DOM for the React tests: imported before
 * `react-dom`, which looks for `window` and `document` when it loads.
 * `restoreGlobals()` takes them away again for the other test files.
 */
import { Window } from "happy-dom";

export const window = new Window({ url: "https://page.example/" });

const g = globalThis as Record<string, unknown>;
const names = [
	"window",
	"document",
	"Node",
	"Element",
	"HTMLElement",
	"HTMLButtonElement",
	"HTMLDialogElement",
	"Text",
	"MutationObserver",
] as const;
const before = new Map(names.map((n) => [n, g[n]]));
for (const name of names)
	g[name] =
		name === "window"
			? window
			: (window as unknown as Record<string, unknown>)[name];
g["IS_REACT_ACT_ENVIRONMENT"] = true;

export async function restoreGlobals(): Promise<void> {
	for (const [name, value] of before) {
		if (value === undefined) delete g[name];
		else g[name] = value;
	}
	delete g["IS_REACT_ACT_ENVIRONMENT"];
	await window.happyDOM.close();
}
