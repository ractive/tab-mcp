/**
 * Lazy loading and the package layout: importing the library loads only the
 * core (DEC-035); `scripts/build.ts` produces a package whose declarations
 * type-check for a consumer.
 */
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dir, "..");

async function browserBuild() {
	const result = await Bun.build({
		entrypoints: [join(root, "src/index.ts")],
		target: "browser",
		format: "esm",
		splitting: true,
		minify: true,
		naming: { entry: "[name].js", chunk: "[name]-[hash].js" },
	});
	expect(result.success).toBe(true);
	const files = new Map<string, string>();
	for (const output of result.outputs)
		files.set(output.path.replace(/^.*\//, ""), await output.text());
	return files;
}

/** The files a page loads for `import "…/index.js"`: the entry and its static imports. */
function staticClosure(files: Map<string, string>, entry: string): Set<string> {
	const seen = new Set<string>();
	const stack = [entry];
	for (let name = stack.pop(); name !== undefined; name = stack.pop()) {
		if (seen.has(name)) continue;
		seen.add(name);
		const code = files.get(name) ?? "";
		for (const m of code.matchAll(
			/(?:^|[;}\s])(?:import|export)\s*[^("']*?from\s*["']\.\/([^"']+)["']|(?:^|[;}\s])import\s*["']\.\/([^"']+)["']/g,
		)) {
			stack.push((m[1] ?? m[2]) as string);
		}
	}
	return seen;
}

const gz = (text: string) =>
	Bun.gzipSync(new TextEncoder().encode(text)).length;

test("importing the library loads only the core; connect() loads the rest", async () => {
	const files = await browserBuild();
	const core = staticClosure(files, "index.js");
	const lazy = [...files.keys()].filter((name) => !core.has(name));
	expect(lazy.some((n) => n.startsWith("connection-"))).toBe(true);
	expect(lazy.some((n) => n.startsWith("ui-"))).toBe(true);
	const entry = files.get("index.js") ?? "";
	expect(entry).toMatch(/import\("\.\/connection-[^"]+\.js"\)/);
	const coreCode = [...core].map((n) => files.get(n) ?? "").join("");
	expect(coreCode).not.toContain("cfworker");
	expect(coreCode).not.toContain("subscriptions/listen");

	const coreGz = [...core].reduce((sum, n) => sum + gz(files.get(n) ?? ""), 0);
	const connection = lazy
		.filter((n) => n.startsWith("connection-"))
		.reduce((s, n) => s + gz(files.get(n) ?? ""), 0);
	console.log(
		`core ${(coreGz / 1024).toFixed(1)} KB gzipped, connection ${(connection / 1024).toFixed(1)} KB gzipped`,
	);
	expect(coreGz).toBeLessThanOrEqual(5 * 1024);
	expect(connection).toBeLessThanOrEqual(100 * 1024);
	for (const code of files.values()) {
		expect(code).not.toMatch(/\bfrom\s*"node:|\bBun\./);
	}
});

const consumer = mkdtempSync(join(tmpdir(), "tab-mcp-client-consumer-"));
afterAll(() => rmSync(consumer, { recursive: true, force: true }));

test("the build produces a package whose declarations type-check for a consumer", async () => {
	const build = Bun.spawnSync(["bun", join(root, "scripts/build.ts")], {
		cwd: root,
	});
	expect(build.exitCode).toBe(0);
	const dist = join(root, "dist");
	const pkg = (await Bun.file(join(dist, "package.json")).json()) as Record<
		string,
		unknown
	>;
	expect(pkg["exports"]).toEqual({
		".": { types: "./index.d.ts", default: "./index.js" },
		"./cdn": "./cdn/tab-mcp-client.min.js",
	});
	expect(pkg["dependencies"]).toEqual({
		"@cfworker/json-schema": expect.any(String),
	});
	for (const file of [
		"index.js",
		"index.d.ts",
		"cdn/tab-mcp-client.min.js",
		"LICENSE",
		"AI_NOTICE",
		"README.md",
		"THIRD-PARTY-NOTICES.txt",
	]) {
		expect(await Bun.file(join(dist, file)).exists()).toBe(true);
	}
	// The CDN build bundles @cfworker/json-schema: the notice names the pinned version.
	const deps = pkg["dependencies"] as Record<string, string>;
	const notices = await Bun.file(join(dist, "THIRD-PARTY-NOTICES.txt")).text();
	expect(notices).toContain(
		`@cfworker/json-schema ${deps["@cfworker/json-schema"]}`,
	);
	expect(pkg["publishConfig"]).toEqual({ access: "public" });
	expect(pkg["private"]).toBeUndefined();
	const declarations = await Bun.file(join(dist, "index.d.ts")).text();
	expect(declarations).not.toContain('.ts"');

	await Bun.write(
		join(consumer, "page.ts"),
		`import { TabMcp, type Tool, type SessionInfo } from "@ractive-ch/tab-mcp-client";
const mcp = new TabMcp({ relay: "https://relay.example", server: { name: "x", version: "1" }, appName: "demo" });
const tool: Tool = { name: "add", description: "Add", execute: ({ a, b }) => Number(a) + Number(b), annotations: { readOnlyHint: true } };
void mcp.registerTool(tool, { signal: new AbortController().signal });
mcp.addEventListener("disconnected", (e) => console.log(e.detail.reason, e.detail.code));
mcp.addEventListener("pairingcode", (e) => console.log(e.detail?.code));
export const session: Promise<SessionInfo> = mcp.connect({ resume: true });
// @ts-expect-error: unknown tool fields are type errors
mcp.registerTool({ name: "x", description: "y", execute: () => 1, nope: true });
`,
	);
	await Bun.write(
		join(consumer, "tsconfig.json"),
		JSON.stringify({
			compilerOptions: {
				target: "ES2022",
				module: "ESNext",
				moduleResolution: "bundler",
				lib: ["ES2022", "DOM"],
				types: [],
				strict: true,
				noEmit: true,
				skipLibCheck: false,
				paths: { "@ractive-ch/tab-mcp-client": [join(dist, "index.d.ts")] },
			},
			files: ["page.ts"],
		}),
	);
	const tsc = Bun.spawnSync(
		["bunx", "tsc", "-p", join(consumer, "tsconfig.json")],
		{ cwd: root },
	);
	expect(tsc.stdout.toString() + tsc.stderr.toString()).toBe("");
	expect(tsc.exitCode).toBe(0);
}, 60_000);
