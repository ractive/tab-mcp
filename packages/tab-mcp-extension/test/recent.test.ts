/**
 * "Recent calls" in the worker (DEC-226): what it keeps of each call, how
 * long the list grows, how each call ended, and what it makes of other
 * people's text.
 */

import { describe, expect, test } from "bun:test";
import type {
	RelayClient,
	Tool,
	ToolCallEnd,
	ToolCallOutcome,
	ToolCallStart,
	ToolExecuteOptions,
} from "@ractive-ch/tab-mcp-client";
import type { CallView } from "../src/protocol.ts";
import { MAX_TITLE_HOST } from "../src/worker/navigation.ts";
import {
	argsLine,
	hostLine,
	jsonPrefix,
	MAX_ARGS,
	MAX_CALLS,
	MAX_ERROR,
	MAX_NAME,
	oneLine,
	PREFIX,
	prefixOf,
	RecentCalls,
	siteLine,
} from "../src/worker/recent.ts";

const CLAUDE: RelayClient = {
	kind: "relay",
	grantId: "g1",
	id: "https://claude.ai/oauth/client",
	name: "Claude",
	host: "claude.ai",
};

const start = (
	id: number,
	tool = "page_info",
	args: Record<string, unknown> = {},
	client: RelayClient = CLAUDE,
): ToolCallStart => ({ id, tool, arguments: args, client });

const end = (
	id: number,
	outcome: ToolCallOutcome = "ok",
	text = "done",
	tool = "page_info",
): ToolCallEnd => ({
	id,
	tool,
	client: CLAUDE,
	outcome,
	result: {
		content: [{ type: "text", text }],
		...(outcome === "ok" ? {} : { isError: true }),
	},
	durationMs: 5,
});

function recorded(nameOf?: (grantId: string) => string | undefined) {
	const changes: { call: CallView; added: boolean }[] = [];
	const recent = new RecentCalls(
		(call, added) => changes.push({ call, added }),
		{ now: () => 1_700_000_000_000, ...(nameOf ? { nameOf } : {}) },
	);
	return { recent, changes };
}

/** A call as the library makes it: its start, `execute` with its signal, then the end. */
function run(
	recent: RecentCalls,
	id: number,
	tool = "page_get_greeting",
	args: Record<string, unknown> = {},
) {
	const signal = new AbortController().signal;
	recent.started(start(id, tool, args));
	recent.bind(tool, CLAUDE, signal);
	return signal;
}

