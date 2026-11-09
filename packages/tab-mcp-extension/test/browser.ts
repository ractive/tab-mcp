/**
 * Chrome for Testing over the DevTools Protocol for the extension's
 * end-to-end tests: launched over a pipe (for the `Extensions` domain, as
 * Overmark's harness does), the extension loaded unpacked, pages served
 * through the Fetch domain on made-up https origins, evaluation in a page,
 * in its isolated worlds or in the service worker, and real clicks. From
 * `test/webmcp-spike/browser.ts`.
 */

import { mkdtempSync, readdirSync, rmSync } from "node:fs";
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
	/** An unpacked extension to load (`Extensions.loadUnpacked`). */
	extension?: string;
	/** More command-line switches, such as the one that turns WebMCP on. */
	args?: string[];
	/**
	 * Answer every request of the pages (and their frames) through the
	 * DevTools Protocol's Fetch domain: made-up https origins, no server and
	 * no network.
	 */
	serve?: Serve;
	/**
	 * The profile to use and keep (a restart of the same browser); by
	 * default a new one, removed on `close()`.
	 */
	profile?: string;
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

/** How CDP messages get to Chrome; what comes back goes to `receive`. */
interface Transport {
	send(message: string): void;
	/** Resolves once both ends are closed. */
	close(): Promise<void>;
}

/** `--remote-debugging-pipe`: Chrome reads fd 3 and writes fd 4, each message ends in NUL. */
function pipe(
	toChrome: number,
	fromChrome: number,
	receive: (message: string) => void,
	closed: () => void,
): Transport {
	const writer = Bun.file(toChrome).writer();
	const reading = (async () => {
		const decoder = new TextDecoder();
		let text = "";
		try {
			for await (const chunk of Bun.file(fromChrome).stream()) {
				text += decoder.decode(chunk, { stream: true });
				const messages = text.split("\0");
				text = messages.pop() ?? "";
				for (const message of messages) receive(message);
			}
		} catch {
			// The pipe went away.
		}
		closed();
	})();
	return {
		send(message) {
			writer.write(`${message}\0`);
			void writer.flush();
		},
		// The descriptors are numbers the next Chrome may get again: closing
		// them late would close that Chrome's pipe. So wait until both are shut.
		async close() {
			try {
				await writer.end();
			} catch {
				// already closed
			}
			await Promise.race([reading, Bun.sleep(5000)]);
		},
	};
}

type ChromeProcess = Subprocess<"ignore", "ignore", "ignore">;

export class Browser {
	readonly #proc: ChromeProcess;
	readonly #profile: string;
	readonly #keepProfile: boolean;
	readonly #transport: Transport;
	readonly #pending = new Map<number, Pending>();
	readonly #listeners = new Set<Listener>();
	readonly serve: Serve | undefined;
	/** The extension loaded at launch, if one was. */
	extensionId: string | undefined;
	#nextId = 0;

