/**
 * The Firefox smoke (iteration 50, task 7), on every pull request: what is
 * Firefox's own and not proven by the Chrome tests or the unit tests. The
 * WebMCP the extension gives the page (`exportFunction`, Xrays, a page-realm
 * signal and `toolchange`), the relay admitting `moz-extension://`, the
 * panel's focus rules, notifications as Firefox has them (the recorder and
 * its real API), the page's own object, dead objects after a reload, and
 * the client library across Firefox's worlds. The rest of Firefox runs in
 * firefox-full.browser.test.ts (browser-full.yml); `bun run test:browser
 * firefox` runs both.
 *
 * Needs Firefox 140 or newer (`FIREFOX_PATH`, or the pinned test Firefox,
 * test/browsers.ts): required in CI, skipped elsewhere without it.
 */

import {
	afterAll,
	beforeAll,
	describe,
	expect,
	setDefaultTimeout,
	test,
} from "bun:test";
import { browserTests } from "../../../test/browser-gate.ts";
import { step } from "../../../test/step.ts";
import { FIREFOX_ID } from "../scripts/build.ts";
import { findFirefox } from "./firefox.ts";
import {
	answerInPanel,
	type CallResult,
	call,
	clickIcon,
	findPanel,
	inBackground,
	notificationFor,
	OWN_TOOLS,
	PAGE_TOOLS,
	recorded,
	type Stack,
	start,
	UUID,
	useFirefox,
	waitForTools,
} from "./firefox-e2e.ts";
import { glowsWhileCalling } from "./glow.ts";
import { picturesThroughTheExtension } from "./pictures.ts";
import { listsTheCalls } from "./recent-calls.ts";

setDefaultTimeout(30_000);

const firefoxOk = useFirefox(browserTests ? findFirefox() : undefined);

