/**
 * The npm package layout (DEC-068): `scripts/build.ts` produces a package
 * whose `bin` runs on Bun and whose declarations type-check for a consumer.
 */
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const repo = join(root, "../..");

const consumer = mkdtempSync(join(tmpdir(), "tab-mcp-consumer-"));
afterAll(() => rmSync(consumer, { recursive: true, force: true }));

test("the build produces a runnable bin and declarations that type-check", async () => {
	const build = Bun.spawnSync(["bun", join(root, "scripts/build.ts")], {
		cwd: root,
	});
	expect(build.stderr.toString()).toBe("");
	expect(build.exitCode).toBe(0);
	const dist = join(root, "dist");
	const source = (await Bun.file(join(root, "package.json")).json()) as Record<
		string,
		unknown
	>;
	const pkg = (await Bun.file(join(dist, "package.json")).json()) as Record<
		string,
		unknown
	>;
	expect(source["private"]).toBe(true);
	expect(pkg["private"]).toBeUndefined();
	expect(pkg["version"]).toBe(source["version"]);
	expect(pkg["bin"]).toEqual({ "tab-mcp": "./main.js" });
	expect(pkg["exports"]).toEqual({
		".": { types: "./index.d.ts", default: "./index.js" },
		"./testing": { types: "./testing.d.ts", default: "./testing.js" },
	});
	expect(pkg["dependencies"]).toBeUndefined();
	expect(pkg["publishConfig"]).toEqual({ access: "public" });
	for (const file of ["README.md", "LICENSE", "AI_NOTICE"]) {
		expect(await Bun.file(join(dist, file)).exists()).toBe(true);
	}

	const main = await Bun.file(join(dist, "main.js")).text();
	expect(main.startsWith("#!/usr/bin/env bun\n")).toBe(true);
	// Only the version is taken from package.json, not the whole file.
	expect(main).not.toContain("devDependencies");
	const version = Bun.spawnSync(["bun", join(dist, "main.js"), "--version"]);
	expect(version.stdout.toString()).toBe(`${source["version"]}\n`);

	for await (const file of new Bun.Glob("**/*.d.ts").scan(dist)) {
		const text = await Bun.file(join(dist, file)).text();
		expect(text).not.toMatch(/["']\.{1,2}\/[^"']+\.ts["']/);
	}

	await Bun.write(
		join(consumer, "server.ts"),
		`import { createRelay, MemoryTokenStore, type Relay, type RevokeOptions, type TokenStore, VERSION } from "@ractive-ch/tab-mcp";
import { tokenStoreConformance } from "@ractive-ch/tab-mcp/testing";
const store: TokenStore = new MemoryTokenStore();
const revokeOptions: RevokeOptions = { now: 0, keepUntil: 1 };
export const revoked: Promise<number> = store.revoke({ grantId: "g" }, revokeOptions);
export const relay: Relay = createRelay({ publicUrl: "https://relay.example", allowedOrigins: ["https://app.example"], store });
tokenStoreConformance("memory", () => new MemoryTokenStore());
export const v: string = VERSION;
// @ts-expect-error: unknown options are type errors
createRelay({ publicUrl: "https://relay.example", nope: true });
`,
	);
	await Bun.write(
		join(consumer, "tsconfig.json"),
		JSON.stringify({
			compilerOptions: {
				target: "ESNext",
				module: "Preserve",
				moduleResolution: "bundler",
				lib: ["ESNext"],
				types: ["bun"],
				typeRoots: [join(repo, "node_modules/@types")],
				strict: true,
				noEmit: true,
				skipLibCheck: false,
				paths: {
					"@ractive-ch/tab-mcp": [join(dist, "index.d.ts")],
					"@ractive-ch/tab-mcp/testing": [join(dist, "testing.d.ts")],
				},
			},
			files: ["server.ts"],
		}),
	);
	const tsc = Bun.spawnSync(
		["bunx", "tsc", "-p", join(consumer, "tsconfig.json")],
		{ cwd: root },
	);
	expect(tsc.stdout.toString() + tsc.stderr.toString()).toBe("");
	expect(tsc.exitCode).toBe(0);
}, 60_000);
