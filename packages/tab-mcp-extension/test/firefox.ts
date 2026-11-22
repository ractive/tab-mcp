/**
 * Firefox over WebDriver BiDi, for the Firefox build's end-to-end tests
 * (iteration 44): Firefox started with a fresh profile and its BiDi server on a
 * free port, an extension installed as a temporary add-on
 * (`webExtension.install`, which needs no signature), tabs opened and pages
 * evaluated in. BiDi is built into Firefox, so this needs no driver and no
 * package; `FIREFOX_PATH` names the binary, else the usual places are tried.
 */

import { rmSync } from "node:fs";
import { join } from "node:path";
import type { Subprocess } from "bun";
import { browserTempDir } from "../../../test/browser-dirs.ts";
import { FIREFOX_PREFS, findTestFirefox } from "../../../test/browsers.ts";

/** The test Firefox in the pinned version, `FIREFOX_PATH` or Puppeteer's cache (test/browsers.ts). */
export const findFirefox = findTestFirefox;

/** Firefox's major version, from `--version`; 0 if it does not say. */
export function firefoxMajor(binary: string): number {
	const { stdout } = Bun.spawnSync([binary, "--version"]);
	return Number(/(\d+)\.\d+/.exec(stdout.toString())?.[1] ?? 0);
}

export interface FirefoxOptions {
	headless?: boolean;
	/** Preferences written to the profile's `user.js`. */
	prefs?: Record<string, string | number | boolean>;
	/** Print Firefox's output (`FIREFOX_LOG=1` does too). */
	log?: boolean;
}

type Pending = {
	resolve: (value: Record<string, unknown>) => void;
	reject: (error: Error) => void;
};

/** A BiDi error, with the command it answered. */
export class BidiError extends Error {}

/** A JavaScript exception thrown by an evaluation. */
export class EvaluationError extends Error {}

/** Firefox named no BiDi address in time. */
class StartTimeout extends Error {}

/** The prefs every test profile gets, besides Firefox's own for automation. */
const BASE_PREFS: Record<string, string | number | boolean> = {
	"browser.shell.checkDefaultBrowser": false,
	"browser.startup.homepage_override.mstone": "ignore",
	"datareporting.policy.dataSubmissionEnabled": false,
	"toolkit.telemetry.reportingpolicy.firstRun": false,
	// No notification of a test on the desktop.
	...FIREFOX_PREFS,
};

export class Firefox {
	readonly #process: Subprocess;
	readonly #socket: WebSocket;
	readonly #profile: string;
	readonly #pending = new Map<number, Pending>();
	readonly #listeners = new Set<(method: string, params: unknown) => void>();
	#id = 0;
	#closed = false;