describe.skipIf(!firefoxOk)("the Firefox build (the test build)", () => {
	let stack: Stack;

	beforeAll(async () => {
		stack = await start("webmcp.html");
	}, 90_000);

	afterAll(async () => {
		await stack?.client.close();
		await stack?.stop();
	});

	test("the page finds document.modelContext as it loads, and registers", async () => {
		expect(
			await stack.tab.eval(
				`typeof document.modelContext?.registerTool + " " + ("modelContext" in navigator)`,
			),
		).toBe("function true");
		const tools = await stack.tab.eval<{ name: string }[]>(
			"document.modelContext.getTools()",
		);
		expect(tools.map((t) => t.name).sort()).toEqual([
			"get_greeting",
			"mcp_result",
			"mirrored_tool",
			"place_order",
			"slow_tool",
		]);
	});

	test("the AI app gets page_info, webmcp_tools and the page's tools", async () => {
		await step(
			"the AI app gets page_info, webmcp_tools and the page's tools",
			async () => {
				const names = await waitForTools(
					stack,
					(n) => n.length >= OWN_TOOLS.length + PAGE_TOOLS.length,
				);
				expect(names).toEqual([...OWN_TOOLS, ...PAGE_TOOLS].sort());
				const { tools } = await stack.client.listTools();
				const greeting = tools.find((t) => t.name === "page_get_greeting");
				expect(greeting?.description).toBe(
					`From ${stack.site}: Greets a name.`,
				);
				expect(greeting?.annotations?.readOnlyHint).toBe(true);
			},
		);
		await step(
			"page_info tells the page in front and its WebMCP tools",
			async () => {
				const result = await call(stack, "page_info");
				expect(result.structuredContent).toEqual({
					url: `${stack.site}/webmcp.html`,
					title: "Page with WebMCP tools",
					language: "de-CH",
					webmcp: { available: true, tools: 5 },
				});
			},
		);
		await step(
			"list_tabs names the page's tab, in front, not the panel's; page_info reaches it by its id (DEC-230)",
			async () => {
				const listed = (await call(stack, "list_tabs")).structuredContent as {
					mode: string;
					tabs: { tab: string; url: string; inFront?: true }[];
				};
				expect(listed.mode).toBe("the tab in front");
				const page = listed.tabs.find(
					(t) => t.url === `${stack.site}/webmcp.html`,
				);
				expect(page?.inFront).toBe(true);
				expect(
					listed.tabs.some((t) => t.url.startsWith("moz-extension:")),
				).toBe(false);
				const result = await call(stack, "page_info", { tab: page?.tab });
				expect(result.structuredContent).toMatchObject({
					url: `${stack.site}/webmcp.html`,
				});
			},
		);
		await step(
			"a read-only tool runs at once, with the page's answer",
			async () => {
				const result = await call(stack, "page_get_greeting", { name: "Ada" });
				expect(result.isError).toBeFalsy();
				expect(result.content).toEqual([{ type: "text", text: "Hello, Ada!" }]);
				expect(await stack.tab.eval("window.calls.at(-1)")).toEqual([
					"get_greeting",
					"Ada",
				]);
			},
		);
		await step(
			"an MCP result from the page passes as its content",
			async () => {
				expect((await call(stack, "page_mcp_result")).content).toEqual([
					{ type: "text", text: "from an MCP result" },
				]);
			},
		);
		// The page's inputSchema reached the worker through the polyfill: the
		// tool's schema refuses a wrong argument (the checks themselves:
		// bridge.test.ts).
		await step(
			"a wrong argument is refused with the schema's message, and the page's tool does not run",
			async () => {
				const before = await stack.tab.eval<number>("window.calls.length");
				const result = await call(stack, "page_get_greeting", { name: 42 });
				expect(result.isError).toBe(true);
				expect(result.content[0]?.text).toContain(
					'Invalid arguments for tool page_get_greeting: #/name Instance type "number" is invalid. Expected "string".',
				);
				expect(await stack.tab.eval("window.calls.length")).toBe(before);
			},
		);
		await step("cancelling a call aborts the page's signal", async () => {
			const controller = new AbortController();
			const pending = call(
				stack,
				"page_slow_tool",
				{},
				{ signal: controller.signal },
			);
			await stack.tab.waitFor("window.slowStarted === true");
			controller.abort();
			await pending.catch(() => {});
			await stack.tab.waitFor("window.aborted === true");
		});
		await step(
			"the list follows toolchange: a tool registered later, and one whose signal aborts",
			async () => {
				await stack.tab.eval(`(() => {
				window.later = new AbortController();
				return document.modelContext.registerTool({
					name: "registered_later",
					description: "Registered after the load.",
					annotations: { readOnlyHint: true },
					execute: () => "later",
				}, { signal: window.later.signal });
			})()`);
				await waitForTools(stack, (n) => n.includes("page_registered_later"));
				expect((await call(stack, "page_registered_later")).content).toEqual([
					{ type: "text", text: "later" },
				]);
				await stack.tab.eval("window.later.abort()");
				await waitForTools(stack, (n) => !n.includes("page_registered_later"));
			},
		);
	}, 220_000);

	test("a tool not marked read-only asks in the panel first; the AI access switch glows while it runs and for the hold after (DEC-225)", async () => {
		let allowed: Promise<CallResult> | undefined;
		const result = await glowsWhileCalling(
			(expression) => stack.panel.eval(expression),
			() => {
				allowed = call(stack, "page_place_order", { item: "tea" });
				return allowed;
			},
			() =>
				answerInPanel(stack, "allow").catch(async (error: unknown) => {
					// How the call ended, if it did: why no question showed.
					const ended = await Promise.race([
						allowed,
						Bun.sleep(1000).then(() => "pending"),
					]);
					throw new Error(
						`${String(error)}\nThe call: ${JSON.stringify(ended)}`,
					);
				}),
		);
		expect(result.content[0]?.text).toContain("tea");
		const declined = call(stack, "page_place_order", { item: "coffee" });
		await answerInPanel(stack, "deny");
		expect((await declined).isError).toBe(true);
		expect(await stack.tab.eval("window.calls.map((c) => c[1])")).not.toContain(
			"coffee",
		);
	});

	test("Recent calls lists a read-only call and a declined one, newest first, once opened (DEC-226)", async () => {
		await listsTheCalls(
			(expression) => stack.panel.eval(expression),
			() => call(stack, "page_get_greeting", { name: "Ada" }),
			async () => {
				const declined = call(stack, "page_place_order", { item: "tea" });
				await answerInPanel(stack, "deny");
				expect((await declined).isError).toBe(true);
			},
			() => stack.panel.click("#calls-summary"),
			new URL(stack.site).host,
		);
		// Closed again for the tests after.
		await stack.panel.eval(`document.getElementById("calls").open = false`);
	});

	test("a question is a notification too: recorded with its text, and answered through it", async () => {
		// The panel is in another window than the page: the question also goes
		// out as a notification, which the Firefox test build records
		// (src/worker/notifications.ts, DEC-220) instead of showing.
		const asked = call(stack, "page_place_order", { item: "recorded" });
		const [id, shown] = await notificationFor(stack, "recorded");
		expect(shown.title).toMatch(/^Allow .+\?$/);
		expect(shown.message).toContain("wants to run");
		expect(shown.contextMessage).toContain("localhost");
		expect(shown.iconUrl).toBe(`moz-extension://${UUID}/icons/icon-128.png`);
		// Firefox's notifications have neither (notificationOptions).
		expect(shown.buttons).toBeUndefined();
		expect(shown.requireInteraction).toBeUndefined();
		// Past the guard against an Allow that comes too soon.
		await Bun.sleep(1_000);
		await inBackground(
			stack,
			`bg.tabMcpNotificationButton(${JSON.stringify(id)}, 0)`,
		);
		const result = await asked;
		expect(result.isError).toBeFalsy();
		expect(result.content[0]?.text).toContain("recorded");
		// Answered: the notification is cleared.
		expect(Object.keys(await recorded(stack))).not.toContain(id);
	});

	test("Firefox's real notifications API takes what the product passes (one, cleared at once)", async () => {
		// The one test of the real API in Firefox. On a desktop it shows for a
		// moment: Firefox has no switch that keeps it off without changing the
		// panel's focus (kb/research/test-browser-notifications.md).
		// The options of a real question, as the worker passed them.
		const allowed = call(stack, "page_place_order", { item: "real" });
		const [id, shown] = await notificationFor(stack, "real");
		await Bun.sleep(1_000);
		// Button 0 is Allow; Firefox's notifications have no other.
		await inBackground(
			stack,
			`bg.tabMcpNotificationButton(${JSON.stringify(id)}, 0)`,
		);
		expect((await allowed).isError).toBeFalsy();
		// Bounded: a call that never answers fails here, not the tests after.
		const real = await stack.panel.eval<{
			created: string;
			/** What getAll had for it: its options, or none. */
			listed: Record<string, unknown> | null;
			cleared: unknown;
			after: boolean;
		}>(`Promise.race([
			(async () => {
				const created = await browser.notifications.create("real-api-check", ${JSON.stringify(shown)});
				const listed = (await browser.notifications.getAll())[created] ?? null;
				const cleared = await browser.notifications.clear(created);
				const after = Object.keys(await browser.notifications.getAll()).includes(created);
				return { created, listed, cleared, after };
			})(),
			new Promise((_, reject) => setTimeout(() => reject(new Error("the real notifications API did not answer in 10 s")), 10_000)),
		])`);
		// What this test is for: the real API takes what the product passes
		// (the permission in the manifest, every option, the icon) and answers.
		// A rejection of any of it fails the eval above.
		expect(real.created).toBe("real-api-check");
		// Not what it is for: whether the system keeps the notification.
		// Without a notification service (a CI runner) it can be gone as soon
		// as it is made: CI run 45002871065, attempts 2 and 3, had it listed
		// and then `clear` false, gone already. So both are accepted; when it
		// is still listed, it is listed as made.
		// Which way it went, both halves: listed or not, and what clear said.
		console.log(
			`notifications: Firefox: listed after create ${real.listed !== null}, clear returned ${real.cleared}`,
		);
		// One assertion either way, so the count of a run does not depend on
		// what the system did: listed, it is listed as made.
		const made = { type: "basic", title: shown.title, message: shown.message };
		expect(real.listed ?? made).toMatchObject(made);
		expect(typeof real.cleared).toBe("boolean");
		expect(real.after).toBe(false);
	});

	test("the page can break only its own object: a replaced getter leaves the extension's tools", async () => {
		await stack.tab.eval(`(() => {
			Object.defineProperty(Document.prototype, "modelContext", { get: () => ({ getTools: async () => [] }), configurable: true });
		})()`);
		const result = await call(stack, "page_info");
		expect(result.structuredContent?.["webmcp"]).toMatchObject({
			available: true,
			tools: 5,
		});
	});

	// navigator.modelContext from here: the test before replaced the document's getter.
	test("registerTool then unregisterTool in one tick: the page's order holds", async () => {
		const names = await stack.tab.eval<string[]>(`(async () => {
			const context = navigator.modelContext;
			const done = context.registerTool({ name: "short_lived", description: "d", execute: () => "x" });
			context.unregisterTool("short_lived");
			await done;
			return (await context.getTools()).map((t) => t.name);
		})()`);
		expect(names).not.toContain("short_lived");
	});

	// Last in this block: it leaves the page with 1024 tools. The registry's
	// rules are unit tests (unit.test.ts); here, that provideContext works
	// across Firefox's worlds and its errors reach the page as the page's
	// own (made in its realm, not "An exception was thrown").
	test("provideContext gives the page's tools; an invalid tool and too many reach the page as its TypeError and QuotaExceededError, with their messages", async () => {
		await stack.tab.eval(
			`navigator.modelContext.provideContext({ tools: [{ name: "provided_one", description: "d", execute: () => "x" }] }).then(() => true)`,
		);
		await waitForTools(stack, (n) => n.includes("page_provided_one"));
		const seen = await stack.tab.eval<Record<string, unknown>>(`(async () => {
			const context = navigator.modelContext;
			const tool = (name) => ({ name, description: "d", execute: () => "x" });
			const names = async () => (await context.getTools()).map((t) => t.name);
			const failure = async (work) => {
				try { await work(); return { name: "none" }; }
				catch (e) {
					return { name: e.name, message: e.message, type: e instanceof TypeError, dom: e instanceof DOMException };
				}
			};
			const provided = (await names()).includes("provided_one");
			const before = (await names()).length;
			const invalid = await failure(() => context.provideContext({ tools: [tool("ok_one"), { name: "broken" }] }));
			const afterInvalid = (await names()).length - before;
			const room = 1024 - (await names()).length;
			for (let i = 0; i < room; i++) await context.registerTool(tool("r" + i));
			const quota = await failure(() => context.registerTool(tool("one_more")));
			const many = await failure(() => context.provideContext({ tools: Array.from({ length: 30 }, (_, i) => tool("p" + i)) }));
			return { provided, invalid, afterInvalid, quota, many, total: (await names()).length };
		})()`);
		expect(seen["provided"]).toBe(true);
		expect(seen["invalid"]).toEqual({
			name: "TypeError",
			message: "the tool broken has no execute",
			type: true,
			dom: false,
		});
		expect(seen["afterInvalid"]).toBe(0);
		for (const key of ["quota", "many"])
			expect({ key, error: seen[key] }).toEqual({
				key,
				error: {
					name: "QuotaExceededError",
					message: "too many tools",
					type: false,
					dom: true,
				},
			});
		expect(seen["total"]).toBe(1024);
	});
});

