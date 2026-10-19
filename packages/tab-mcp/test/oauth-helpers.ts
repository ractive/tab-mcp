/**
 * OAuth test helpers: an HTTPS server for Client ID Metadata Documents with a
 * throwaway self-signed certificate, a relay with the test-only CIMD switch,
 * PKCE, and a tiny "browser" that completes the `/authorize` page.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger } from "../src/log.ts";
import {
	type CreateRelayOptions,
	createTestRelay,
	type Relay,
	type RelayTestHooks,
} from "../src/relay.ts";
import { MemoryTokenStore } from "../src/store/memory.ts";
import type { TokenStore } from "../src/store/types.ts";
import { LogCapture } from "./helpers.ts";

let certificate: Promise<{ cert: string; key: string }> | undefined;

/** A self-signed certificate for localhost and 127.0.0.1, made once per process. */
export function testCertificate(): Promise<{ cert: string; key: string }> {
	certificate ??= (async () => {
		const dir = mkdtempSync(join(tmpdir(), "tab-mcp-cert-"));
		try {
			const keyPath = join(dir, "key.pem");
			const certPath = join(dir, "cert.pem");
			const result = Bun.spawnSync([
				"openssl",
				"req",
				"-x509",
				"-newkey",
				"ec",
				"-pkeyopt",
				"ec_paramgen_curve:prime256v1",
				"-nodes",
				"-keyout",
				keyPath,
				"-out",
				certPath,
				"-days",
				"2",
				"-subj",
				"/CN=localhost",
				"-addext",
				"subjectAltName=DNS:localhost,IP:127.0.0.1",
			]);
			if (result.exitCode !== 0) {
				throw new Error(
					`openssl failed: ${result.stderr.toString().slice(0, 500)}`,
				);
			}
			return {
				cert: await Bun.file(certPath).text(),
				key: await Bun.file(keyPath).text(),
			};
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	})();
	return certificate;
}

export type CimdHandler = (req: Request) => Response | Promise<Response>;

/** An HTTPS server for client metadata documents. */
export interface CimdServer {
	readonly origin: string;
	readonly ca: string;
	/** Requests seen, by path. */
	readonly hits: Map<string, number>;
	/** Serve a document (or a handler) at a path; returns its URL (the client id). */
	serve(path: string, doc: Record<string, unknown> | CimdHandler): string;
	/** A typical public client document for a client id URL. */
	document(
		clientId: string,
		extra?: Record<string, unknown>,
	): Record<string, unknown>;
	stop(): Promise<void>;
}

export async function startCimdServer(): Promise<CimdServer> {
	const { cert, key } = await testCertificate();
	const routes = new Map<string, CimdHandler>();
	const hits = new Map<string, number>();
	const server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		tls: { cert, key },
		fetch: (req) => {
			const path = new URL(req.url).pathname;
			hits.set(path, (hits.get(path) ?? 0) + 1);
			const handler = routes.get(path);
			return handler === undefined
				? new Response("Not found", { status: 404 })
				: handler(req);
		},
	});
	const origin = `https://localhost:${server.port}`;
	return {
		origin,
		ca: cert,
		hits,
		serve(path, doc) {
			routes.set(
				path,
				typeof doc === "function" ? doc : () => Response.json(doc),
			);
			return `${origin}${path}`;
		},
		document(clientId, extra = {}) {
			return {
				client_id: clientId,
				client_name: "Test AI",
				redirect_uris: ["http://127.0.0.1/callback", "https://app.example/cb"],
				grant_types: ["authorization_code", "refresh_token"],
				response_types: ["code"],
				token_endpoint_auth_method: "none",
				...extra,
			};
		},
		stop: () => server.stop(true),
	};
}

export interface OAuthTestRelay {
	relay: Relay;
	store: TokenStore;
	logs: LogCapture;
	url: string;
	wsUrl: string;
	stop(): Promise<void>;
}

/** A relay with the test-only CIMD switch for the fixture server. */
export function startOAuthRelay(
	cimd: CimdServer,
	options: CreateRelayOptions = {},
	hooks: RelayTestHooks = {},
): OAuthTestRelay {
	const store = new MemoryTokenStore();
	const logs = new LogCapture();
	const relay = createTestRelay(
		{
			development: true,
			port: 0,
			host: "127.0.0.1",
			allowedOrigins: ["https://page.example"],
			store,
			logger: logs.logger,
			...options,
		},
		{ cimd: { ca: cimd.ca }, ...hooks },
	);
	return {
		relay,
		store,
		logs,
		url: relay.url,
		wsUrl: `ws://127.0.0.1:${relay.port}/tab`,
		stop: () => relay.stop(),
	};
}

