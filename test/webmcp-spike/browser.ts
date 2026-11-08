/**
 * Chrome over the DevTools Protocol for the WebMCP spike: Chrome for Testing
 * with the test extension loaded, pages, and evaluation in the page's world,
 * in the extension's isolated world, or in its service worker. Like
 * `packages/tab-mcp-client/test/cdp.ts`, with extensions on.
 */

import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { Subprocess } from "bun";

/** Chrome's major version, from `--version`; 0 if it does not say. */
export function chromeMajor(binary: string): number {
	const { stdout } = Bun.spawnSync([binary, "--version"]);
	return Number(/(\d+)\.\d+\.\d+/.exec(stdout.toString())?.[1] ?? 0);
}

/**
 * Chrome for Testing: `CHROME_PATH`, else the newest one in Puppeteer's or
 * Playwright's cache. Branded Chrome ignores `--load-extension`.
 */
export function findChromeForTesting(): string | undefined {
	const fromEnv = process.env["CHROME_PATH"];
	if (fromEnv) return fromEnv;
	const binaries = [
		"chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
		"chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
		"chrome-linux64/chrome",
	];
	const caches = [
		join(homedir(), ".cache/puppeteer/chrome"),
		join(homedir(), "Library/Caches/ms-playwright"),
		join(homedir(), ".cache/ms-playwright"),
	];
	const found: string[] = [];
	for (const cache of caches) {
		let dirs: string[];
		try {
			dirs = readdirSync(cache);
		} catch {
			continue;
		}
		for (const dir of dirs)
			for (const binary of binaries) {
				const path = join(cache, dir, binary);
				if (Bun.file(path).size > 0) found.push(path);
			}
	}
	return found
		.map((path) => ({ path, major: chromeMajor(path) }))
		.sort((a, b) => b.major - a.major)[0]?.path;
}

/**
 * The id Chrome gives an unpacked extension without a "key": the SHA-256 of
 * its absolute path, the first 32 hex digits written with a to p.
 */
export function unpackedExtensionId(dir: string): string {
	return [
		...createHash("sha256")
			.update(realpathSync(dir))
			.digest("hex")
			.slice(0, 32),
	]
		.map((h) => String.fromCharCode(97 + Number.parseInt(h, 16)))
		.join("");
}

type Pending = {
	resolve: (v: Record<string, unknown>) => void;
	reject: (e: Error) => void;
};

type Listener = (
	method: string,
	params: Record<string, unknown>,
	sessionId?: string,
) => void;

/** A response for a request Chrome makes. */
export interface Served {
	status: number;
	headers?: Record<string, string>;
	body: string | Uint8Array;
}

/** Answers a page's requests in place of the network. */
export type Serve = (url: string) => Served | Promise<Served>;

export interface LaunchOptions {
	/** An unpacked extension to load. */
	extension?: string;
	/** More command-line switches, such as the one that turns WebMCP on. */
	args?: string[];
	/** `chrome://flags` entries to turn on, written to the profile's `Local State`. */
	labs?: string[];
	/**
	 * Answer every request of the pages (and their frames) through the
	 * DevTools Protocol's Fetch domain: made-up https origins, no server and
	 * no network.
	 */
	serve?: Serve;
}

interface ExecutionContext {
	id: number;
	name: string;
	origin: string;
	auxData?: { type?: string; frameId?: string; isDefault?: boolean };
}

/** An execution context in a page or one of its out-of-process frames. */
export interface World {
	sessionId: string;
	contextId: number;
}

interface Remote {
	value?: unknown;
	description?: string;
}

interface Evaluated {
	result: Remote;
	exceptionDetails?: { exception?: Remote; text: string };
}

export class Browser {
	readonly #proc: Subprocess<"ignore", "ignore", "pipe">;
	readonly #profile: string;
	readonly #ws: WebSocket;
	readonly #pending = new Map<number, Pending>();
	readonly #listeners = new Set<Listener>();
	readonly serve: Serve | undefined;
	#nextId = 0;