	private constructor(process: Subprocess, socket: WebSocket, profile: string) {
		this.#process = process;
		this.#socket = socket;
		this.#profile = profile;
		socket.addEventListener("message", (event) => {
			const message = JSON.parse(String(event.data)) as {
				id?: number;
				type: string;
				result?: Record<string, unknown>;
				error?: string;
				message?: string;
				method?: string;
				params?: unknown;
			};
			if (message.id !== undefined) {
				const pending = this.#pending.get(message.id);
				this.#pending.delete(message.id);
				if (message.type === "error")
					pending?.reject(
						new BidiError(`${message.error}: ${message.message ?? ""}`),
					);
				else pending?.resolve(message.result ?? {});
			} else if (message.method !== undefined) {
				for (const listener of this.#listeners)
					listener(message.method, message.params);
			}
		});
		socket.addEventListener("close", () => {
			for (const pending of this.#pending.values())
				pending.reject(new BidiError("the BiDi connection closed"));
			this.#pending.clear();
		});
	}

	/**
	 * Start `binary` with a fresh profile and open a BiDi session. The first
	 * start on a fresh machine (a CI runner) is slow: 10 to 25 s in green runs,
	 * over 30 s now and then, where a later one takes 2 s. A start that names
	 * no BiDi address in 30 s is ended and made once more, with a new profile.
	 */
	static async launch(
		binary: string,
		options: FirefoxOptions = {},
	): Promise<Firefox> {
		try {
			return await Firefox.#launch(binary, options);
		} catch (error) {
			if (!(error instanceof StartTimeout)) throw error;
			console.warn(
				`::warning::${error.message.split("\n")[0]}; starting it again`,
			);
			return await Firefox.#launch(binary, options);
		}
	}

	static async #launch(
		binary: string,
		options: FirefoxOptions,
	): Promise<Firefox> {
		const profile = browserTempDir("firefox-");
		const log = options.log ?? Boolean(process.env["FIREFOX_LOG"]);
		const prefs = {
			...BASE_PREFS,
			// With the log on, every console (the extension's too) on stdout.
			...(log
				? {
						"devtools.console.stdout.chrome": true,
						"devtools.console.stdout.content": true,
					}
				: {}),
			...options.prefs,
		};
		await Bun.write(
			join(profile, "user.js"),
			Object.entries(prefs)
				.map(
					([k, v]) => `user_pref(${JSON.stringify(k)}, ${JSON.stringify(v)});`,
				)
				.join("\n"),
		);
		const proc = Bun.spawn(
			[
				binary,
				...(options.headless === false ? [] : ["--headless"]),
				"--no-remote",
				"--profile",
				profile,
				"--remote-debugging-port",
				"0",
				"about:blank",
			],
			{
				stdout: log ? "inherit" : "ignore",
				stderr: "pipe",
				env: {
					...process.env,
					MOZ_CRASHREPORTER_DISABLE: "1",
					// BiDi evaluates in extension pages (the panel) only with it.
					MOZ_REMOTE_ALLOW_SYSTEM_ACCESS: "1",
				},
			},
		);
		try {
			const url = await bidiAddress(proc, log);
			const socket = new WebSocket(`${url}/session`);
			await new Promise<void>((resolve, reject) => {
				socket.addEventListener("open", () => resolve(), { once: true });
				socket.addEventListener(
					"error",
					() => reject(new Error(`no BiDi at ${url}`)),
					{
						once: true,
					},
				);
			});
			const firefox = new Firefox(proc, socket, profile);
			await firefox.send("session.new", { capabilities: {} });
			return firefox;
		} catch (error) {
			proc.kill();
			await proc.exited;
			rmSync(profile, { recursive: true, force: true });
			throw error;
		}
	}

	/** Send a BiDi command; resolves with its result. */
	send(
		method: string,
		params: Record<string, unknown> = {},
	): Promise<Record<string, unknown>> {
		const id = ++this.#id;
		return new Promise((resolve, reject) => {
			this.#pending.set(id, { resolve, reject });
			this.#socket.send(JSON.stringify({ id, method, params }));
		});
	}

	/** Listen to BiDi events (after `session.subscribe`). */
	onEvent(listener: (method: string, params: unknown) => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	/** Install `path` (an unpacked extension) as a temporary add-on; its id. */
	async installExtension(path: string): Promise<string> {
		const result = await this.send("webExtension.install", {
			extensionData: { type: "path", path },
		});
		return String(result["extension"]);
	}

	/** Open `url` in a new tab (or window), waiting for its load. */
	async newTab(url: string, type: "tab" | "window" = "tab"): Promise<Tab> {
		const { context } = (await this.send("browsingContext.create", {
			type,
		})) as { context: string };
		const tab = new Tab(this, context);
		await tab.navigate(url);
		return tab;
	}

	/** The top-level browsing contexts and their addresses. */
	async tabs(): Promise<{ context: string; url: string }[]> {
		const { contexts } = (await this.send("browsingContext.getTree", {
			maxDepth: 0,
		})) as { contexts: { context: string; url: string }[] };
		return contexts;
	}

	async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		try {
			await Promise.race([this.send("browser.close"), Bun.sleep(3_000)]);
		} catch {
			// Closing ends the connection before the answer, at times.
		}
		this.#socket.close();
		const exited = await Promise.race([
			this.#process.exited.then(() => true),
			Bun.sleep(5_000).then(() => false),
		]);
		if (!exited) {
			this.#process.kill("SIGKILL");
			await this.#process.exited;
		}
		rmSync(this.#profile, { recursive: true, force: true });
	}
}

/** One tab (top-level browsing context). */
export class Tab {
	readonly #firefox: Firefox;
	readonly context: string;

	constructor(firefox: Firefox, context: string) {
		this.#firefox = firefox;
		this.context = context;
	}

	async navigate(url: string): Promise<void> {
		await this.#firefox.send("browsingContext.navigate", {
			context: this.context,
			url,
			wait: "complete",
		});
	}