describe("the record (DEC-226)", () => {
	test("each call with its AI app, tool, arguments and start, newest first, until it ends", () => {
		const { recent, changes } = recorded();
		recent.started(start(1, "page_get_greeting", { name: "Ada" }));
		expect(recent.list).toEqual([
			{
				id: 1,
				at: 1_700_000_000_000,
				app: "Claude",
				host: "claude.ai",
				tool: "page_get_greeting",
				args: '{"name":"Ada"}',
				state: "running",
			},
		]);
		recent.started(start(2));
		recent.ended(end(1));
		expect(recent.list.map((c) => [c.id, c.state])).toEqual([
			[2, "running"],
			[1, "ok"],
		]);
		expect(changes.map((c) => [c.call.id, c.call.state, c.added])).toEqual([
			[1, "running", true],
			[2, "running", true],
			[1, "ok", false],
		]);
	});

	test(`${MAX_CALLS} kept: the oldest goes when another starts`, () => {
		const { recent } = recorded();
		for (let id = 1; id <= MAX_CALLS + 5; id++) recent.started(start(id));
		expect(recent.count).toBe(MAX_CALLS);
		expect(recent.list[0]?.id).toBe(MAX_CALLS + 5);
		expect(recent.list.at(-1)?.id).toBe(6);
		// The end of one that went changes nothing.
		recent.ended(end(3));
		expect(recent.list.some((c) => c.id === 3)).toBe(false);
	});

	test("each way a call ends", () => {
		const { recent } = recorded();
		const state = (id: number) => recent.list.find((c) => c.id === id);

		run(recent, 1);
		recent.ended(end(1));
		expect(state(1)).toMatchObject({ state: "ok" });
		expect(state(1)).not.toHaveProperty("allowed");

		run(recent, 2);
		recent.ended(end(2, "error", "The page's tool threw.\nat line 3"));
		expect(state(2)).toMatchObject({
			state: "failed",
			error: "The page's tool threw.",
		});

		// Asked: waiting, then allowed once, then ran.
		const asked = run(recent, 3, "page_place_order");
		recent.note(asked, { site: "https://shop.example" });
		recent.note(asked, { waiting: true });
		expect(state(3)).toMatchObject({ state: "waiting" });
		recent.note(asked, { answer: "allow" });
		expect(state(3)).toMatchObject({ state: "running", allowed: "once" });
		recent.ended(end(3, "ok", "done", "page_place_order"));
		expect(state(3)).toMatchObject({
			state: "ok",
			allowed: "once",
			site: "https://shop.example",
		});

		// "Always allow on <host>" in the question, and allowed before.
		const site = run(recent, 4, "page_place_order");
		recent.note(site, { waiting: true });
		recent.note(site, { answer: "site" });
		recent.ended(end(4));
		expect(state(4)).toMatchObject({ state: "ok", allowed: "always" });
		const before = run(recent, 5, "page_place_order");
		recent.note(before, { allowedBefore: true });
		recent.ended(end(5));
		expect(state(5)).toMatchObject({ state: "ok", allowed: "always" });

		// Declined, not answered: the worker's error, told apart by the answer.
		const declined = run(recent, 6, "page_place_order");
		recent.note(declined, { answer: "deny" });
		recent.ended(end(6, "error", "The user did not allow this call."));
		expect(state(6)).toMatchObject({ state: "declined" });
		expect(state(6)).not.toHaveProperty("error");
		const unanswered = run(recent, 7, "page_place_order");
		recent.note(unanswered, { answer: "timeout" });
		recent.ended(end(7, "error", "The user was asked and did not answer."));
		expect(state(7)).toMatchObject({ state: "unanswered" });

		// Busy: not asked, a failure with its reason.
		const busy = run(recent, 8, "page_place_order");
		recent.note(busy, { answer: "busy" });
		recent.ended(end(8, "error", "5 calls of this AI app already wait."));
		expect(state(8)).toMatchObject({ state: "failed" });

		// Cancelled by the AI app; the page out of time.
		run(recent, 9);
		recent.ended(end(9, "cancelled", "The call was cancelled."));
		expect(state(9)).toMatchObject({ state: "cancelled" });
		const slow = run(recent, 10);
		recent.note(slow, { timedOut: true });
		recent.ended(end(10, "error", "did not answer within 30 s."));
		expect(state(10)).toMatchObject({ state: "timeout" });
	});

	test("a note binds to its own call: the newest of that tool by that AI app not yet running, never an ended one", () => {
		const { recent } = recorded();
		const signal = new AbortController().signal;
		recent.started(start(1, "page_a"));
		recent.started(start(2, "page_b"));
		// The library calls `execute` right after `toolcall`: page_a's.
		recent.bind("page_a", CLAUDE, signal);
		recent.note(signal, { site: "https://a.example" });
		expect(recent.list.find((c) => c.id === 1)?.site).toBe("https://a.example");
		expect(recent.list.find((c) => c.id === 2)?.site).toBeUndefined();
		// Another AI app's call of the same tool is not this one.
		const other = new AbortController().signal;
		recent.bind("page_b", { ...CLAUDE, host: "chatgpt.com" }, other);
		recent.note(other, { site: "https://b.example" });
		expect(recent.list.find((c) => c.id === 2)?.site).toBeUndefined();
		// A late answer after the end changes nothing.
		recent.ended(end(1));
		recent.note(signal, { answer: "deny" });
		expect(recent.list.find((c) => c.id === 1)?.state).toBe("ok");
	});

	test("`wrap`: the tool's own `execute` runs, after its call is bound", async () => {
		const { recent } = recorded();
		const tool: Tool = {
			name: "page_info",
			description: "",
			inputSchema: { type: "object" },
			execute: (_input, options) => {
				recent.note(options.signal, { site: "https://shop.example" });
				return "ran";
			},
		};
		recent.started(start(1));
		const options: ToolExecuteOptions = {
			signal: new AbortController().signal,
			client: CLAUDE,
		};
		expect(await recent.wrap(tool).execute({}, options)).toBe("ran");
		expect(recent.list[0]?.site).toBe("https://shop.example");
	});

	test("`watch`: starts until the connection goes, ends after it too (a call in flight as the relay changes)", () => {
		const { recent } = recorded();
		const mcp = new EventTarget();
		const listening = new AbortController();
		recent.watch(mcp, listening.signal);
		mcp.dispatchEvent(new CustomEvent("toolcall", { detail: start(1) }));
		listening.abort();
		mcp.dispatchEvent(new CustomEvent("toolcall", { detail: start(2) }));
		expect(recent.list.map((c) => c.id)).toEqual([1]);
		mcp.dispatchEvent(new CustomEvent("toolcallend", { detail: end(1) }));
		expect(recent.list[0]?.state).toBe("ok");
	});

	test("memory only: the record and the panel's list use no storage API", async () => {
		for (const file of [
			"../src/worker/recent.ts",
			"../src/sidepanel/calls.ts",
		]) {
			const source = await Bun.file(new URL(file, import.meta.url)).text();
			// The code, not its comments (which say where it is not kept).
			const code = source
				.replace(/\/\*[\s\S]*?\*\//g, "")
				.replace(/^\s*\/\/.*$/gm, "");
			expect(code).not.toMatch(
				/indexedDB|IDB|chrome\.storage|browser\.storage|localStorage|sessionStorage|\bKv\b/,
			);
		}
	});

	test("the list is a copy: the panel's message cannot change the record", () => {
		const { recent } = recorded();
		recent.started(start(1));
		const [first] = recent.list;
		if (first) first.state = "ok";
		expect(recent.list[0]?.state).toBe("running");
	});
});

describe("other people's text in the record", () => {
	test(`arguments: one line of JSON, cut to ${MAX_ARGS} characters`, () => {
		const long = argsLine({ text: "x".repeat(10_000) });
		expect(long).toHaveLength(MAX_ARGS);
		expect(long.endsWith("…")).toBe(true);
		expect(long.startsWith('{"text":"xxx')).toBe(true);
		expect(argsLine({})).toBe("{}");
		expect(argsLine(undefined)).toBe("{}");
		// A line break in a value is JSON's \n, never a new line.
		expect(argsLine({ a: "1\n2" })).toBe('{"a":"1\\n2"}');
	});

	test("markup stays text, invisible and direction characters are escaped, controls never break the line", () => {
		const { recent } = recorded();
		recent.started(
			start(
				1,
				"page_<b>x</b>",
				{ html: "<img src=x onerror=alert(1)>", rtl: "a‮b" },
				{ ...CLAUDE, name: "Evil‮\n<script>App" },
			),
		);
		const [call] = recent.list;
		expect(call?.tool).toBe("page_<b>x</b>");
		expect(call?.args).toBe(
			'{"html":"<img src=x onerror=alert(1)>","rtl":"a\\u202Eb"}',
		);
		expect(call?.app).toBe("Evil\\u202E <script>App");
		recent.bind("page_<b>x</b>", CLAUDE, new AbortController().signal);
		recent.ended({
			...end(1, "error", `${"\u0007bad ".repeat(100)}`),
		});
		const error = recent.list[0]?.error ?? "";
		expect(error).toHaveLength(MAX_ERROR);
		expect([...error].some((ch) => (ch.codePointAt(0) ?? 0) < 0x20)).toBe(
			false,
		);
		expect(error.startsWith("\\u0007bad")).toBe(true);
	});

	test(`names cut to ${MAX_NAME} at their end; hosts and sites keep their end, the registrable domain`, () => {
		const { recent } = recorded();
		const signal = new AbortController().signal;
		const name = "n".repeat(500);
		// The reviewer's host: its start says Google, its end who it is.
		const host = `accounts.google.com.verify-session-${"0".repeat(60)}.evil.example`;
		recent.started(start(1, name, {}, { ...CLAUDE, name, host }));
		recent.bind(name, { ...CLAUDE, host }, signal);
		recent.note(signal, { site: `https://${host}:8443` });
		const [call] = recent.list;
		expect(call?.tool).toHaveLength(MAX_NAME);
		expect(call?.app).toHaveLength(MAX_NAME);
		expect(call?.host).toHaveLength(MAX_TITLE_HOST);
		expect(call?.host).toStartWith("…");
		expect(call?.host).toEndWith("0000.evil.example");
		// The site: scheme, the host cut inside it the same way, the port.
		expect(call?.site).toBe(`https://${call?.host}:8443`);
		expect(hostLine("claude.ai")).toBe("claude.ai");
		expect(siteLine("https://shop.example")).toBe("https://shop.example");
		expect(siteLine("not an origin\nat all")).toBe("not an origin at all");
	});

	test("the AI app's name from the connected apps when the library gave none", () => {
		const { recent } = recorded((grantId) =>
			grantId === "g1" ? "Claude from the list" : undefined,
		);
		const { name: _, ...nameless } = CLAUDE;
		recent.started(start(1, "page_info", {}, nameless));
		recent.started(start(2, "page_info", {}, { ...nameless, grantId: "g2" }));
		expect(recent.list.map((c) => [c.app, c.host])).toEqual([
			["", "claude.ai"],
			["Claude from the list", "claude.ai"],
		]);
	});

	test("cut on a code point, never inside a surrogate pair or an escape", () => {
		// An emoji right at the cut: kept whole or left out, never half.
		for (let pad = 140; pad < 152; pad++) {
			const line = argsLine({ q: `${"a".repeat(pad)}🙂🙂🙂` });
			expect(line).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
			expect(line).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
			expect(Array.from(line).length).toBeLessThanOrEqual(MAX_ARGS);
		}
		// An escape at the cut (U+202E as ‮): whole or left out.
		for (let pad = 140; pad < 152; pad++) {
			const line = oneLine(`${"a".repeat(pad)}‮‮‮`, MAX_ARGS);
			expect(line).toEndWith("…");
			expect(line).not.toMatch(/\\(u[0-9A-F]{0,3})?…$/);
		}
	});

	test("a multi-megabyte value: only a bounded prefix of it is read", () => {
		const huge = "x".repeat(5_000_000);
		const budget = MAX_ARGS * PREFIX;
		// The JSON made of it stops at the budget: a long string, a long
		// array, many keys.
		for (const value of [
			{ text: huge },
			{ list: Array.from({ length: 200_000 }, (_, i) => i) },
			Object.fromEntries(
				Array.from({ length: 50_000 }, (_, i) => [`k${i}`, i]),
			),
			{ [huge]: 1 },
		]) {
			const { json, more } = jsonPrefix(value, budget);
			expect(more).toBe(true);
			expect(json.length).toBeLessThanOrEqual(budget + 32);
		}
		// A text: the code points read, not the whole.
		const { head, more } = prefixOf(huge, MAX_ERROR * PREFIX);
		expect([head.length, more]).toEqual([MAX_ERROR * PREFIX, true]);
		expect(argsLine({ text: huge })).toBe(
			`{"text":"${"x".repeat(MAX_ARGS - 10)}…`,
		);
		// What follows the prefix is not even looked at.
		let read = 0;
		const behind = {
			text: huge,
			get after() {
				read++;
				return "never read";
			},
		};
		argsLine(behind);
		expect(read).toBe(0);
		expect(oneLine(huge, MAX_NAME)).toBe(`${"x".repeat(MAX_NAME - 1)}…`);
		// A short value is whole, and its JSON is JSON's.
		const small = { a: [1, "b", null, true], c: { d: "e\n" } };
		expect(jsonPrefix(small, budget)).toEqual({
			json: JSON.stringify(small),
			more: false,
		});
	});
});
