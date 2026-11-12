/**
 * Lazy loading and the package layout: importing the library loads only the
 * core (DEC-035); `scripts/build.ts` produces a package whose declarations
 * type-check for a consumer.
 */
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PINNED_FILES } from "../../../scripts/pinned-files.ts";

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
	// The setup steps (`./setup`, DEC-118) are in the UI chunk, not the core.
	expect(coreCode).not.toContain("codex mcp add");
	// The WebMCP mirror is in the core; its calls run in the lazy chunk (DEC-115).
	expect(coreCode).toContain("data-tab-mcp-webmcp");
	expect(coreCode).not.toContain("The user declined");

	const coreGz = [...core].reduce((sum, n) => sum + gz(files.get(n) ?? ""), 0);
	const connection = lazy
		.filter((n) => n.startsWith("connection-"))
		.reduce((s, n) => s + gz(files.get(n) ?? ""), 0);
	console.log(
		`core ${(coreGz / 1024).toFixed(1)} KB gzipped, connection ${(connection / 1024).toFixed(1)} KB gzipped`,
	);
	// 6.25 KB since `serve` and the optional relay (DEC-122); 6 KB since
	// client 0.8.0 (DEC-103); 5.5 KB since the fixes of iteration 13
	// (DEC-086); 5.25 KB since the per-page secret key (DEC-083); 5 KB before.
	expect(coreGz).toBeLessThanOrEqual(6.25 * 1024);
	// `serve` itself is in the lazy chunk, with the tunnel.
	expect(coreCode).not.toContain("bad_message");
	expect(connection).toBeLessThanOrEqual(100 * 1024);
	for (const code of files.values()) {
		expect(code).not.toMatch(/\bfrom\s*"node:|\bBun\./);
	}
});

