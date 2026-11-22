/**
 * Chrome for Testing over the DevTools Protocol for the extension's
 * end-to-end tests: launched over a pipe (for the `Extensions` domain, as
 * Overmark's harness does), the extension loaded unpacked, pages served
 * through the Fetch domain on made-up https origins, evaluation in a page,
 * in its isolated worlds or in the service worker, and real clicks. From
 * `test/webmcp-spike/browser.ts`.
 */

import { rmSync } from "node:fs";
import type { Subprocess } from "bun";
import { browserTempDir } from "../../../test/browser-dirs.ts";
import {
	chromeSwitches,
	findChromeForTesting as findPinnedChrome,
} from "../../../test/browsers.ts";

/**
 * The profiles of the Chromes this process started and has not closed yet,
 * and whether each is removed with its Chrome (not one the caller keeps).
 * The same as in `test/webmcp-spike/browser.ts`.
 */
const running = new Map<string, boolean>();
let reapOnExit = false;

/**
 * Kill every process of the Chrome that uses `profile`, and remove the
 * profile unless the caller keeps it. Its helpers (renderers, GPU, network)
 * outlive a SIGKILL of the main process and would stay behind under launchd;
 * each carries the profile's path, as given, in its `--user-data-dir`. The
 * pattern is that whole argument and nothing more, so no other Chrome
 * (another run's, another tool's) matches.
 */
function reap(profile: string): void {
	try {
		Bun.spawnSync(["pkill", "-9", "-f", profilePattern(profile)]);
	} catch {
		// no pkill: only the main process was killed
	}
	try {
		if (running.get(profile) !== false)
			rmSync(profile, { recursive: true, force: true });
	} catch {
		// still busy right after the kill: left in the temp directory
	}
	running.delete(profile);
}

/** The `--user-data-dir` argument of `profile`, whole, as a pkill pattern. */
export function profilePattern(profile: string): string {
	return `user-data-dir=${profile.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}( |$)`;
}

/**
 * Remember `profile` until its Chrome is closed; a test process that ends
 * first (a failed hook, a timeout, Ctrl-C, a kill with SIGTERM) still takes
 * its Chromes with it.
 */
function track(profile: string, keep: boolean): void {
	running.set(profile, !keep);
	if (reapOnExit) return;
	reapOnExit = true;
	// reap() does not throw: every profile is reaped, and a signal still exits.
	const reapAll = () => {
		for (const p of [...running.keys()]) reap(p);
	};
	process.on("exit", reapAll);
	for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const)
		process.once(signal, () => {
			reapAll();
			process.exit(
				128 + (signal === "SIGINT" ? 2 : signal === "SIGTERM" ? 15 : 1),
			);
		});
}

/** Chrome's major version, from `--version`; 0 if it does not say. */
export function chromeMajor(binary: string): number {
	const { stdout } = Bun.spawnSync([binary, "--version"]);
	return Number(/(\d+)\.\d+\.\d+/.exec(stdout.toString())?.[1] ?? 0);
}

/** Chrome for Testing in the pinned version (test/browsers.ts). */
export const findChromeForTesting = findPinnedChrome;