	private constructor(
		proc: Subprocess<"ignore", "ignore", "pipe">,
		profile: string,
		ws: WebSocket,
		serve: Serve | undefined,
	) {
		this.#proc = proc;
		this.#profile = profile;
		this.#ws = ws;
		this.serve = serve;
		ws.addEventListener("message", (e) => {
			const msg = JSON.parse(String(e.data)) as {
				id?: number;
				result?: Record<string, unknown>;
				error?: { message: string };
				method?: string;
				params?: Record<string, unknown>;
				sessionId?: string;
			};
			if (msg.id !== undefined) {
				const p = this.#pending.get(msg.id);
				this.#pending.delete(msg.id);
				if (msg.error) p?.reject(new Error(msg.error.message));
				else p?.resolve(msg.result ?? {});
			} else if (msg.method !== undefined) {
				for (const l of this.#listeners)
					l(msg.method, msg.params ?? {}, msg.sessionId);
			}
		});
		if (serve)
			this.on((method, params, sessionId) => {
				if (method !== "Fetch.requestPaused") return;
				const { url } = params["request"] as { url: string };
				void (async () => {
					const served = await serve(url);
					await this.send(
						"Fetch.fulfillRequest",
						{
							requestId: params["requestId"],
							responseCode: served.status,
							responseHeaders: Object.entries(served.headers ?? {}).map(
								([name, value]) => ({ name, value }),
							),
							body: Buffer.from(served.body).toString("base64"),
						},
						sessionId,
					);
				})();
			});
	}

	static async launch(
		binary: string,
		options: LaunchOptions = {},
	): Promise<Browser> {
		const profile = mkdtempSync(join(tmpdir(), "webmcp-spike-"));
		if (options.labs?.length)
			await Bun.write(
				join(profile, "Local State"),
				JSON.stringify({
					browser: { enabled_labs_experiments: options.labs },
				}),
			);
		const proc = Bun.spawn(
			[
				binary,
				"--headless=new",
				"--remote-debugging-port=0",
				`--user-data-dir=${profile}`,
				"--no-first-run",
				"--no-default-browser-check",
				"--disable-gpu",
				"--disable-background-networking",
				// No "Chromium Safe Storage" keychain prompt for a throwaway profile.
				"--use-mock-keychain",
				"--password-store=basic",
				...(options.extension
					? [
							`--disable-extensions-except=${options.extension}`,
							`--load-extension=${options.extension}`,
						]
					: ["--disable-extensions"]),
				...(options.args ?? []),
				...(process.platform === "linux" ? ["--no-sandbox"] : []),
				"about:blank",
			],
			{ stdin: "ignore", stdout: "ignore", stderr: "pipe" },
		);
		const endpoint = await new Promise<string>((resolve, reject) => {
			const timer = setTimeout(
				() => reject(new Error("Chrome did not start")),
				20_000,
			);
			void (async () => {
				const decoder = new TextDecoder();
				let text = "";
				for await (const chunk of proc.stderr) {
					text += decoder.decode(chunk, { stream: true });
					const m = /DevTools listening on (ws:\/\/\S+)/.exec(text);
					if (m?.[1] !== undefined) {
						clearTimeout(timer);
						resolve(m[1]);
						return;
					}
				}
				reject(new Error(`Chrome exited: ${text.slice(-500)}`));
			})();
		});
		const ws = new WebSocket(endpoint);
		await new Promise<void>((resolve, reject) => {
			ws.addEventListener("open", () => resolve(), { once: true });
			ws.addEventListener(
				"error",
				() => reject(new Error("CDP connection failed")),
				{ once: true },
			);
		});
		return new Browser(proc, profile, ws, options.serve);
	}

	send(
		method: string,
		params: Record<string, unknown> = {},
		sessionId?: string,
	): Promise<Record<string, unknown>> {
		const id = ++this.#nextId;
		this.#ws.send(
			JSON.stringify({
				id,
				method,
				params,
				...(sessionId ? { sessionId } : {}),
			}),
		);
		return new Promise((resolve, reject) =>
			this.#pending.set(id, { resolve, reject }),
		);
	}

	/** Every event, until the returned function is called. */
	on(listener: Listener): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	/** The next event `method` (optionally for one session). */
	event(method: string, sessionId?: string): Promise<Record<string, unknown>> {
		return new Promise((resolve) => {
			const off = this.on((m, params, s) => {
				if (m === method && (sessionId === undefined || s === sessionId)) {
					off();
					resolve(params);
				}
			});
		});
	}

	/** Open `url` in a new tab and wait for its load event. */
	async newPage(url: string): Promise<Page> {
		const { targetId } = (await this.send("Target.createTarget", {
			url: "about:blank",
		})) as { targetId: string };
		const { sessionId } = (await this.send("Target.attachToTarget", {
			targetId,
			flatten: true,
		})) as { sessionId: string };
		const page = new Page(this, sessionId, targetId);
		await page.attached(sessionId);
		await page.send("Page.enable");
		await page.goto(url);
		return page;
	}

	/** The service worker of extension `id`, to call `chrome.*` from. */
	async serviceWorker(id: string): Promise<Worker> {
		const prefix = `chrome-extension://${id}/`;
		for (let attempt = 0; attempt < 50; attempt++) {
			const { targetInfos } = (await this.send("Target.getTargets")) as {
				targetInfos: { targetId: string; type: string; url: string }[];
			};
			const target = targetInfos.find(
				(t) => t.type === "service_worker" && t.url.startsWith(prefix),
			);
			if (target) {
				const { sessionId } = (await this.send("Target.attachToTarget", {
					targetId: target.targetId,
					flatten: true,
				})) as { sessionId: string };
				const worker = new Worker(this, sessionId);
				await worker.send("Runtime.enable");
				return worker;
			}
			await Bun.sleep(100);
		}
		throw new Error(`the service worker of ${id} did not start`);
	}