test("the tunnel entry stands alone: no DOM, nothing of the page's library", async () => {
	const result = await Bun.build({
		entrypoints: [join(root, "src/tunnel.ts")],
		target: "browser",
		format: "esm",
		minify: true,
	});
	expect(result.success).toBe(true);
	expect(result.outputs).toHaveLength(1);
	const code = (await result.outputs[0]?.text()) ?? "";
	expect(code).not.toMatch(/\bfrom\s*"|\bimport\s*\(/);
	expect(code).not.toMatch(/\b(document|window|localStorage|Bun)\b/);
	console.log(`tunnel entry ${(gz(code) / 1024).toFixed(1)} KB gzipped`);
	expect(gz(code)).toBeLessThanOrEqual(2 * 1024);
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
		"./react": { types: "./react.d.ts", default: "./react.js" },
		"./setup": { types: "./setup.d.ts", default: "./setup.js" },
		"./tunnel": { types: "./tunnel.d.ts", default: "./tunnel.js" },
		"./visible": { types: "./visible.d.ts", default: "./visible.js" },
		"./cdn": "./cdn/tab-mcp-client.min.js",
	});
	expect(pkg["peerDependencies"]).toEqual({ react: ">=18.3.0 <20" });
	expect(pkg["peerDependenciesMeta"]).toEqual({ react: { optional: true } });
	expect(pkg["dependencies"]).toEqual({
		"@cfworker/json-schema": expect.any(String),
	});
	for (const file of [
		"index.js",
		"index.d.ts",
		"react.js",
		"react.d.ts",
		"setup.js",
		"setup.d.ts",
		"tunnel.js",
		"tunnel.d.ts",
		"visible.js",
		"visible.d.ts",
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
	// The README's CDN example pins the version being published.
	const readme = await Bun.file(join(dist, "README.md")).text();
	expect(readme).toContain(
		`npm/@ractive-ch/tab-mcp-client@${pkg["version"]}/cdn/tab-mcp-client.min.js`,
	);
	expect(pkg["private"]).toBeUndefined();
	const declarations = await Bun.file(join(dist, "index.d.ts")).text();
	expect(declarations).not.toContain('.ts"');
	// The npm files carry no preload map naming their own chunk files: a
	// consumer's bundler renames them, and the map's links would 404.
	for (const file of new Bun.Glob("*.js").scanSync(dist))
		expect(await Bun.file(join(dist, file)).text()).not.toContain(
			"modulepreload",
		);
	// The React entry: "use client" first, the core entry and react as imports.
	const reactEntry = await Bun.file(join(dist, "react.js")).text();
	expect(reactEntry.startsWith('"use client";')).toBe(true);
	const imports = [
		...reactEntry.matchAll(/\bfrom\s*"([^"]+)"|\bimport\s*\(\s*"([^"]+)"/g),
	].map((m) => m[1] ?? m[2]);
	expect(new Set(imports)).toEqual(new Set(["react", "./index.js"]));
	const cdnFiles = [...new Bun.Glob("cdn/*.js").scanSync(dist)];
	expect(cdnFiles.some((f) => f.includes("react"))).toBe(false);
	expect(
		await Bun.file(join(dist, "cdn/tab-mcp-client.min.js")).text(),
	).not.toContain("useSyncExternalStore");
	const reactGz = Bun.gzipSync(new TextEncoder().encode(reactEntry)).length;
	console.log(`react entry ${(reactGz / 1024).toFixed(1)} KB gzipped`);
	expect(reactGz).toBeLessThanOrEqual(3 * 1024);
	expect(await Bun.file(join(dist, "react.d.ts")).text()).not.toContain('.ts"');

	await Bun.write(
		join(consumer, "page.ts"),
		`import { TabMcp, type Tool, type SessionInfo, type ServeHandle, type TunnelPort } from "@ractive-ch/tab-mcp-client";
import { createTunnelFetch, type TunnelFetch, type TunnelRequestMessage, type TunnelCancelMessage } from "@ractive-ch/tab-mcp-client/tunnel";
import { SETUP_GUIDE, setupInstructions, type SetupInstruction } from "@ractive-ch/tab-mcp-client/setup";
const mcp = new TabMcp({ relay: "https://relay.example", server: { name: "x", version: "1" }, appName: "demo", webmcp: true });
const tool: Tool = { name: "add", description: "Add", execute: ({ a, b }) => Number(a) + Number(b), annotations: { readOnlyHint: true } };
void mcp.registerTool(tool, { signal: new AbortController().signal, webmcp: true });
mcp.addEventListener("toolcall", (e) => { const c = e.detail.client; console.log(c.kind === "relay" ? c.host : c.kind === "local" ? c.id : c.kind); });
// @ts-expect-error: the caller may be an agent in the browser, which has no host
mcp.addEventListener("toolcall", (e) => console.log(e.detail.client.host));
mcp.addEventListener("disconnected", (e) => console.log(e.detail.reason, e.detail.code));
mcp.addEventListener("pairingcode", (e) => console.log(e.detail?.code));
export const session: Promise<SessionInfo> = mcp.connect({ resume: true });
const steps: SetupInstruction[] = setupInstructions("x", "https://relay.example/a/x/mcp");
export const help: string[] = steps.map((s) => \`\${s.app}: \${s.text} \${s.command ?? ""}\${(s.note ?? []).map((p) => ("code" in p ? p.code : p.text)).join("")}\`);
export const guide: string = SETUP_GUIDE;
// @ts-expect-error: unknown tool fields are type errors
mcp.registerTool({ name: "x", description: "y", execute: () => 1, nope: true });
// Without a relay: the tools over a port, a MessagePort or one of the page's own.
const own = new TabMcp({ server: { name: "x", version: "1" } });
const channel = new MessageChannel();
const tunnel: TunnelFetch = createTunnelFetch({ send: (m: TunnelRequestMessage | TunnelCancelMessage) => channel.port2.postMessage(m) });
channel.port2.onmessage = (e) => tunnel.receive(e.data);
export const served: Promise<ServeHandle> = own.serve(channel.port1, { client: { id: "chat", name: "Assistant" }, signal: new AbortController().signal, maxChunk: 1024 });
const port: TunnelPort = { postMessage: (m) => console.log(m), onmessage: null };
void own.serve(port, { client: { id: "chat" } });
export const listed: Promise<Response> = tunnel.fetch("https://tab.invalid/mcp", { method: "POST", body: "{}" });
export const relay: boolean = own.hasRelay;
// @ts-expect-error: serve needs to know who is on the other end
void own.serve(channel.port1, {});
`,
	);
	await Bun.write(
		join(consumer, "app.ts"),
		`import { createElement, type ReactElement } from "react";
import { ConnectButton, TabMcpProvider, useTabMcp, useTabMcpState, useTool, useToolCalls, type TabMcpSnapshot } from "@ractive-ch/tab-mcp-client/react";
import type { TabMcp } from "@ractive-ch/tab-mcp-client";
function Tools(): ReactElement {
	useTool({ name: "add", description: "Add", execute: ({ a, b }) => Number(a) + Number(b) }, [1], { webmcp: true });
	const state: TabMcpSnapshot = useTabMcpState();
	const mcp: TabMcp = useTabMcp();
	const calls = useToolCalls({ limit: 5 });
	return createElement("p", null, state.state, state.identity, state.reconnecting?.attempt, mcp.tools.length, calls[0]?.end?.outcome);
}
export const app: ReactElement = createElement(
	TabMcpProvider,
	{ relay: "https://relay.example", server: { name: "x", version: "1" }, reconnect: { delaysMs: [1000] } },
	createElement(Tools),
	createElement(ConnectButton, { className: "ai", children: (s: TabMcpSnapshot) => s.state }),
);
// Without a relay: tools through serve and WebMCP only.
export const local: ReactElement = createElement(TabMcpProvider, { server: { name: "x", version: "1" }, webmcp: true });
// @ts-expect-error: the provider needs a server, or a client
export const broken: ReactElement = createElement(TabMcpProvider, { appName: "x" });
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
				paths: {
					"@ractive-ch/tab-mcp-client": [join(dist, "index.d.ts")],
					"@ractive-ch/tab-mcp-client/react": [join(dist, "react.d.ts")],
					"@ractive-ch/tab-mcp-client/setup": [join(dist, "setup.d.ts")],
					"@ractive-ch/tab-mcp-client/tunnel": [join(dist, "tunnel.d.ts")],
					react: [join(root, "node_modules/@types/react")],
				},
			},
			files: ["page.ts", "app.ts"],
		}),
	);
	const tsc = Bun.spawnSync(
		["bunx", "tsc", "-p", join(consumer, "tsconfig.json")],
		{ cwd: root },
	);
	expect(tsc.stdout.toString() + tsc.stderr.toString()).toBe("");
	expect(tsc.exitCode).toBe(0);
}, 60_000);

test("docs and plugin manifests name only the current package versions", async () => {
	const repo = join(root, "../..");
	const version = async (dir: string) =>
		(await Bun.file(join(repo, dir, "package.json")).json()).version as string;
	const client = await version("packages/tab-mcp-client");
	const relay = await version("packages/tab-mcp");
	// tab-mcp for Chrome (Chrome Web Store), named in SECURITY.md and the docs:
	// its version is accepted only where it follows the extension's name.
	const extension = await version("packages/tab-mcp-extension");
	const current = new Set([client, relay]);
	const wrong: string[] = [];
	for (const file of PINNED_FILES) {
		const text = await Bun.file(join(repo, file)).text();
		const check = (pattern: RegExp, allowed: (v: string) => boolean) => {
			for (const m of text.matchAll(pattern)) {
				const v = m[1] ?? "";
				if (!allowed(v)) wrong.push(`${file}: ${m[0]}`);
			}
		};
		// npm install specs, CDN links: `@ractive-ch/tab-mcp-client@<v>`.
		check(/@ractive-ch\/tab-mcp-client@([^\s/"'`)]*)/g, (v) => v === client);
		check(/@ractive-ch\/tab-mcp@([^\s/"'`)]*)/g, (v) => v === relay);
		// Images `ractive/tab-mcp:<tag>` and `ghcr.io/ractive/tab-mcp:<tag>`.
		check(/ractive\/tab-mcp:([A-Za-z0-9._-]+)/g, (v) => v === relay);
		// Any other 0.x version (not part of an IP address such as 127.0.0.1);
		// widen the pattern when a package reaches 1.0. The extension's version
		// only right after its name.
		const named = new Set(
			[...text.matchAll(/tab-mcp for Chrome[^\n]{0,60}?(0\.\d+\.\d+)/g)].map(
				(m) => m.index + m[0].length - (m[1] ?? "").length,
			),
		);
		for (const m of text.matchAll(
			/(?<![\d.])(0\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)(?![.\d])/g,
		)) {
			const v = m[1] ?? "";
			const ok = current.has(v) || (named.has(m.index) && v === extension);
			if (!ok) wrong.push(`${file}: ${m[0]}`);
		}
		if (file.endsWith(".json")) {
			const json = JSON.parse(text) as {
				version?: string;
				plugins?: { version?: string }[];
			};
			for (const v of [
				json.version,
				...(json.plugins ?? []).map((p) => p.version),
			])
				if (v !== undefined && !current.has(v))
					wrong.push(`${file}: version ${v}`);
		}
	}
	expect(wrong).toEqual([]);
});