type Pending = {
	resolve: (v: Record<string, unknown>) => void;
	reject: (e: Error) => void;
	/** The DevTools method asked, for its error: Chrome's message names none. */
	method: string;
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
			write(writer, `${message}\0`);
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

/** The part of Bun's `FileSink` that `write` uses. */
export interface Sink {
	write(chunk: string): unknown;
	flush(): number | Promise<number>;
}

/**
 * Write and flush, dropping a failure: once Chrome is gone the pipe's write
 * end fails with EPIPE, either at once or in the flush's promise, and that
 * would be an unhandled error in whichever test was running. The calls
 * still waiting are failed when the read end closes.
 */
export function write(sink: Sink, chunk: string): void {
	try {
		sink.write(chunk);
		const flushed = sink.flush();
		if (flushed instanceof Promise) flushed.catch(() => {});
	} catch {
		// The pipe went away.
	}
}

type ChromeProcess = Subprocess<"ignore", "ignore", "ignore">;

/**
 * In the extension's service worker: what is not as a fresh install has it,
 * as text, or nothing. Its settings (the `settings` store of its IndexedDB
 * `tab-mcp`, `worker/kv.ts`), its alarms, its notifications, and the
 * permissions it holds against its manifest's.
 */
const FRESH_STATE = `(async () => {
	const left = [];
	const keys = await new Promise((resolve) => {
		const open = indexedDB.open("tab-mcp");
		open.onerror = () => resolve(["(the database did not open)"]);
		open.onsuccess = () => {
			const db = open.result;
			if (!db.objectStoreNames.contains("settings")) {
				db.close();
				resolve([]);
				return;
			}
			const read = db.transaction("settings").objectStore("settings").getAllKeys();
			read.onsuccess = () => {
				db.close();
				resolve(read.result.map(String));
			};
			read.onerror = () => {
				db.close();
				resolve(["(the settings could not be read)"]);
			};
		};
	});
	if (keys.length > 0) left.push("settings " + keys.join(", "));
	const alarms = await chrome.alarms.getAll();
	if (alarms.length > 0) left.push("alarms " + alarms.map((a) => a.name).join(", "));
	const shown = Object.keys(await chrome.notifications.getAll());
	if (shown.length > 0) left.push("notifications " + shown.join(", "));
	const manifest = chrome.runtime.getManifest();
	const held = await chrome.permissions.getAll();
	const same = (a, b) => JSON.stringify([...(a ?? [])].sort()) === JSON.stringify([...(b ?? [])].sort());
	if (!same(held.permissions, manifest.permissions))
		left.push("permissions " + JSON.stringify(held.permissions));
	if (!same(held.origins, manifest.host_permissions))
		left.push("origins " + JSON.stringify(held.origins));
	return left;
})()`;

export class Browser {
	readonly #proc: ChromeProcess;
	readonly #profile: string;
	readonly #transport: Transport;
	readonly #pending = new Map<number, Pending>();
	readonly #listeners = new Set<Listener>();
	readonly serve: Serve | undefined;
	/** The extension loaded at launch, if one was. */
	extensionId: string | undefined;
	/**
	 * Its service worker, attached from the start: its console (a failed
	 * `sidePanel.open`, say) is there for a test's error.
	 */
	extensionWorker: Worker | undefined;
	#nextId = 0;
	/** The DevTools connection closed: a call now would wait forever. */
	#gone = false;

	private constructor(
		proc: ChromeProcess,
		profile: string,
		toChrome: number,
		fromChrome: number,
		serve: Serve | undefined,
	) {
		this.#proc = proc;
		this.#profile = profile;
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
					if (msg.error)
						p?.reject(new Error(`${p.method}: ${msg.error.message}`));
					else p?.resolve(msg.result ?? {});
				} else if (msg.method !== undefined) {
					for (const l of this.#listeners)
						l(msg.method, msg.params ?? {}, msg.sessionId);
				}
			},
			// A closed connection (Chrome gone) fails every call still waiting.
			() => {
				this.#gone = true;
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
		const profile = options.profile ?? browserTempDir("chrome-");
		track(profile, options.profile !== undefined);
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
					...chromeSwitches(options.args),
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
				await browser.readyWorker(id);
			}
			return browser;
		} catch (error) {
			// Close what started and remove the profile here.
			if (browser) await browser.close();
			else {
				proc?.kill("SIGKILL");
				await proc?.exited;
				reap(profile);
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
		if (this.#gone)
			return Promise.reject(new Error("the DevTools connection closed"));
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
			this.#pending.set(id, { resolve, reject, method }),
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

	/**
	 * The extension loaded at launch anew, as just installed, for the next
	 * test in a Chrome that tests share. What it guarantees, checked here and
	 * not assumed (it fails loudly otherwise):
	 * - the `others` (extensions a test loaded) are gone; one that cannot be
	 *   removed is an error, as it could cover our side panel later;
	 * - every target of the old install (its worker, its pages) is gone
	 *   before the extension is loaded again from `path` (the same id), so
	 *   the worker found after it is the new one;
	 * - the new worker is ready (its click listener there), and the
	 *   extension's state is a fresh install's: nothing in its settings
	 *   (IndexedDB, which Chrome deletes after an uninstall without saying
	 *   when: polled, at most 5 s), no alarm, no notification, and the
	 *   permissions of its manifest only.
	 */
	async reinstall(path: string, others: Iterable<string> = []): Promise<void> {
		const id = this.extensionId;
		if (id === undefined) throw new Error("no extension loaded");
		await this.detachServiceWorkers();
		for (const other of others)
			await this.send("Extensions.uninstall", { id: other }).catch(
				(error: unknown) => {
					throw new Error(
						`the other extension ${other} could not be removed: ${error}`,
					);
				},
			);
		await this.send("Extensions.uninstall", { id });
		const prefix = `chrome-extension://${id}/`;
		const gone = Date.now() + 5_000;
		for (;;) {
			const { targetInfos } = (await this.send("Target.getTargets", {
				filter: [{}],
			})) as { targetInfos: { url: string }[] };
			if (!targetInfos.some((t) => t.url.startsWith(prefix))) break;
			if (Date.now() > gone)
				throw new Error(`the extension ${id} stayed after its uninstall`);
			await Bun.sleep(50);
		}
		await this.send("Extensions.loadUnpacked", { path });
		const worker = await this.readyWorker(id);
		const fresh = Date.now() + 5_000;
		for (;;) {
			const left = await worker.eval<string[]>(FRESH_STATE);
			if (left.length === 0) return;
			if (Date.now() > fresh)
				throw new Error(
					`the extension is not as just installed after its reinstall: ${left.join("; ")}`,
				);
			await Bun.sleep(50);
		}
	}

	/** Close every tab but `keep` (the windows a test opened go with them). */
	async closeTabsBut(keep: Page): Promise<void> {
		const { targetInfos } = (await this.send("Target.getTargets")) as {
			targetInfos: { targetId: string; type: string }[];
		};
		for (const target of targetInfos)
			if (target.type === "page" && target.targetId !== keep.targetId)
				await this.send("Target.closeTarget", {
					targetId: target.targetId,
				}).catch(() => {});
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
		let last: unknown;
		for (let attempt = 0; attempt < 50; attempt++) {
			const { targetInfos } = (await this.send("Target.getTargets")) as {
				targetInfos: { targetId: string; type: string; url: string }[];
			};
			const target = targetInfos.find(
				(t) => t.type === "service_worker" && t.url.startsWith(prefix),
			);
			if (target) {
				// A worker that went between the list and the attach (a reload,
				// an update): the next round finds the one there now.
				let attached: { sessionId: string } | undefined;
				try {
					attached = (await this.send("Target.attachToTarget", {
						targetId: target.targetId,
						flatten: true,
					})) as { sessionId: string };
				} catch (error) {
					last = error;
				}
				if (attached !== undefined) {
					this.#workerSessions.add(attached.sessionId);
					const worker = new Worker(this, attached.sessionId);
					await worker.send("Runtime.enable");
					return worker;
				}
			}
			await Bun.sleep(100);
		}
		throw new Error(
			`the service worker of ${id} did not start${last === undefined ? "" : ` (last: ${last})`}`,
		);
	}

	/**
	 * The service worker of extension `id` once its script has run and added
	 * its listener for a click on the icon. The worker's target answers an
	 * evaluation before that (`chrome` not even defined yet), so "it answers"
	 * is not "it is ready": a click then found no listener and was lost, and
	 * the side panel never opened (a few starts in a thousand, CI and local).
	 * An extension without an action is ready once `chrome` is there. For
	 * the extension loaded at launch it becomes `extensionWorker` too (a
	 * reload replaces the worker).
	 */
	async readyWorker(id: string, timeoutMs = 10_000): Promise<Worker> {
		const worker = await this.serviceWorker(id);
		const end = Date.now() + timeoutMs;
		for (;;) {
			const ready = await worker
				.eval<boolean>(
					`typeof chrome === "object" && (chrome.action === undefined || chrome.action.onClicked.hasListeners())`,
				)
				.catch(() => false);
			if (ready) {
				if (id === this.extensionId) this.extensionWorker = worker;
				return worker;
			}
			if (Date.now() > end)
				throw new Error(
					`the service worker of ${id} added no listener for the icon in ${timeoutMs} ms`,
				);
			await Bun.sleep(50);
		}
	}

	#closed: Promise<void> | undefined;

	/** `close()` was called: what still waits fails because of it. */
	get closed(): boolean {
		return this.#closed !== undefined;
	}

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
		reap(this.#profile);
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

export class Worker extends Target {
	/** What the worker logged (and threw) since it was attached, the last 50. */
	readonly console: string[] = [];

	constructor(browser: Browser, sessionId: string) {
		super(browser, sessionId);
		browser.on((method, params, s) => {
			if (s !== sessionId) return;
			if (method === "Runtime.consoleAPICalled") {
				const args = params["args"] as Remote[];
				this.console.push(
					`${params["type"]}: ${args.map((a) => a.value ?? a.description).join(" ")}`,
				);
			} else if (method === "Runtime.exceptionThrown") {
				const details = params["exceptionDetails"] as {
					text?: string;
					exception?: { description?: string };
				};
				this.console.push(
					`uncaught: ${details.exception?.description ?? details.text}`,
				);
			} else return;
			if (this.console.length > 50) this.console.shift();
		});
	}
}

export class Page extends Target {
	readonly targetId: string;
	readonly console: string[] = [];
	/** The last events of this page's sessions, for a timeout's error. */
	readonly #recent: string[] = [];
	/** Contexts of the page and of its out-of-process frames, by session. */
	readonly #contexts = new Map<string, Map<number, ExecutionContext>>();
	/** Sessions of frames that went away (removed, or the page closed). */
	readonly #detached = new Set<string>();
	#closed = false;

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
				// An out-of-process frame (site isolation): a session of its own,
				// attached without anyone awaiting it.
				const frame = params["sessionId"] as string;
				this.attached(frame).catch(async (error: unknown) => {
					// The frame went away while it was attached: closing the browser
					// or the page, or a frame removed, fails what is still on its
					// way. Any other failure is thrown on, unhandled, so that the
					// test run shows it. Chrome can answer a command of a session
					// before it reports that session detached: decide a moment
					// later, once that report is in.
					await Bun.sleep(50);
					if (this.browser.closed || this.#closed || this.#detached.has(frame))
						return;
					throw error;
				});
			} else if (method === "Target.detachedFromTarget") {
				this.#detached.add(params["sessionId"] as string);
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
		// Not before the element has a box and the page a size: a click on a
		// page Chrome has yet to lay out (a side panel still 0×0) lands on
		// nothing and is lost without a word.
		const box = await this.waitFor<{ x: number; y: number }>(
			`(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) throw new Error("no element " + ${JSON.stringify(selector)}); e.scrollIntoView({ block: "center", inline: "center" }); const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && innerWidth > 0 && innerHeight > 0 && { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`,
			5_000,
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

	/**
	 * Wait until `expression` (in the page's world) is truthy; returns its
	 * value. An expression that throws is tried again: a page that has not
	 * built its document yet (a side panel just opened) has no element to
	 * read. The last error is in the timeout's.
	 */
	async waitFor<T>(expression: string, timeoutMs = 10_000): Promise<T> {
		const end = Date.now() + timeoutMs;
		let failed: unknown;
		for (;;) {
			try {
				const value = await this.eval<T>(expression);
				if (value) return value;
				failed = undefined;
			} catch (error) {
				failed = error;
			}
			if (Date.now() > end)
				throw new Error(
					`timed out waiting for ${expression}${failed === undefined ? "" : ` (last: ${failed})`}`,
				);
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
		this.#closed = true;
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