	async reload(): Promise<void> {
		await this.#firefox.send("browsingContext.reload", {
			context: this.context,
			wait: "complete",
		});
	}

	/**
	 * Evaluate `expression` in the page (awaited if a promise) and return its
	 * value through JSON: `undefined` comes back as `undefined`.
	 */
	async eval<T = unknown>(expression: string): Promise<T> {
		const wrapped = `(async () => { const value = await (${expression}); return value === undefined ? "__undefined__" : JSON.stringify(value); })()`;
		const result = (await this.#firefox.send("script.evaluate", {
			expression: wrapped,
			target: { context: this.context },
			awaitPromise: true,
			resultOwnership: "none",
		})) as {
			type: string;
			result?: { type: string; value?: unknown };
			exceptionDetails?: { text?: string };
		};
		if (result.type === "exception")
			throw new EvaluationError(result.exceptionDetails?.text ?? "exception");
		const text = result.result?.value;
		if (text === "__undefined__" || text === undefined) return undefined as T;
		return JSON.parse(String(text)) as T;
	}

	/** Wait until `expression` is truthy in the page; returns its value. */
	async waitFor<T = unknown>(
		expression: string,
		timeoutMs = 10_000,
	): Promise<T> {
		const end = Date.now() + timeoutMs;
		let last: unknown;
		for (;;) {
			try {
				const value = await this.eval<T>(expression);
				if (value) return value;
				last = value;
			} catch (error) {
				last = error;
			}
			if (Date.now() > end)
				throw new Error(
					`timed out waiting for ${expression} (last: ${String(last)})`,
				);
			await Bun.sleep(100);
		}
	}

	/**
	 * A real click (with the user activation an extension's
	 * `permissions.request` needs) in the middle of element `selector`.
	 */
	async click(selector: string): Promise<void> {
		const box = await this.eval<{ x: number; y: number }>(
			`(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) throw new Error("no element " + ${JSON.stringify(selector)}); e.scrollIntoView({ block: "center" }); const r = e.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`,
		);
		await this.#firefox.send("input.performActions", {
			context: this.context,
			actions: [
				{
					type: "pointer",
					id: "mouse",
					actions: [
						{ type: "pointerMove", x: box.x, y: box.y },
						{ type: "pointerDown", button: 0 },
						{ type: "pointerUp", button: 0 },
					],
				},
			],
		});
	}

	async close(): Promise<void> {
		await this.#firefox.send("browsingContext.close", {
			context: this.context,
		});
	}
}

/** Read Firefox's stderr until it names its BiDi address. */
async function bidiAddress(proc: Subprocess, log: boolean): Promise<string> {
	const stderr = proc.stderr as ReadableStream<Uint8Array>;
	const reader = stderr.getReader();
	const decoder = new TextDecoder();
	let text = "";
	const deadline = Bun.sleep(30_000).then(() => {
		throw new StartTimeout(
			`Firefox named no BiDi address in 30 s:\n${text.slice(-2000)}`,
		);
	});
	const found = (async () => {
		for (;;) {
			const { value, done } = await reader.read();
			if (done) throw new Error(`Firefox exited:\n${text.slice(-2000)}`);
			const chunk = decoder.decode(value, { stream: true });
			if (log) process.stderr.write(chunk);
			text += chunk;
			const match = /WebDriver BiDi listening on (ws:\/\/[^\s]+)/.exec(text);
			if (match?.[1]) return match[1];
		}
	})();
	const url = await Promise.race([found, deadline]);
	// Keep reading, so Firefox never blocks on a full pipe.
	void (async () => {
		for (;;) {
			const { value, done } = await reader
				.read()
				.catch(() => ({ value: undefined, done: true }));
			if (done) return;
			if (log && value)
				process.stderr.write(decoder.decode(value, { stream: true }));
		}
	})();
	return url;
}
