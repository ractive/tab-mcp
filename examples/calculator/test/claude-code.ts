#!/usr/bin/env bun
/**
 * Headless Claude Code against the calculator (iteration 4). Local only,
 * never in CI: it needs a Claude login and spends tokens (DEC-037).
 *
 * The same stack as the e2e test (relay, calculator page in headless Chrome,
 * the SDK client pairing with the code from the page) obtains an access
 * token; `claude -p` gets it through `${TABMCP_TOKEN}` in its MCP config, so
 * the token is never written to a file. Then:
 *
 * 1. `claude -p "Use the calculator to compute 12*12"` with only the
 *    calculator's tools allowed; the page must show 144.
 * 2. The same with `MCP_PROTOCOL_NEGOTIATION=legacy`: Claude Code speaks the
 *    old handshake and the relay must answer `initialize` with the documented
 *    400 / -32022 (DEC-033); the server fails to connect and no key is pressed.
 *
 * Run: `bun run e2e:claude` (CHROME_PATH or a usual Chrome location; CLAUDE
 * for another `claude` binary). Exits non-zero if a check fails.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	clickButton,
	findChrome,
	openCalculator,
	type Page,
	pair,
	startStack,
	waitFor,
} from "./stack.ts";

const PROMPT = "Use the calculator to compute 12*12";

const chrome = findChrome();
if (chrome === undefined) {
	process.stderr.write("No Chrome found; set CHROME_PATH.\n");
	process.exit(2);
}
const claude = process.env["CLAUDE"] ?? Bun.which("claude");
if (claude === null || claude === undefined) {
	process.stderr.write("No claude binary found; set CLAUDE.\n");
	process.exit(2);
}

const display = (page: Page) =>
	page.eval<string>("document.querySelector('#display-value').textContent");

interface Run {
	exitCode: number;
	stdout: string;
	stderr: string;
	debug: string;
}

/**
 * A pass-through proxy in front of the relay that records every answer, so
 * the legacy check sees the status and JSON-RPC error the relay sent (Claude
 * Code's debug log has only the status).
 */
function recordingProxy(target: string) {
	const answers: { status: number; body: string }[] = [];
	const server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		fetch: async (req) => {
			const url = new URL(req.url);
			const headers = new Headers(req.headers);
			headers.delete("host");
			const response = await fetch(`${target}${url.pathname}${url.search}`, {
				method: req.method,
				headers,
				body:
					req.method === "GET" || req.method === "HEAD"
						? null
						: await req.text(),
			});
			const body = await response.text();
			answers.push({ status: response.status, body });
			return new Response(body, {
				status: response.status,
				headers: response.headers,
			});
		},
	});
	return {
		url: `http://127.0.0.1:${server.port}`,
		answers,
		stop: () => server.stop(true),
	};
}

function writeConfig(dir: string, url: string): Promise<number> {
	return Bun.write(
		join(dir, "cfg.json"),
		JSON.stringify({
			mcpServers: {
				calc: {
					type: "http",
					url,
					// biome-ignore lint/suspicious/noTemplateCurlyInString: Claude Code expands it, not JavaScript
					headers: { Authorization: "Bearer ${TABMCP_TOKEN}" },
				},
			},
		}),
	);
}

async function runClaude(
	dir: string,
	token: string,
	extraEnv: Record<string, string>,
	name: string,
): Promise<Run> {
	const debugFile = join(dir, `${name}.debug.log`);
	const proc = Bun.spawn(
		[
			claude as string,
			"-p",
			"--mcp-config",
			join(dir, "cfg.json"),
			"--strict-mcp-config",
			"--allowedTools",
			"mcp__calc__*",
			"--max-turns",
			"6",
			"--debug-file",
			debugFile,
			PROMPT,
		],
		{
			cwd: dir,
			env: { ...process.env, ...extraEnv, TABMCP_TOKEN: token },
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	const timer = setTimeout(() => proc.kill(), 180_000);
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	clearTimeout(timer);
	const log = Bun.file(debugFile);
	const debug = (await log.exists()) ? await log.text() : "";
	// The debug log can hold the Authorization header; drop the token.
	return {
		exitCode,
		stdout,
		stderr,
		debug: debug.replaceAll(token, "<token>"),
	};
}

const dir = mkdtempSync(join(tmpdir(), "tab-mcp-claude-"));
const stack = await startStack(chrome);
let failed = false;
const check = (ok: boolean, what: string) => {
	process.stdout.write(`${ok ? "ok  " : "FAIL"} ${what}\n`);
	if (!ok) failed = true;
};

try {
	const page = await openCalculator(stack);
	const pairing = await pair(stack, page, stack.clientId());
	await clickButton(page, "dialog.tab-mcp-connect", "Close");
	const token = pairing.provider.tokens()?.access_token;
	if (token === undefined) throw new Error("pairing gave no access token");
	await writeConfig(dir, pairing.address);
	const version = (
		await Bun.$`${claude} --version`.quiet().nothrow().text()
	).trim();
	process.stdout.write(
		`Claude Code ${version}\nMCP address ${pairing.address}\n`,
	);

	// 1. A real calculation.
	process.stdout.write(`\n$ claude -p ... "${PROMPT}"\n`);
	const run = await runClaude(dir, token, {}, "modern");
	process.stdout.write(`${run.stdout.trim()}\n`);
	if (run.stderr.trim() !== "")
		process.stdout.write(`(stderr) ${run.stderr.trim()}\n`);
	const shown = await display(page);
	process.stdout.write(`Page display: ${shown}\n`);
	check(run.exitCode === 0, `claude exited with ${run.exitCode}`);
	check(shown === "144", "the page shows 144");
	check(run.stdout.includes("144"), "Claude's answer says 144");

	// 2. Legacy negotiation is refused with the documented 400.
	await page.click('[data-key="C"]');
	await waitFor(
		page,
		"document.querySelector('#display-value').textContent === '0'",
	);
	process.stdout.write(
		`\n$ MCP_PROTOCOL_NEGOTIATION=legacy claude -p ... "${PROMPT}"\n`,
	);
	const relayOrigin = new URL(pairing.address).origin;
	const proxy = recordingProxy(relayOrigin);
	await writeConfig(dir, pairing.address.replace(relayOrigin, proxy.url));
	const legacy = await runClaude(
		dir,
		token,
		{ MCP_PROTOCOL_NEGOTIATION: "legacy" },
		"legacy",
	).finally(() => proxy.stop());
	process.stdout.write(`${legacy.stdout.trim()}\n`);
	for (const line of legacy.debug.split("\n")) {
		if (/MCP server "calc"/.test(line) && /failed/i.test(line))
			process.stdout.write(`(debug) ${line}\n`);
	}
	for (const answer of proxy.answers)
		process.stdout.write(`(relay) ${answer.status} ${answer.body}\n`);
	const refused = proxy.answers.find((a) => a.status === 400);
	check(
		refused !== undefined &&
			/"code":-32022/.test(refused.body) &&
			/"supported":\["2026-07-28"\]/.test(refused.body),
		"the relay answered the legacy initialize with 400 / -32022, supported 2026-07-28",
	);
	check(
		proxy.answers.every((a) => a.status !== 200),
		"no legacy request got through",
	);
	check((await display(page)) === "0", "no key was pressed in legacy mode");
} finally {
	await stack.stop();
	rmSync(dir, { recursive: true, force: true });
}

process.exit(failed ? 1 : 0);
