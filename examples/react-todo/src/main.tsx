/**
 * The React todo example's entry: reads its relay from `/config.json` (the
 * example server answers it) and renders the app in StrictMode.
 */

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { TodoList } from "./todos.ts";

const config = (await (await fetch("/config.json")).json()) as {
	relay: string;
};
const container = document.getElementById("root");
if (container === null) throw new Error("#root is missing");
createRoot(container).render(
	<StrictMode>
		<App relay={config.relay} todos={new TodoList()} />
	</StrictMode>,
);
