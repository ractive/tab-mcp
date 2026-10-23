/**
 * Server rendering of the React bindings: no `window`, no `document`, no
 * storage, nothing registered or connected; the state is `disconnected`.
 */
import { expect, test } from "bun:test";
import { renderToString } from "react-dom/server";
import {
	ConnectButton,
	TabMcpProvider,
	useTabMcpState,
	useTool,
} from "../src/react.ts";
import type { SecretStorage } from "../src/types.ts";

test("the provider renders on the server without a browser", () => {
	const g = globalThis as Record<string, unknown>;
	expect(g["window"]).toBeUndefined();
	expect(g["document"]).toBeUndefined();
	const touched: string[] = [];
	const storage: SecretStorage = {
		getItem: (key) => {
			touched.push(key);
			return null;
		},
		setItem: (key) => {
			touched.push(key);
		},
	};
	let tools: readonly string[] | undefined;
	function Page() {
		useTool({ name: "add", description: "Add", execute: () => 1 });
		const state = useTabMcpState();
		tools = state.tools;
		return <p data-state={state.state}>{state.address ?? "no address"}</p>;
	}
	const html = renderToString(
		<TabMcpProvider
			relay="https://relay.example"
			server={{ name: "todo", version: "1.0.0" }}
			storage={storage}
		>
			<Page />
			<ConnectButton />
		</TabMcpProvider>,
	);
	expect(html).toContain('data-state="disconnected"');
	expect(html).toContain("no address");
	expect(html).toContain(">Connect your AI app</button>");
	expect(tools).toEqual([]);
	expect(touched).toEqual([]);
});