export const quietLogger = createLogger("error", () => {});

/** A PKCE verifier and its S256 challenge. */
export function pkce(): { verifier: string; challenge: string } {
	const verifier = crypto
		.getRandomValues(new Uint8Array(32))
		.toBase64({ alphabet: "base64url", omitPadding: true });
	const challenge = new Bun.CryptoHasher("sha256")
		.update(verifier)
		.digest()
		.toBase64({ alphabet: "base64url", omitPadding: true });
	return { verifier, challenge };
}

/** An `/authorize` URL with the usual parameters, overridable (undefined drops one). */
export function authorizeUrl(
	relayUrl: string,
	params: Record<string, string | undefined>,
): string {
	const url = new URL(`${relayUrl}/authorize`);
	const all: Record<string, string | undefined> = {
		response_type: "code",
		code_challenge_method: "S256",
		state: "st-1",
		scope: "tools",
		...params,
	};
	for (const [k, v] of Object.entries(all)) {
		if (v !== undefined) url.searchParams.set(k, v);
	}
	return url.href;
}

/** A form on the authorize page. */
export interface AuthorizePage {
	status: number;
	html: string;
	requestId: string | undefined;
	csrf: string | undefined;
	headers: Headers;
}

/** A minimal browser: one cookie jar, no redirects followed. */
export class TestBrowser {
	readonly #cookies = new Map<string, string>();
	readonly relayUrl: string;
	/** Sent with every request, e.g. `x-real-ip` behind a trusted proxy. */
	readonly #headers: Record<string, string>;

	constructor(relayUrl: string, headers: Record<string, string> = {}) {
		this.relayUrl = relayUrl;
		this.#headers = headers;
	}

	#remember(res: Response): void {
		for (const c of res.headers.getSetCookie()) {
			const [pair] = c.split(";");
			const [k, v] = (pair ?? "").split("=");
			if (k !== undefined && v !== undefined) this.#cookies.set(k, v);
		}
	}

	#cookieHeader(): Record<string, string> {
		if (this.#cookies.size === 0) return { ...this.#headers };
		return {
			...this.#headers,
			cookie: [...this.#cookies].map(([k, v]) => `${k}=${v}`).join("; "),
		};
	}

	async #page(res: Response): Promise<AuthorizePage> {
		this.#remember(res);
		const html = await res.text();
		return {
			status: res.status,
			html,
			requestId: /name="request_id" value="([^"]+)"/.exec(html)?.[1],
			csrf: /name="csrf" value="([^"]+)"/.exec(html)?.[1],
			headers: res.headers,
		};
	}

	/** GET a page (redirects are returned, not followed). */
	async open(url: string): Promise<AuthorizePage & { location?: string }> {
		const res = await fetch(url, {
			redirect: "manual",
			headers: this.#cookieHeader(),
		});
		const location = res.headers.get("location") ?? undefined;
		const page = await this.#page(res);
		return location === undefined ? page : { ...page, location };
	}

	/** Submit the authorize form. */
	async submit(
		page: AuthorizePage,
		fields: Record<string, string>,
		headers: Record<string, string> = {},
	): Promise<AuthorizePage & { location?: string }> {
		const body = new URLSearchParams({
			request_id: page.requestId ?? "",
			csrf: page.csrf ?? "",
			...fields,
		});
		const res = await fetch(`${this.relayUrl}/authorize`, {
			method: "POST",
			redirect: "manual",
			headers: {
				"content-type": "application/x-www-form-urlencoded",
				origin: this.relayUrl,
				"sec-fetch-site": "same-origin",
				...this.#cookieHeader(),
				...headers,
			},
			body,
		});
		const location = res.headers.get("location") ?? undefined;
		const result = await this.#page(res);
		return location === undefined ? result : { ...result, location };
	}
}

/** POST a form to the relay's token or revocation endpoint. */
export async function postForm(
	url: string,
	fields: Record<string, string | undefined>,
	headers: Record<string, string> = {},
): Promise<Response> {
	const body = new URLSearchParams();
	for (const [k, v] of Object.entries(fields)) {
		if (v !== undefined) body.append(k, v);
	}
	return fetch(url, {
		method: "POST",
		headers: {
			"content-type": "application/x-www-form-urlencoded",
			...headers,
		},
		body,
	});
}
