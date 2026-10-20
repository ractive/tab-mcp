/**
 * A small Chrome DevTools Protocol helper (DEC-025): launch headless Chrome,
 * open a page, evaluate, click and type. Uses Bun's WebSocket; no Playwright.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Subprocess } from "bun";

const CANDIDATES = [
	"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
	"/Applications/Chromium.app/Contents/MacOS/Chromium",
	"google-chrome",
	"google-chrome-stable",
	"chromium",
	"chromium-browser",
];

/** The Chrome binary: `CHROME_PATH`, else a usual location; `undefined` if none. */
export function findChrome(): string | undefined {
	const fromEnv = process.env["CHROME_PATH"];
	if (fromEnv) return fromEnv;
	for (const candidate of CANDIDATES) {
		const found = candidate.startsWith("/")
			? Bun.file(candidate).size > 0
				? candidate
				: null
			: Bun.which(candidate);
		if (found) return found;
	}
	return undefined;
}

type Pending = {
	resolve: (v: Record<string, unknown>) => void;
	reject: (e: Error) => void;
};

export class Browser {
	readonly #proc: Subprocess<"ignore", "ignore", "pipe">;
	readonly #profile: string;
	readonly #ws: WebSocket;
	readonly #pending = new Map<number, Pending>();
	readonly #listeners = new Set<
		(
			method: string,
			params: Record<string, unknown>,
			sessionId?: string,
		) => void
	>();
	#nextId = 0;

	private constructor(
		proc: Subprocess<"ignore", "ignore", "pipe">,
		profile: string,
		ws: WebSocket,
	) {
		this.#proc = proc;
		this.#profile = profile;
		this.#ws = ws;
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
	}

	static async launch(binary: string): Promise<Browser> {
		const profile = mkdtempSync(join(tmpdir(), "tab-mcp-chrome-"));
		const proc = Bun.spawn(
			[
				binary,
				"--headless=new",
				"--remote-debugging-port=0",
				`--user-data-dir=${profile}`,
				"--no-first-run",
				"--no-default-browser-check",
				"--disable-gpu",
				"--disable-extensions",
				"--disable-background-networking",
				...(process.platform === "linux" ? ["--no-sandbox"] : []),
				"about:blank",
			],
			{ stdin: "ignore", stdout: "ignore", stderr: "pipe" },
		);
		// Chrome prints "DevTools listening on ws://…" on stderr once it is ready.
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
		return new Browser(proc, profile, ws);
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

	/** The next event `method` (optionally for one session). */
	event(method: string, sessionId?: string): Promise<Record<string, unknown>> {
		return new Promise((resolve) => {
			const listener = (
				m: string,
				params: Record<string, unknown>,
				s?: string,
			) => {
				if (m === method && (sessionId === undefined || s === sessionId)) {
					this.#listeners.delete(listener);
					resolve(params);
				}
			};
			this.#listeners.add(listener);
		});
	}

	async newPage(): Promise<Page> {
		const { targetId } = (await this.send("Target.createTarget", {
			url: "about:blank",
		})) as { targetId: string };
		const { sessionId } = (await this.send("Target.attachToTarget", {
			targetId,
			flatten: true,
		})) as {
			sessionId: string;
		};
		const page = new Page(this, sessionId, targetId);
		await page.send("Page.enable");
		await page.send("Runtime.enable");
		return page;
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

export class Page {
	readonly #browser: Browser;
	readonly sessionId: string;
	readonly targetId: string;
	readonly console: string[] = [];

	constructor(browser: Browser, sessionId: string, targetId: string) {
		this.#browser = browser;
		this.sessionId = sessionId;
		this.targetId = targetId;
	}

	/** Close the tab. */
	async close(): Promise<void> {
		await this.#browser.send("Target.closeTarget", {
			targetId: this.targetId,
		});
	}

	send(
		method: string,
		params: Record<string, unknown> = {},
	): Promise<Record<string, unknown>> {
		return this.#browser.send(method, params, this.sessionId);
	}

	async goto(url: string): Promise<void> {
		const loaded = this.#browser.event("Page.loadEventFired", this.sessionId);
		await this.send("Page.navigate", { url });
		await loaded;
	}

	/** Evaluate an expression (awaiting promises) and return its JSON value. */
	async eval<T = unknown>(expression: string): Promise<T> {
		const r = (await this.send("Runtime.evaluate", {
			expression,
			awaitPromise: true,
			returnByValue: true,
		})) as {
			result: { value?: T };
			exceptionDetails?: { exception?: { description?: string }; text: string };
		};
		if (r.exceptionDetails) {
			throw new Error(
				r.exceptionDetails.exception?.description ?? r.exceptionDetails.text,
			);
		}
		return r.result.value as T;
	}

	/** A real mouse click (with user activation) in the middle of an element, scrolled into view. */
	async click(selector: string): Promise<void> {
		const box = await this.eval<{ x: number; y: number }>(
			`(() => { const e = document.querySelector(${JSON.stringify(selector)}); e.scrollIntoView({ block: "center", inline: "center" }); const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`,
		);
		for (const type of ["mousePressed", "mouseReleased"]) {
			await this.send("Input.dispatchMouseEvent", {
				type,
				x: box.x,
				y: box.y,
				button: "left",
				clickCount: 1,
			});
		}
	}

	async press(key: string): Promise<void> {
		for (const type of ["keyDown", "keyUp"]) {
			await this.send("Input.dispatchKeyEvent", {
				type,
				key,
				code: key,
				windowsVirtualKeyCode: key === "Escape" ? 27 : 0,
			});
		}
	}
}