	async close(): Promise<void> {
		try {
			await Promise.race([this.send("Browser.close"), Bun.sleep(2000)]);
		} catch {
			// already gone
		}
		this.#ws.close();
		if (this.#proc.exitCode === null) this.#proc.kill("SIGKILL");
		await this.#proc.exited;
		rmSync(this.#profile, { recursive: true, force: true });
	}
}

function resultOf<T>(r: Evaluated): T {
	if (r.exceptionDetails)
		throw new Error(
			r.exceptionDetails.exception?.description ?? r.exceptionDetails.text,
		);
	return r.result.value as T;
}

/** A target that evaluates JavaScript: a page or a service worker. */
class Target {
	readonly browser: Browser;
	readonly sessionId: string;

	constructor(browser: Browser, sessionId: string) {
		this.browser = browser;
		this.sessionId = sessionId;
	}

	send(
		method: string,
		params: Record<string, unknown> = {},
	): Promise<Record<string, unknown>> {
		return this.browser.send(method, params, this.sessionId);
	}

	/**
	 * Evaluate an expression (awaiting promises) and return its JSON value, in
	 * the target's default context or in `world`.
	 */
	async eval<T = unknown>(expression: string, world?: World): Promise<T> {
		return resultOf<T>(
			(await this.browser.send(
				"Runtime.evaluate",
				{
					expression,
					awaitPromise: true,
					returnByValue: true,
					...(world === undefined ? {} : { contextId: world.contextId }),
				},
				world?.sessionId ?? this.sessionId,
			)) as unknown as Evaluated,
		);
	}
}

export class Worker extends Target {}

export class Page extends Target {
	readonly targetId: string;
	readonly console: string[] = [];
	/** Contexts of the page and of its out-of-process frames, by session. */
	readonly #contexts = new Map<string, Map<number, ExecutionContext>>();

	constructor(browser: Browser, sessionId: string, targetId: string) {
		super(browser, sessionId);
		this.targetId = targetId;
		browser.on((method, params, s) => {
			const contexts = s === undefined ? undefined : this.#contexts.get(s);
			if (s === undefined || contexts === undefined) return;
			if (method === "Runtime.executionContextCreated") {
				const context = params["context"] as ExecutionContext;
				contexts.set(context.id, context);
			} else if (method === "Runtime.executionContextDestroyed") {
				contexts.delete(params["executionContextId"] as number);
			} else if (method === "Runtime.executionContextsCleared") {
				contexts.clear();
			} else if (method === "Runtime.consoleAPICalled") {
				const args = params["args"] as Remote[];
				this.console.push(args.map((a) => a.value ?? a.description).join(" "));
			} else if (method === "Target.attachedToTarget") {
				// An out-of-process frame (site isolation): a session of its own.
				void this.attached(params["sessionId"] as string);
			}
		});
	}

	/** Start watching a session of this page: contexts, frames, requests. */
	async attached(sessionId: string): Promise<void> {
		this.#contexts.set(sessionId, new Map());
		const send = (method: string, params: Record<string, unknown> = {}) =>
			this.browser.send(method, params, sessionId);
		if (this.browser.serve)
			await send("Fetch.enable", { patterns: [{ urlPattern: "*" }] });
		await send("Runtime.enable");
		await send("Target.setAutoAttach", {
			autoAttach: true,
			waitForDebuggerOnStart: true,
			flatten: true,
		});
		if (sessionId !== this.sessionId)
			await send("Runtime.runIfWaitingForDebugger");
	}

	async goto(url: string): Promise<void> {
		const loaded = this.browser.event("Page.loadEventFired", this.sessionId);
		await this.send("Page.navigate", { url });
		await loaded;
	}

	/**
	 * The isolated world called `name` (an extension's content scripts run in
	 * one named after the extension) in the top frame, or in the frame whose
	 * page is of `origin`.
	 */
	async isolatedWorld(name: string, origin?: string): Promise<World> {
		for (let attempt = 0; attempt < 50; attempt++) {
			const all = [...this.#contexts].flatMap(([sessionId, contexts]) =>
				[...contexts.values()].map((c) => ({ sessionId, c })),
			);
			// An isolated world's origin is the extension's: find the frame by
			// the page's own (default) context there.
			const frameId =
				origin === undefined
					? this.targetId
					: all.find(({ c }) => c.auxData?.isDefault && c.origin === origin)?.c
							.auxData?.frameId;
			const found = all.find(
				({ c }) =>
					c.name === name &&
					c.auxData?.type === "isolated" &&
					c.auxData.frameId === frameId,
			);
			if (found) return { sessionId: found.sessionId, contextId: found.c.id };
			await Bun.sleep(100);
		}
		const seen = [...this.#contexts.values()].flatMap((contexts) =>
			[...contexts.values()].map(
				(c) => `${c.name || "(main)"} ${c.auxData?.type} ${c.origin}`,
			),
		);
		throw new Error(
			`no isolated world "${name}" in ${origin ?? "the page"}; contexts: ${seen.join(", ")}`,
		);
	}
}
