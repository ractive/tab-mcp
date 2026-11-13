/**
 * The backend recipe of the README ("The assistant's backend and an agent
 * framework"): the text between the markers is in the README word for word,
 * which `assistant-backend.test.ts` checks, and that test runs it against a
 * served page.
 */
// recipe:start
import {
	Client,
	StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import type { TunnelFetch } from "@ractive-ch/tab-mcp-client/tunnel";

/** A function tool as agent frameworks take one: a name, a description, a JSON Schema and a function. */
export interface PageTool {
	name: string;
	description: string;
	inputSchema: Record<string, unknown>;
	run(args: Record<string, unknown>): Promise<string>;
}

const ANNOTATIONS = "ch.ractive.tab-mcp/annotations";

export async function pageTools(
	tunnel: TunnelFetch,
): Promise<{ tools: PageTool[]; close(): Promise<void> }> {
	// The page speaks MCP 2026-07-28 only: pin it, or the SDK starts with an older version.
	const client = new Client(
		{ name: "assistant", version: "1.0.0" },
		{ versionNegotiation: { mode: { pin: "2026-07-28" } } },
	);
	// The URL is never fetched; only its path reaches the page.
	await client.connect(
		new StreamableHTTPClientTransport(new URL("https://tab.invalid/mcp"), {
			fetch: tunnel.fetch,
		}),
	);
	const { tools } = await client.listTools();
	return {
		tools: tools.map((tool) => ({
			name: tool.name,
			description: tool.description ?? "",
			inputSchema: tool.inputSchema,
			async run(args) {
				const result = await client.callTool({
					name: tool.name,
					arguments: args,
				});
				const text = result.content
					.map((block) =>
						block.type === "text" ? block.text : `[${block.type}]`,
					)
					.join("\n");
				if (result.isError === true) return `The tool failed: ${text}`;
				// Text from third parties (reviews, messages): say so to the model.
				const hints = result._meta?.[ANNOTATIONS] as
					| { untrustedContentHint?: boolean }
					| undefined;
				return hints?.untrustedContentHint === true
					? `<untrusted-content>\n${text}\n</untrusted-content>`
					: text;
			},
		})),
		close: () => client.close(),
	};
}
// recipe:end
