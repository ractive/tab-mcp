/**
 * The calculator page: the keypad, and four tools for AI apps through
 * tab-mcp. The relay's address comes from `/config.json`, which the test page's
 * server (`server.ts`) answers.
 */

import { type Grant, TabMcp } from "@ractive-ch/tab-mcp-client";
import { Calculator, isKey } from "./calculator.ts";

function byId<T extends HTMLElement>(id: string): T {
	const node = document.getElementById(id);
	if (node === null) throw new Error(`#${id} is missing`);
	return node as T;
}

const calculator = new Calculator();
const displayValue = byId("display-value");
const memoryFlag = byId("memory-flag");

function render(): void {
	displayValue.textContent = calculator.display;
	memoryFlag.hidden = calculator.memory === 0;
}

/** Briefly highlight a key, so the user sees what was pressed. */
function flash(selector: string): void {
	const button = document.querySelector<HTMLElement>(selector);
	if (button === null) return;
	button.classList.remove("pressed");
	void button.offsetWidth; // restart the animation for a repeated key
	button.classList.add("pressed");
}

const keyButton = (key: string) => `[data-key="${CSS.escape(key)}"]`;

for (const button of document.querySelectorAll<HTMLButtonElement>(
	"[data-key]",
)) {
	button.addEventListener("click", () => {
		const key = button.dataset["key"] ?? "";
		if (isKey(key)) calculator.press(key);
		render();
	});
}
for (const button of document.querySelectorAll<HTMLButtonElement>(
	"[data-memory]",
)) {
	button.addEventListener("click", () => {
		const action = button.dataset["memory"];
		if (action === "add") calculator.memoryAdd();
		else if (action === "recall") calculator.memoryRecall();
		else if (action === "clear") calculator.memoryClear();
		render();
	});
}

/** Keyboard keys that mean a calculator key. */
const KEYBOARD: Record<string, string> = {
	Enter: "=",
	Escape: "C",
	Delete: "C",
	x: "*",
	X: "*",
	",": ".",
};

document.addEventListener("keydown", (event) => {
	if (event.ctrlKey || event.metaKey || event.altKey) return;
	if (document.querySelector("dialog[open]") !== null) return;
	const target = event.target as HTMLElement | null;
	if (target?.closest("input, textarea, select") != null) return;
	// Enter on a focused button clicks that button instead.
	if (event.key === "Enter" && target?.tagName === "BUTTON") return;
	const key = KEYBOARD[event.key] ?? event.key;
	if (!isKey(key)) return;
	event.preventDefault();
	calculator.press(key);
	flash(keyButton(key));
	render();
});

// --- AI access through tab-mcp ---

const connectButton = byId<HTMLButtonElement>("connect");
const stopButton = byId<HTMLButtonElement>("stop");
const status = byId("ai-status");
const apps = byId("apps");
const appList = byId("app-list");
const relayLabel = byId("relay-url");
connectButton.disabled = true;

interface Config {
	/** The tab-mcp relay, e.g. `http://localhost:8080`. */
	relay: string;
}

async function loadConfig(): Promise<Config> {
	const response = await fetch("/config.json");
	if (!response.ok) throw new Error(`config.json: HTTP ${response.status}`);
	return (await response.json()) as Config;
}

function grantLabel(grant: Grant): string {
	return `${grant.client.name} (${grant.client.host})`;
}