describe.skipIf(!firefoxOk)("an extension reload or update", () => {
	let stack: Stack;

	beforeAll(async () => {
		stack = await start("webmcp.html", {
			"extensions.webextensions.keepUuidOnUninstall": true,
		});
	}, 90_000);

	afterAll(async () => {
		await stack?.client.close().catch(() => {});
		await stack?.stop();
	});

	test("the page's tools outlive the content script: a new one takes them over at once", async () => {
		const before = await stack.tab.eval<string[]>(
			`document.modelContext.getTools().then((t) => t.map((x) => x.name))`,
		);
		expect(before).toHaveLength(5);
		// What the page holds: its object, and handlers on it. A handler
		// runs for an event the page dispatches itself too.
		expect(
			await stack.tab.eval(`(() => {
				window.held = document.modelContext;
				window.changes = 0;
				window.activated = 0;
				document.modelContext.ontoolchange = () => { window.changes++; };
				document.modelContext.ontoolactivated = () => { window.activated++; };
				document.modelContext.dispatchEvent(new Event("toolactivated"));
				return window.activated;
			})()`),
		).toBe(1);
		await stack.firefox.send("webExtension.uninstall", {
			extension: FIREFOX_ID,
		});
		// The getter is the page's own (bound), the methods were the script's.
		expect(
			await stack.tab.eval(`(async () => {
				if (document.modelContext !== window.held) return "another object";
				try { await document.modelContext.getTools(); return "worked"; }
				catch (e) { return String(e); }
			})()`),
		).toBe("TypeError: can't access dead object");
		// Installed again (an update): the extension puts the content script
		// into the open page itself, and it takes the page's tools over.
		await stack.firefox.installExtension(stack.outdir);
		const panel = await findPanel(stack.firefox);
		expect(
			await stack.tab.waitFor<string[]>(
				`document.modelContext.getTools().then((t) => t.map((x) => x.name))`,
			),
		).toEqual(before);
		const info = await panel.eval<{ webmcp: unknown }>(`(async () => {
			const [tab] = await chrome.tabs.query({ url: "http://localhost/*" });
			return chrome.tabs.sendMessage(tab.id, { type: "page-info" });
		})()`);
		expect(info.webmcp).toEqual({ available: true, tools: 5 });
		expect(
			await stack.tab.eval(`(async () => {
				const context = document.modelContext;
				const greeting = await context.executeTool({ name: "get_greeting" }, { name: "Ada" });
				await context.registerTool({ name: "after_reload", description: "d", execute: () => "x" });
				context.dispatchEvent(new Event("toolactivated"));
				return {
					activated: window.activated,
					same: context === window.held && navigator.modelContext === context,
					greeting,
					changes: window.changes,
					handler: typeof context.ontoolchange,
					tools: (await context.getTools()).length,
				};
			})()`),
		).toEqual({
			activated: 2,
			same: true,
			greeting: "Hello, Ada!",
			changes: 1,
			handler: "function",
			tools: 6,
		});
	}, 60_000);
});

