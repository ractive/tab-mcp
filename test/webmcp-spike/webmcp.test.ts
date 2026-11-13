/**
 * Iteration 18's canary: what kb/research/webmcp-from-extension.md found
 * about Chrome's WebMCP, checked against the pinned Chrome for Testing, so a
 * Chrome change shows. The pages are served through the DevTools Protocol on
 * https://spike.test (no server, no network). Needs Chrome for Testing 156 or newer
 * (`CHROME_PATH`, or Puppeteer's or Playwright's cache): required in CI,
 * skipped elsewhere without it.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Browser, Page, World } from "./browser.ts";
import { chromeMajor, findChromeForTesting } from "./browser.ts";
import { launch, openPage, pageUrl, WEBMCP_ON } from "./spike.ts";

/** The Chrome the findings are for (the `debugging` annotation is new in 156). */
const MIN_MAJOR = 156;

const found = findChromeForTesting();
const chrome =
	found !== undefined && chromeMajor(found) >= MIN_MAJOR ? found : undefined;
if (chrome === undefined && process.env["CI"])
	throw new Error(
		`Chrome for Testing ${MIN_MAJOR} or newer is needed for the WebMCP canary in CI`,
	);

let browser: Browser | undefined;
let page: Page;
let isolated: World;

beforeAll(async () => {
	if (chrome === undefined) return;
	({ browser } = await launch(chrome, [WEBMCP_ON]));
	({ page, isolated } = await openPage(browser, pageUrl));
}, 30_000);

afterAll(async () => {
	await browser?.close();
});

interface Report {
	present: boolean;
	native: boolean;
	tools: {
		name: string;
		keys: string[];
		annotations?: Record<string, boolean>;
	}[];
}

test.skipIf(chrome === undefined)(
	"the content script sees the page's tools on the native object",
	async () => {
		const report = await page.eval<Report>(`spike.probe("report")`, isolated);
		expect(report.present).toBe(true);
		expect(report.native).toBe(true);
		expect(report.tools.map((t) => t.name)).toEqual([
			"get_greeting",
			"get_weather",
			"hang_tool",
			"late_tool",
			"place_order",
			"slow_tool",
		]);
		const weather = report.tools.find((t) => t.name === "get_weather");
		// No outputSchema in Chrome 156, though the draft has it: the bridge shows
		// one in webmcp_tools once Chrome gives it (DEC-144).
		expect(weather?.keys).toEqual([
			"annotations",
			"description",
			"inputSchema",
			"name",
			"origin",
			"title",
			"window",
		]);
		expect(
			report.tools.find((t) => t.name === "place_order")?.annotations,
		).toEqual({
			consequentialHint: true,
			debugging: false,
			readOnlyHint: false,
			untrustedContentHint: false,
		});
	},
);

test.skipIf(chrome === undefined)(
	"executeTool from the content script returns the result as a string",
	async () => {
		const call = (name: string, input: unknown) =>
			page.eval<{ ok: boolean; value: unknown }>(
				`spike.probe("call", ${JSON.stringify({ name, input })})`,
				isolated,
			);
		expect(await call("get_greeting", { name: "Ada" })).toMatchObject({
			ok: true,
			value: "Hello, Ada!",
		});
		// An object result comes back JSON-encoded; the input is not checked
		// against inputSchema.
		expect(await call("get_weather", { city: 7 })).toMatchObject({
			ok: true,
			value: '{"city":7,"celsius":21}',
		});
	},
);

test.skipIf(chrome === undefined)(
	"toolchange reaches the content script, and an abort rejects the call",
	async () => {
		// One event per registration, the late tool's included.
		expect(
			(await page.eval<number[]>("spike.toolchanges()", isolated)).length,
		).toBeGreaterThanOrEqual(6);
		expect(
			await page.eval(
				`spike.probe("call", { name: "hang_tool", cancelAfterMs: 100 })`,
				isolated,
			),
		).toMatchObject({ ok: false, error: expect.stringMatching(/^AbortError/) });
	},
);

test.skipIf(chrome === undefined)(
	"a page replacing document.modelContext does not fool the content script",
	async () => {
		const forged = await openPage(browser as Browser, `${pageUrl}?forge`);
		try {
			const report = await forged.page.eval<Report>(
				`spike.probe("report")`,
				forged.isolated,
			);
			expect(report.native).toBe(true);
			// The page registered its tools on its forgery: the native list is empty.
			expect(report.tools).toEqual([]);
			expect(
				await forged.page.eval(
					"document.modelContext.getTools().then((tools) => tools.map((t) => t.name))",
				),
			).toEqual(["forged_tool"]);
		} finally {
			await forged.page.close();
		}
	},
);

test.skipIf(chrome === undefined)(
	"a tool the content script registers is the page's to list and call",
	async () => {
		expect(
			await page.eval(
				`spike.probe("register", { name: "canary_tool" })`,
				isolated,
			),
		).toMatchObject({ ok: true });
		const listed = await page.eval<string[]>(
			"document.modelContext.getTools().then((tools) => tools.map((t) => t.name))",
		);
		expect(listed).toContain("canary_tool");
		// The page calls it, and it runs in the content script.
		const result = await page.eval<string>(
			`document.modelContext.getTools().then((tools) => document.modelContext.executeTool(tools.find((t) => t.name === "canary_tool"), { from: "page" }))`,
		);
		expect(JSON.parse(result)).toEqual({
			registeredIn: "isolated",
			ranIn: "isolated",
			input: { from: "page" },
		});
		// A name already taken, either way round, is refused.
		expect(
			await page.eval(
				`spike.probe("register", { name: "get_greeting" })`,
				isolated,
			),
		).toMatchObject({
			ok: false,
			error: "InvalidStateError: Duplicate tool name",
		});
	},
);
