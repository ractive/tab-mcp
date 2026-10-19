/**
 * Measure what the MCP SDK's server would cost in the page (DEC-049): a
 * browser bundle of `createMcpHandler` + `McpServer` + `fromJsonSchema`,
 * minified and gzipped, broken down by package and module from the metafile.
 *
 *   bun scripts/measure-sdk.ts
 */

import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

const dir = mkdtempSync(join(import.meta.dir, ".measure-"));
const entry = join(dir, "entry.ts");
await Bun.write(
	entry,
	`import { createMcpHandler, fromJsonSchema, McpServer } from "@modelcontextprotocol/server";
export const handler = createMcpHandler(() => {
	const server = new McpServer({ name: "x", version: "1" });
	server.registerTool("t", { description: "d", inputSchema: fromJsonSchema({ type: "object" }) }, async () => ({ content: [] }));
	return server;
}, { legacy: "reject", responseMode: "sse" });
`,
);
try {
	const result = await Bun.build({
		entrypoints: [entry],
		target: "browser",
		minify: true,
		metafile: true,
	});
	const output = result.outputs[0];
	if (!result.success || output === undefined || result.metafile === undefined) {
		throw new Error(result.logs.join("\n"));
	}
	const bytes = new Uint8Array(await output.arrayBuffer());
	const kb = (n: number) => `${(n / 1024).toFixed(1)} KB`;
	console.log(`total: ${kb(bytes.length)} minified, ${kb(Bun.gzipSync(bytes).length)} gzipped`);
	const inputs = Object.values(result.metafile.outputs)[0]?.inputs ?? {};
	const byPackage = new Map<string, number>();
	const byModule: [string, number][] = [];
	for (const [path, info] of Object.entries(inputs)) {
		const pkg = /node_modules\/(?:\.bun\/[^/]+\/node_modules\/)?((?:@[^/]+\/)?[^/]+)/.exec(path)?.[1] ?? "(entry)";
		byPackage.set(pkg, (byPackage.get(pkg) ?? 0) + info.bytesInOutput);
		byModule.push([path.replace(/.*node_modules\//, ""), info.bytesInOutput]);
	}
	console.log("\nminified bytes by package:");
	for (const [pkg, n] of [...byPackage].sort((a, b) => b[1] - a[1])) {
		console.log(`  ${kb(n).padStart(9)}  ${((100 * n) / bytes.length).toFixed(0).padStart(3)} %  ${pkg}`);
	}
	console.log("\nlargest modules:");
	for (const [path, n] of byModule.sort((a, b) => b[1] - a[1]).slice(0, 12)) {
		console.log(`  ${kb(n).padStart(9)}  ${path}`);
	}
} finally {
	rmSync(dir, { recursive: true, force: true });
}