describe.skipIf(!firefoxOk)(
	"a page with the client library, the Firefox build's WebMCP (DEC-207)",
	() => {
		let stack: Stack;

		beforeAll(async () => {
			stack = await start("library.html");
			// Off and on again: the relay lists the test's AI app (a token
			// written into its store is not announced to a running session).
			await stack.panel.eval(`(async () => {
				const port = chrome.runtime.connect({ name: "panel" });
				port.postMessage({ type: "stop" });
				port.postMessage({ type: "connect" });
				await new Promise((resolve) => setTimeout(resolve, 500));
				port.disconnect();
			})()`);
			await waitForTools(
				stack,
				(n) => n.includes("page_complete_todo") && n.includes("page_snapshot"),
			);
		}, 90_000);

		afterAll(async () => {
			await stack?.client.close();
			await stack?.stop();
		});

		test("the page knows the extension and its AI app; a call allowed there is not asked again; a read-only tool's picture reaches the AI app (DEC-224)", async () => {
			await stack.tab.waitFor(
				"window.tabMcpPage?.mcp.extension?.apps.length === 1",
				15_000,
			);
			expect(
				await stack.tab.eval("window.tabMcpPage.mcp.extension.apps"),
			).toEqual([{ name: "Test client", host: "client.example" }]);
			const pending = call(stack, "page_complete_todo", { id: 5 });
			await answerInPanel(stack, "allow");
			expect((await pending).isError).toBeFalsy();
			// Not asked in the page: neither its onConfirm nor a dialog.
			expect(
				await stack.tab.eval(
					`window.tabMcpPage.asked.length === 0 && document.querySelector("dialog.tab-mcp-confirm") === null`,
				),
			).toBe(true);
			expect(
				await stack.tab.eval("window.tabMcpPage.calls.at(-1).client"),
			).toEqual({
				kind: "webmcp",
				via: "tab-mcp-extension",
				name: "Test client",
				host: "client.example",
				allowed: true,
			});
			await step(
				"a picture of 300 KiB across Firefox's worlds, whole; a script in the page gets the text",
				() =>
					picturesThroughTheExtension(
						() => call(stack, "page_snapshot"),
						(expression) => stack.tab.eval(expression),
						{ name: "Test client", host: "client.example" },
					),
			);
		});

		test("without a click, with access to all sites: the library found WebMCP as the page loaded, also while AI access is off (DEC-191, not DEC-223's late install)", async () => {
			await step(
				"page_info: WebMCP with the library's tool, not given late",
				async () => {
					const info = await call(stack, "page_info");
					expect(info.structuredContent?.["webmcp"]).toEqual({
						available: true,
						tools: 2,
					});
				},
			);
			await step(
				"AI access off, a reload: the page has WebMCP at load and the library mirrors into it",
				async () => {
					await stack.panel.eval(`(async () => {
						const port = chrome.runtime.connect({ name: "panel" });
						port.postMessage({ type: "stop" });
						await new Promise((resolve) => setTimeout(resolve, 300));
						port.disconnect();
					})()`);
					await stack.panel.waitFor(
						`document.getElementById("state").dataset.state === "off"`,
						15_000,
					);
					await stack.tab.reload();
					await stack.tab.waitFor(
						`"modelContext" in document && document.documentElement.hasAttribute("data-tab-mcp-handshake")`,
						15_000,
					);
					expect(
						await stack.tab.eval(
							"document.modelContext.getTools().then((t) => t.map((x) => x.name).sort())",
						),
					).toEqual(["complete_todo", "snapshot"]);
				},
			);
			await step(
				"a page that loaded before the content script came (as after an install, or Give access to all sites, with pages open), AI access still off: it gets WebMCP as the script comes, and the library mirrors (review of PR 234)",
				async () => {
					// No registered script: the page loads without it, and the
					// worker's read of the tab in front (the panel is open) puts
					// it in afterwards, with host access.
					await stack.panel.eval(
						`browser.scripting.unregisterContentScripts().then(() => true)`,
					);
					await stack.tab.reload();
					await stack.tab.waitFor(
						`"modelContext" in document && document.documentElement.hasAttribute("data-tab-mcp-handshake")`,
						15_000,
					);
					expect(
						await stack.tab.eval(
							"document.modelContext.getTools().then((t) => t.map((x) => x.name).sort())",
						),
					).toEqual(["complete_todo", "snapshot"]);
					expect(
						await stack.panel.eval(
							`document.getElementById("state").dataset.state`,
						),
					).toBe("off");
				},
			);
		});
	},
);

