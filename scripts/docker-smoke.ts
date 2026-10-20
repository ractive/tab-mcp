/**
 * Smoke test of a built relay image (DEC-069): runs it the way a user would,
 * with a named volume on /data, and checks what the image promises.
 *
 *   docker build -t tab-mcp:smoke .
 *   bun scripts/docker-smoke.ts tab-mcp:smoke [--port 4875]
 *
 * Checks: `/healthz` answers with the package version; the process runs as
 * uid 65532, not root; the SQLite store lives in /data and survives a
 * restart; a tab from an allowed origin gets a session and an address, whose
 * MCP endpoint asks for OAuth (401 with resource metadata); a tab from
 * another origin is refused; `docker stop` ends it promptly (SIGTERM).
 * Removes its container and volume afterwards. Needs `docker` on PATH.
 */

import { join } from "node:path";
import { parseArgs } from "node:util";
import { $ } from "bun";

const { values, positionals } = parseArgs({
	args: Bun.argv.slice(2),
	allowPositionals: true,
	options: { port: { type: "string", default: "4875" } },
});
const image = positionals[0];
if (image === undefined || positionals.length !== 1) {
	console.error("usage: bun scripts/docker-smoke.ts <image> [--port N]");
	process.exit(2);
}
const port = Number(values.port);
const base = `http://127.0.0.1:${port}`;
const origin = "http://smoke.test";
const name = `tab-mcp-smoke-${process.pid}`;
const volume = `${name}-data`;
const pkg = (await Bun.file(
	join(import.meta.dir, "../packages/tab-mcp/package.json"),
).json()) as { version: string };

const problems: string[] = [];
function check(ok: boolean, what: string): void {
	console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
	if (!ok) problems.push(what);
}

async function waitHealthy(): Promise<Response> {
	const deadline = Date.now() + 20_000;
	for (;;) {
		try {
			const response = await fetch(`${base}/healthz`);
			if (response.ok) return response;
		} catch {
			// not listening yet
		}
		if (Date.now() > deadline) {
			await $`docker logs ${name}`.nothrow();
			throw new Error("the relay did not become healthy within 20 s");
		}
		await Bun.sleep(200);
	}
}

/** Open a tab WebSocket from `from`; resolves with the first message or the close code. */
function tab(
	from: string,
): Promise<{ message?: Record<string, unknown>; code?: number }> {
	return new Promise((resolve) => {
		const ws = new WebSocket(`ws://127.0.0.1:${port}/tab`, {
			headers: { Origin: from },
			protocols: ["tab-mcp.v1"],
		} as unknown as string[]);
		ws.addEventListener("open", () =>
			ws.send(
				JSON.stringify({
					type: "hello",
					library: { name: "docker-smoke", version: "0.0.0" },
					page: { title: "Smoke test" },
					secret: crypto
						.getRandomValues(new Uint8Array(32))
						.toBase64({ alphabet: "base64url", omitPadding: true }),
				}),
			),
		);
		ws.addEventListener("message", (e) => {
			resolve({ message: JSON.parse(String(e.data)) });
			ws.close();
		});
		ws.addEventListener("close", (e) => resolve({ code: e.code }));
		ws.addEventListener("error", () => resolve({ code: -1 }));
	});
}

try {
	await $`docker volume create ${volume}`.quiet();
	await $`docker run -d --name ${name} -p 127.0.0.1:${port}:8080 -v ${volume}:/data -e NODE_ENV=development -e TAB_MCP_PUBLIC_URL=${base} -e TAB_MCP_ALLOWED_ORIGINS=${origin} ${image}`.quiet();

	const health = (await (await waitHealthy()).json()) as Record<
		string,
		unknown
	>;
	check(health["status"] === "ok", "/healthz says ok");
	check(
		health["version"] === pkg.version,
		`/healthz names version ${pkg.version} (got ${String(health["version"])})`,
	);

	const id =
		await $`docker exec ${name} /usr/local/bin/bun -e ${"console.log(process.getuid() + ':' + process.getgid())"}`.text();
	check(id.trim() === "65532:65532", `runs as 65532:65532 (got ${id.trim()})`);

	const session = await tab(origin);
	const address = session.message?.["address"];
	check(
		session.message?.["type"] === "session" && typeof address === "string",
		"a tab from the allowed origin gets a session and an address",
	);
	if (typeof address === "string") {
		const mcp = await fetch(address, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				accept: "application/json, text/event-stream",
				"mcp-protocol-version": "2026-07-28",
			},
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
		});
		await mcp.body?.cancel();
		const challenge = mcp.headers.get("www-authenticate") ?? "";
		const metadataUrl = /resource_metadata="([^"]+)"/.exec(challenge)?.[1];
		check(
			mcp.status === 401 && metadataUrl !== undefined,
			"MCP without a token gets 401 with resource metadata",
		);
		if (metadataUrl !== undefined) {
			const metadata = await fetch(metadataUrl);
			const body = (await metadata.json()) as Record<string, unknown>;
			check(
				metadata.ok && body["resource"] === address,
				"the resource metadata names the address",
			);
		}
	}
	const refused = await tab("https://other.example");
	check(refused.message === undefined, "a tab from another origin is refused");

	const files =
		await $`docker exec ${name} /usr/local/bin/bun -e ${"const fs = require('node:fs'); const s = fs.statSync('/data/tab-mcp.db'); console.log(s.uid + ' ' + fs.readdirSync('/data').join(','))"}`.text();
	check(
		files.startsWith("65532 ") && files.includes("tab-mcp.db"),
		`the SQLite store is in /data, owned by 65532 (${files.trim()})`,
	);

	const started = Date.now();
	await $`docker stop --timeout 10 ${name}`.quiet();
	const stopMs = Date.now() - started;
	check(stopMs < 5_000, `docker stop ends it promptly (${stopMs} ms)`);
	const logs = await $`docker logs ${name}`.text();
	check(logs.includes('"event":"relay.stop"'), "it logs relay.stop on SIGTERM");

	await $`docker start ${name}`.quiet();
	await waitHealthy();
	const after =
		await $`docker exec ${name} /usr/local/bin/bun -e ${"console.log(require('node:fs').existsSync('/data/tab-mcp.db'))"}`.text();
	check(after.trim() === "true", "the store survives a restart");
} finally {
	await $`docker rm -f ${name}`.quiet().nothrow();
	await $`docker volume rm ${volume}`.quiet().nothrow();
}

if (problems.length > 0) {
	console.error(`docker-smoke: ${problems.length} check(s) failed`);
	process.exit(1);
}
console.log("docker-smoke: all checks passed");
