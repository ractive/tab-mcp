/**
 * The official MCP conformance suite (`@modelcontextprotocol/conformance`)
 * against the relay and this library, as a page runs them: an in-process
 * relay, a tab with the suite's fixture tools (the ones the library can
 * express), and a local proxy that adds the access token, since the suite
 * has no option for one. Runs the scenarios 2026-07-28 requires
 * (`--requirements 2026-07-28`); `conformance-baseline.yaml` lists the
 * checks known to fail and why. Exits with the suite's status.
 *
 *   bun packages/tab-mcp-client/test/conformance.ts [--verbose]
 */

import { fileURLToPath } from "node:url";
import { newTab, startRelay, tokenFor } from "./helpers.ts";

const IMAGE =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";
const AUDIO = "UklGRiYAAABXQVZFZm10IBAAAAABAAEAQB8AAAB9AAACABAAZGF0YQIAAAA=";

const r = startRelay();
const tab = newTab(r.url);

/** The suite's fixture tools (its everything-server), as the library offers them. */
function registerFixtures(): void {
	const text = (t: string) => ({ content: [{ type: "text", text: t }] });
	tab.registerTool({
		name: "test_simple_text",
		description: "Tests simple text content response",
		execute: () => text("This is a simple text response for testing."),
	});
	tab.registerTool({
		name: "test_image_content",
		description: "Tests image content response",
		execute: () => ({
			content: [{ type: "image", data: IMAGE, mimeType: "image/png" }],
		}),
	});
	tab.registerTool({
		name: "test_audio_content",
		description: "Tests audio content response",
		execute: () => ({
			content: [{ type: "audio", data: AUDIO, mimeType: "audio/wav" }],
		}),
	});
	tab.registerTool({
		name: "test_embedded_resource",
		description: "Tests embedded resource content response",
		execute: () => ({
			content: [
				{
					type: "resource",
					resource: {
						uri: "test://embedded-resource",
						mimeType: "text/plain",
						text: "This is an embedded resource content.",
					},
				},
			],
		}),
	});
	tab.registerTool({
		name: "test_multiple_content_types",
		description:
			"Tests response with multiple content types (text, image, resource)",
		execute: () => ({
			content: [
				{ type: "text", text: "Multiple content types test:" },
				{ type: "image", data: IMAGE, mimeType: "image/png" },
				{
					type: "resource",
					resource: {
						uri: "test://mixed-content-resource",
						mimeType: "application/json",
						text: JSON.stringify({ test: "data", value: 123 }),
					},
				},
			],
		}),
	});
	tab.registerTool({
		name: "test_error_handling",
		description: "Tests error response handling",
		execute: () => {
			throw new Error("This tool intentionally returns an error for testing");
		},
	});
	tab.registerTool({
		name: "json_schema_2020_12_tool",
		description:
			"Tool with JSON Schema 2020-12 features for conformance testing (SEP-1613)",
		inputSchema: {
			$schema: "https://json-schema.org/draft/2020-12/schema",
			type: "object",
			$defs: {
				address: {
					$anchor: "addressDef",
					type: "object",
					properties: { street: { type: "string" }, city: { type: "string" } },
				},
			},
			properties: {
				name: { type: "string" },
				address: { $ref: "#/$defs/address" },
				contactMethod: { type: "string", enum: ["phone", "email"] },
				phone: { type: "string" },
				email: { type: "string" },
			},
			allOf: [{ anyOf: [{ required: ["phone"] }, { required: ["email"] }] }],
			if: {
				properties: { contactMethod: { const: "phone" } },
				required: ["contactMethod"],
			},
			// biome-ignore lint/suspicious/noThenProperty: a JSON Schema keyword
			then: { required: ["phone"] },
			else: { required: ["email"] },
			additionalProperties: false,
		},
		execute: (args) =>
			text(`JSON Schema 2020-12 tool called with: ${JSON.stringify(args)}`),
	});
	// The suite calls it to see notifications/tools/list_changed on a listen stream.
	let extra: AbortController | undefined;
	tab.registerTool({
		name: "test_trigger_tool_change",
		description: "Changes the tool list",
		execute: () => {
			if (extra === undefined) {
				extra = new AbortController();
				tab.registerTool(
					{
						name: "test_dynamic_tool",
						description: "Registered by test_trigger_tool_change",
						execute: () => text("dynamic"),
					},
					{ signal: extra.signal },
				);
			} else {
				extra.abort();
				extra = undefined;
			}
			return text("Mutation triggered");
		},
	});
}

registerFixtures();
const session = await tab.connect();
const token = await tokenFor(r.store, session.address);
const address = new URL(session.address);

// Passes Origin through; Host becomes the relay's (fetch sets it).
const proxy = Bun.serve({
	port: 0,
	hostname: "127.0.0.1",
	async fetch(req) {
		const url = new URL(req.url);
		const headers = new Headers(req.headers);
		headers.set("authorization", `Bearer ${token}`);
		headers.delete("host");
		const res = await fetch(new URL(url.pathname + url.search, address), {
			method: req.method,
			headers,
			body:
				req.method === "GET" || req.method === "HEAD"
					? null
					: await req.arrayBuffer(),
			redirect: "manual",
			signal: req.signal,
		});
		return new Response(res.body, {
			status: res.status,
			headers: res.headers,
		});
	},
});

const cli = fileURLToPath(
	new URL(
		"dist/index.js",
		import.meta.resolve("@modelcontextprotocol/conformance/package.json"),
	),
);
const baseline = fileURLToPath(
	new URL("conformance-baseline.yaml", import.meta.url),
);
const child = Bun.spawn(
	[
		process.execPath,
		cli,
		"server",
		"--url",
		`http://127.0.0.1:${proxy.port}${address.pathname}`,
		"--requirements",
		"2026-07-28",
		"--expected-failures",
		baseline,
		...process.argv.slice(2),
	],
	{ stdout: "inherit", stderr: "inherit" },
);
const code = await child.exited;
tab.disconnect();
await proxy.stop(true);
await r.stop();
process.exit(code);
