/**
 * The image and the workflows use the Bun version the workspace is typed
 * against (@types/bun, pinned exactly), so a Dependabot bump of one of them
 * fails here until the others follow (DEC-071).
 */
import { expect, test } from "bun:test";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const read = (path: string) => Bun.file(join(root, path)).text();

test("Dockerfile, workflows and @types/bun name the same Bun version", async () => {
	const pkg = JSON.parse(await read("package.json")) as {
		devDependencies: Record<string, string>;
	};
	const bun = pkg.devDependencies["@types/bun"];
	expect(bun).toMatch(/^\d+\.\d+\.\d+$/);

	const dockerfile = await read("Dockerfile");
	const from = [
		...dockerfile.matchAll(/^FROM\s+(?:--platform=\S+\s+)?(\S+)/gm),
	].map((m) => m[1]);
	expect(from).toHaveLength(2);
	expect(from[0]).toMatch(
		new RegExp(`^oven/bun:${bun}-alpine@sha256:[0-9a-f]{64}$`),
	);
	expect(from[1]).toMatch(
		new RegExp(`^oven/bun:${bun}-distroless@sha256:[0-9a-f]{64}$`),
	);

	for (const workflow of ["ci.yml", "release.yml"]) {
		const text = await read(`.github/workflows/${workflow}`);
		const versions = [
			...text.matchAll(/(?:BUN_VERSION|bun-version):\s*"?([0-9.]+)"?/g),
		].map((m) => m[1]);
		expect(versions.length).toBeGreaterThan(0);
		for (const v of versions)
			expect(`${workflow}: ${v}`).toBe(`${workflow}: ${bun}`);
	}
});

test("the image runs as a non-root user with the SQLite store on /data", async () => {
	const dockerfile = await read("Dockerfile");
	expect(dockerfile).toMatch(/^USER 65532:65532$/m);
	expect(dockerfile).toContain("TAB_MCP_STORE=sqlite");
	expect(dockerfile).toContain("TAB_MCP_SQLITE_PATH=/data/tab-mcp.db");
	expect(dockerfile).toMatch(/^VOLUME \/data$/m);
	expect(dockerfile).toContain("--chown=65532:65532 /out/data/ /data/");
});