async function registerTools(mcp: TabMcp): Promise<void> {
	const pressKeys = (keys: string): string => {
		calculator.pressAll(keys);
		const last = [...keys].reverse().find((k) => k !== " ");
		if (last !== undefined) flash(keyButton(last));
		render();
		return calculator.display;
	};
	await Promise.all([
		mcp.registerTool({
			name: "press_keys",
			title: "Press keys",
			description:
				"Press calculator keys in order and return the display. Keys: digits 0-9, '.', " +
				"'+', '-', '*', '/', '=' and 'C' (clear). It works like a pocket calculator " +
				"with immediate execution: '2+3*4=' gives 20, not 14. Example: '12+30=' gives 42.",
			inputSchema: {
				type: "object",
				properties: {
					keys: {
						type: "string",
						description:
							"The keys to press, e.g. '12*12='. Spaces are ignored.",
						pattern: "^[0-9.+\\-*/=C ]{1,200}$",
					},
				},
				required: ["keys"],
				additionalProperties: false,
			},
			execute: ({ keys }) => pressKeys(String(keys)),
		}),
		mcp.registerTool({
			name: "read_display",
			title: "Read display",
			description:
				"Read the calculator's display and the number in its memory, without pressing a key.",
			inputSchema: { type: "object", additionalProperties: false },
			annotations: { readOnlyHint: true },
			execute: () => ({
				display: calculator.display,
				memory: calculator.memory,
			}),
		}),
		mcp.registerTool({
			name: "clear",
			title: "Clear",
			description:
				"Press C: clear the display and the pending operation. The memory stays. Returns the display.",
			inputSchema: { type: "object", additionalProperties: false },
			annotations: { idempotentHint: true },
			execute: () => pressKeys("C"),
		}),
		mcp.registerTool({
			name: "clear_memory",
			title: "Clear memory",
			description:
				"Set the calculator's memory to 0 (MC). The user is asked in the page first.",
			inputSchema: { type: "object", additionalProperties: false },
			annotations: { consequentialHint: true },
			execute: () => {
				calculator.memoryClear();
				flash('[data-memory="clear"]');
				render();
				return "Memory cleared.";
			},
		}),
	]);
}

function showAccess(mcp: TabMcp): void {
	const renderAi = () => {
		const { state, grants } = mcp;
		const count =
			grants.length === 1 ? "1 app is" : `${grants.length} apps are`;
		status.textContent =
			state === "connected"
				? grants.length === 0
					? "On. Add the address to your AI app and enter the code shown."
					: `On. ${count} connected.`
				: state === "connecting"
					? "Connecting…"
					: "Off. No AI app can use this page.";
		stopButton.hidden = state === "disconnected";
		connectButton.textContent =
			state === "connected" ? "Show address and code" : "Connect your AI app";
		apps.hidden = grants.length === 0;
		appList.replaceChildren(
			...grants.map((grant) => {
				const item = document.createElement("li");
				const disconnect = document.createElement("button");
				disconnect.type = "button";
				disconnect.className = "disconnect";
				disconnect.textContent = "Disconnect";
				disconnect.setAttribute(
					"aria-label",
					`Disconnect ${grantLabel(grant)}`,
				);
				// Only the relay can revoke, so only while the page is connected.
				disconnect.disabled = state !== "connected";
				disconnect.addEventListener("click", () => mcp.revoke(grant.grantId));
				item.append(`${grantLabel(grant)} `, disconnect);
				return item;
			}),
		);
	};
	mcp.addEventListener("statechange", renderAi);
	mcp.addEventListener("grantschange", renderAi);
	renderAi();
	connectButton.addEventListener("click", () => {
		void mcp.showConnectDialog();
	});
	stopButton.addEventListener("click", () => mcp.disconnect());
	connectButton.disabled = false;
}

function showError(what: string, error: unknown): void {
	status.textContent = `${what}: ${error instanceof Error ? error.message : String(error)}`;
}

render();
loadConfig()
	.then(
		async (config) => {
			relayLabel.textContent = config.relay;
			const mcp = new TabMcp({
				relay: config.relay,
				server: {
					name: "calculator",
					title: "Calculator",
					version: "1.0.0",
					instructions:
						"A four-function calculator open in the user's browser tab. Calculate with " +
						"press_keys and take the result from its answer; the user sees every key.",
				},
				appName: "Calculator",
				// The test page offers "Always allow" (opt-in, DEC-096).
				alwaysAllow: true,
			});
			await registerTools(mcp);
			showAccess(mcp);
		},
		(error: unknown) => showError("Cannot load the relay address", error),
	)
	.catch((error: unknown) => showError("Cannot start AI access", error));