describe.skipIf(!firefoxOk)(
	"a page with the client library, no access to all sites: WebMCP on a click (DEC-223)",
	() => {
		let stack: Stack;

		beforeAll(async () => {
			stack = await start("plain.html");
		}, 90_000);

		afterAll(async () => {
			await stack?.client.close();
			await stack?.stop();
		});

		/** AI access off or on, as the panel's switch does it. */
		const aiAccess = async (on: boolean) => {
			await stack.panel.eval(`(async () => {
				const port = chrome.runtime.connect({ name: "panel" });
				port.postMessage({ type: ${JSON.stringify(on ? "connect" : "stop")} });
				await new Promise((resolve) => setTimeout(resolve, 300));
				port.disconnect();
			})()`);
			await stack.panel.waitFor(
				`document.getElementById("state").dataset.state === ${JSON.stringify(on ? "on" : "off")}`,
				15_000,
			);
		};
		const mirrors = `"modelContext" in document && document.documentElement.hasAttribute("data-tab-mcp-handshake")`;

		test("a click gives the page WebMCP while AI access is on; Firefox wants a click on every new page", async () => {
			await step(
				"the test build's access to all sites taken away: no content script at load any more",
				async () => {
					await stack.panel.eval(
						`browser.permissions.remove({ origins: ["http://*/*", "https://*/*"] })`,
					);
					await stack.panel.waitFor(
						`browser.scripting.getRegisteredContentScripts().then((s) => s.length === 0)`,
					);
					await stack.tab.navigate(`${stack.site}/library.html`);
					expect(await stack.tab.eval(`"modelContext" in document`)).toBe(
						false,
					);
				},
			);
			await step(
				"while AI access is off a click gives the page nothing, and takes over no state the page faked",
				async () => {
					await aiAccess(false);
					// What an earlier content script would have left in the page
					// (`keptState` in firefox/webmcp.ts), faked by the page: taken
					// over, its object would get the extension's methods at the
					// click (review of PR 234).
					await stack.tab.eval(`(() => {
						const context = { mine: true };
						const state = new Map();
						state.set("tab-mcp:webmcp", state);
						state.set(undefined, context);
						window.e2eFake = context;
						Object.defineProperty(Document.prototype, "modelContext", {
							get: function (key) {
								return key === "tab-mcp:webmcp" ? state : context;
							},
							configurable: true,
						});
						return true;
					})()`);
					await clickIcon(stack);
					await stack.panel.waitFor(
						`!document.getElementById("no-webmcp").hidden`,
						15_000,
					);
					expect(
						await stack.panel.eval(
							`document.getElementById("no-webmcp").textContent`,
						),
					).toContain("While AI access is on");
					await Bun.sleep(300);
					expect(
						await stack.tab.eval(
							`[Object.getOwnPropertyNames(window.e2eFake), typeof window.e2eFake.registerTool]`,
						),
					).toEqual([["mine"], "undefined"]);
					// The page's fake goes; nothing else is in the page.
					await stack.tab.eval(
						`(delete Document.prototype.modelContext, "modelContext" in document)`,
					);
					expect(await stack.tab.eval(`"modelContext" in document`)).toBe(
						false,
					);
				},
			);
			await step(
				"AI access on: the page gets WebMCP and the library's tool is offered, without another click",
				async () => {
					await aiAccess(true);
					await stack.tab.waitFor(mirrors, 15_000);
					await waitForTools(stack, (n) => n.includes("page_complete_todo"));
				},
			);
			await step(
				"a page of the same origin needs a click again in Firefox; the click gives it WebMCP",
				async () => {
					await stack.tab.navigate(`${stack.site}/library.html?again`);
					const refused = await call(stack, "page_info");
					expect(refused.isError).toBe(true);
					expect(refused.content[0]?.text).toContain(
						"In Firefox a click counts for that one page",
					);
					await stack.panel.waitFor(
						`document.getElementById("tab-access").textContent.includes("on every new page")`,
						15_000,
					);
					await clickIcon(stack);
					await stack.tab.waitFor(mirrors, 15_000);
					await waitForTools(stack, (n) => n.includes("page_complete_todo"));
				},
			);
			await step(
				"a page that looks for WebMCP only as it loads gets it and registers nothing: page_info says why",
				async () => {
					await stack.tab.navigate(`${stack.site}/webmcp.html`);
					await clickIcon(stack);
					await stack.tab.waitFor(`"modelContext" in document`, 15_000);
					await stack.panel.waitFor(
						`!document.getElementById("late-webmcp").hidden`,
						15_000,
					);
					const info = await call(stack, "page_info");
					expect(info.structuredContent?.["webmcp"]).toMatchObject({
						available: true,
						tools: 0,
						late: true,
					});
				},
			);
		}, 90_000);
	},
);