	private constructor(
		proc: ChromeProcess,
		profile: string,
		keepProfile: boolean,
		toChrome: number,
		fromChrome: number,
		serve: Serve | undefined,
	) {
		this.#proc = proc;
		this.#profile = profile;
		this.#keepProfile = keepProfile;
		this.serve = serve;
		this.#transport = pipe(
			toChrome,
			fromChrome,
			(message) => {
				const msg = JSON.parse(message) as {
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
			},
			// A closed connection (Chrome gone) fails every call still waiting.
			() => {
				for (const p of this.#pending.values())
					p.reject(new Error("the DevTools connection closed"));
				this.#pending.clear();
			},
		);
		if (serve)
			this.on((method, params, sessionId) => {
				if (method !== "Fetch.requestPaused") return;
				const { url } = params["request"] as { url: string };
				const requestId = params["requestId"];
				void (async () => {
					try {
						const served = await serve(url);
						await this.send(
							"Fetch.fulfillRequest",
							{
								requestId,
								responseCode: served.status,
								responseHeaders: Object.entries(served.headers ?? {}).map(
									([name, value]) => ({ name, value }),
								),
								body: Buffer.from(served.body).toString("base64"),
							},
							sessionId,
						);
					} catch (error) {
						// The page sees a failed request instead of waiting forever.
						console.error(`serving ${url} failed: ${error}`);
						await this.send(
							"Fetch.failRequest",
							{ requestId, errorReason: "Failed" },
							sessionId,
						).catch(() => {});
					}
				})();
			});
	}

	/**
	 * Launch over a pipe, the only connection on which Chrome offers the
	 * `Extensions` domain (loading an unpacked extension, clicking its icon),
	 * and load `options.extension` if given.
	 */
	static async launch(
		binary: string,
		options: LaunchOptions = {},
	): Promise<Browser> {
		const profile =
			options.profile ?? mkdtempSync(join(tmpdir(), "tab-mcp-extension-"));
		const keepProfile = options.profile !== undefined;
		let browser: Browser | undefined;
		let proc: ChromeProcess | undefined;
		try {
			proc = Bun.spawn(
				[
					binary,
					"--headless=new",
					"--remote-debugging-pipe",
					"--enable-unsafe-extension-debugging",
					`--user-data-dir=${profile}`,
					"--no-first-run",
					"--no-default-browser-check",
					"--disable-gpu",
					"--disable-background-networking",
					"--window-size=1280,800",
					// No "Chromium Safe Storage" keychain prompt for a throwaway profile.
					"--use-mock-keychain",
					"--password-store=basic",
					...(options.args ?? []),
					...(process.platform === "linux" ? ["--no-sandbox"] : []),
					"about:blank",
				],
				{ stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"] },
			) as unknown as ChromeProcess;
			const output = (proc as unknown as { stderr: ReadableStream<Uint8Array> })
				.stderr;
			const [, , , toChrome, fromChrome] = proc.stdio as unknown as number[];
			browser = new Browser(
				proc,
				profile,
				keepProfile,
				toChrome as number,
				fromChrome as number,
				options.serve,
			);
			browser.#keepLog(output);
			await Promise.race([
				browser.send("Browser.getVersion"),
				Bun.sleep(20_000).then(() => {
					throw new Error("Chrome did not start");
				}),
			]);
			if (options.extension !== undefined) {
				const id = (
					(await browser.send("Extensions.loadUnpacked", {
						path: options.extension,
					})) as { id: string }
				).id;
				browser.extensionId = id;
				// A click before the service worker has run its script (and added
				// its listeners) would be lost.
				await (await browser.serviceWorker(id)).eval("true");
			}
			return browser;
		} catch (error) {
			// Close what started and remove the profile here.
			if (browser) await browser.close();
			else {
				proc?.kill("SIGKILL");
				await proc?.exited;
				if (!keepProfile) rmSync(profile, { recursive: true, force: true });
			}
			throw error;
		}
	}

	/** The end of Chrome's own output (stderr), for errors: a crash says why there. */
	log = "";

	#keepLog(output: ReadableStream<Uint8Array>): void {
		void (async () => {
			const decoder = new TextDecoder();
			for await (const chunk of output) {
				this.log = (this.log + decoder.decode(chunk, { stream: true })).slice(
					-4000,
				);
			}
		})();
	}

	/** Whether Chrome is still running. */
	get running(): boolean {
		return this.#proc.exitCode === null && this.#proc.signalCode === null;
	}

	/** How Chrome ended, if it did. */
	get ended(): string {
		return `exit code ${this.#proc.exitCode}, signal ${this.#proc.signalCode}`;
	}

	/**
	 * Click an extension's icon (the one loaded at launch unless `id` says
	 * another) on a tab, as a person would (with `activeTab`).
	 */
	async clickIcon(tab: Page, id = this.extensionId): Promise<void> {
		if (id === undefined) throw new Error("no extension loaded");
		// As a person would: on the tab in front. The action wants the tab's
		// "tab" target, not its page's.
		await tab.activate();
		const url = await tab.eval<string>("location.href");
		const target = await this.waitForTarget(
			(t) => t.type === "tab" && t.url === url,
		);
		await this.send("Extensions.triggerAction", {
			id,
			targetId: target.targetId,
		});
	}

	send(
		method: string,
		params: Record<string, unknown> = {},
		sessionId?: string,
	): Promise<Record<string, unknown>> {
		const id = ++this.#nextId;
		this.#transport.send(
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

	/** The first target `matches` accepts, waiting for it up to `timeoutMs`. */
	async waitForTarget(
		matches: (target: {
			targetId: string;
			type: string;
			url: string;
		}) => boolean,
		timeoutMs = 10_000,
	): Promise<{ targetId: string; type: string; url: string }> {
		const end = Date.now() + timeoutMs;
		for (;;) {
			// `filter: [{}]` lists every kind of target, "tab" ones too.
			const { targetInfos } = (await this.send("Target.getTargets", {
				filter: [{}],
			})) as {
				targetInfos: { targetId: string; type: string; url: string }[];
			};
			const found = targetInfos.find(matches);
			if (found) return found;
			if (Date.now() > end) throw new Error("timed out waiting for a target");
			await Bun.sleep(100);
		}
	}

	/** Attach to a page that is already open (a side panel, say). */
	async attach(targetId: string): Promise<Page> {
		const { sessionId } = (await this.send("Target.attachToTarget", {
			targetId,
			flatten: true,
		})) as { sessionId: string };
		// An extension page (a side panel) loads its own files: not served.
		const page = new Page(this, sessionId, targetId, false);
		await page.attached(sessionId);
		await page.send("Page.enable");
		return page;
	}

	/** Open `url` in a new tab (or window) and wait for its load event. */
	async newPage(
		url: string,
		options: { window?: boolean } = {},
	): Promise<Page> {
		const { targetId } = (await this.send("Target.createTarget", {
			url: "about:blank",
			...(options.window ? { newWindow: true } : {}),
		})) as { targetId: string };
		const { sessionId } = (await this.send("Target.attachToTarget", {
			targetId,
			flatten: true,
		})) as { sessionId: string };
		const page = new Page(this, sessionId, targetId, true);
		await page.attached(sessionId);
		await page.send("Page.enable");
		await page.goto(url);
		return page;
	}

	/** The sessions on service workers, for `detachServiceWorkers()`. */
	readonly #workerSessions = new Set<string>();

	/**
	 * Let go of every service worker this browser attached to: an attached
	 * DevTools session keeps a worker running.
	 */
	async detachServiceWorkers(): Promise<void> {
		for (const sessionId of this.#workerSessions)
			await this.send("Target.detachFromTarget", { sessionId }).catch(() => {});
		this.#workerSessions.clear();
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
				this.#workerSessions.add(sessionId);
				const worker = new Worker(this, sessionId);
				await worker.send("Runtime.enable");
				return worker;
			}
			await Bun.sleep(100);
		}
		throw new Error(`the service worker of ${id} did not start`);
	}

	#closed: Promise<void> | undefined;

	/** Close Chrome; once closed, calling it again does nothing. */
	close(): Promise<void> {
		this.#closed ??= this.#close();
		return this.#closed;
	}

	async #close(): Promise<void> {
		try {
			await Promise.race([this.send("Browser.close"), Bun.sleep(2000)]);
		} catch {
			// already gone
		}
		if (this.#proc.exitCode === null) this.#proc.kill("SIGKILL");
		await this.#proc.exited;
		// Chrome is gone: its end of the pipe is shut, ours follow before the
		// next launch can get the same descriptor numbers.
		await this.#transport.close();
		if (!this.#keepProfile)
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
	/** The last events of this page's sessions, for a timeout's error. */
	readonly #recent: string[] = [];
	/** Contexts of the page and of its out-of-process frames, by session. */
	readonly #contexts = new Map<string, Map<number, ExecutionContext>>();

	/** Whether this page's requests are answered by the browser's `serve`. */
	readonly #served: boolean;

	constructor(
		browser: Browser,
		sessionId: string,
		targetId: string,
		served: boolean,
	) {
		super(browser, sessionId);
		this.targetId = targetId;
		this.#served = served;
		browser.on((method, params, s) => {
			const contexts = s === undefined ? undefined : this.#contexts.get(s);
			if (s === undefined || contexts === undefined) return;
			if (!method.startsWith("Runtime.consoleAPI")) {
				const url =
					(params["frame"] as { url?: string } | undefined)?.url ??
					(params["request"] as { url?: string } | undefined)?.url ??
					(params["url"] as string | undefined) ??
					"";
				this.#recent.push(`${method}${url ? ` ${url}` : ""}`);
				if (this.#recent.length > 15) this.#recent.shift();
			}
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
		if (this.#served && this.browser.serve)
			await send("Fetch.enable", { patterns: [{ urlPattern: "*" }] });
		await send("Runtime.enable");
		// Frames attach as they come, never held: a held target the page waits
		// on (released a moment late, or not at all) stalls its load.
		await send("Target.setAutoAttach", {
			autoAttach: true,
			waitForDebuggerOnStart: false,
			flatten: true,
		});
		if (sessionId !== this.sessionId)
			await send("Runtime.runIfWaitingForDebugger");
	}

	/**
	 * A real mouse click (trusted, with user activation) in the middle of the
	 * element `selector`, scrolled into view.
	 */
	async click(selector: string): Promise<void> {
		const box = await this.eval<{ x: number; y: number }>(
			`(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) throw new Error("no element " + ${JSON.stringify(selector)}); e.scrollIntoView({ block: "center", inline: "center" }); const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`,
		);
		for (const type of ["mousePressed", "mouseReleased"])
			await this.send("Input.dispatchMouseEvent", {
				type,
				x: box.x,
				y: box.y,
				button: "left",
				clickCount: 1,
			});
	}

	/** Wait until `expression` (in the page's world) is truthy; returns its value. */
	async waitFor<T>(expression: string, timeoutMs = 10_000): Promise<T> {
		const end = Date.now() + timeoutMs;
		for (;;) {
			const value = await this.eval<T>(expression);
			if (value) return value;
			if (Date.now() > end)
				throw new Error(`timed out waiting for ${expression}`);
			await Bun.sleep(100);
		}
	}

	/** Bring the tab to the front of its window. */
	async activate(): Promise<void> {
		await this.browser.send("Target.activateTarget", {
			targetId: this.targetId,
		});
		await this.send("Page.bringToFront");
	}

	/** Close the tab. */
	async close(): Promise<void> {
		await this.browser.send("Target.closeTarget", { targetId: this.targetId });
	}

	async goto(url: string): Promise<void> {
		const loaded = this.browser.event("Page.loadEventFired", this.sessionId);
		await this.send("Page.navigate", { url });
		const state = () =>
			this.eval<string>("document.readyState + ' ' + location.href").catch(
				(error: unknown) =>
					`(no answer: ${error}; Chrome ${this.browser.running ? "running" : `exited (${this.browser.ended})`}; its output ends: ${this.browser.log.slice(-1500)})`,
			);
		let timer: ReturnType<typeof setTimeout> | undefined;
		await Promise.race([
			loaded,
			new Promise((_, reject) => {
				timer = setTimeout(
					() =>
						void state().then((now) =>
							reject(
								new Error(
									`${url} did not load in 15 s (now: ${now}); last events: ${this.#recent.join(" | ")}`,
								),
							),
						),
					15_000,
				);
			}),
		]).finally(() => clearTimeout(timer));
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
