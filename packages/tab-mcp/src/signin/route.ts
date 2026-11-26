/**
 * A group grant's MCP messages (DEC-232): what the relay reads of them to
 * choose the member, and what it changes. It reads the JSON-RPC method, a
 * `tools/call`'s tool name and its `tab` argument, and the result of the
 * response to the request; it changes the `tab` argument (the member's own
 * tab id instead of `<member>:<tab>`), adds a line naming the member that
 * answered, and joins the members' `list_tabs`. Everything else passes as it
 * came. Page grants never come here: their requests and responses pass
 * byte for byte, as before.
 */

import { type RpcId, sseEvent } from "../exchange.ts";
import type { GroupMode, GroupPin } from "../protocol.ts";

/** The `_meta` key of a group grant's results that names the member that answered. */
export const ANSWERED_BY_META = "ch.ractive.tab-mcp/answeredBy";

/** What a call that cannot find its tab tells the AI app (as the extension's own text, DEC-230). */
export const LIST_TABS_HINT =
	"Call list_tabs for the tabs you may use, then pass tab with the call, or use_tab to pin one.";

/** A group's tab id, `<member>:<tab>`: a member id and a browser's own tab id. */
const GROUP_TAB = /^(m_[A-Za-z0-9_-]{1,40}):(\d{1,15})$/;

/** At most this many characters of a `tab` argument go into a text for the AI app. */
const MAX_SHOWN_TAB = 64;
/** A title in the joined `list_tabs`, as the extension cuts it. */
const MAX_TAB_TITLE = 200;
/** An address in the joined `list_tabs`, as the extension cuts it. */
const MAX_TAB_URL = 2048;
/** Tabs of one member taken from its answer, at most (the extension lists 100). */
const MAX_MEMBER_TABS = 100;

type Json = Record<string, unknown>;

function isObject(v: unknown): v is Json {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** The member and the browser's tab id of a group's tab id; `undefined` if it is none. */
export function splitTab(
	tab: string,
): { member: string; tab: string } | undefined {
	const m = GROUP_TAB.exec(tab);
	return m?.[1] === undefined || m[2] === undefined
		? undefined
		: { member: m[1], tab: m[2] };
}

/** A group's tab id. */
export function groupTab(member: string, tab: string): string {
	return `${member}:${tab}`;
}

/** A `tab` argument as a text may quote it: cut, in JSON quotes. */
export function shownTab(tab: string): string {
	return JSON.stringify(tab.slice(0, MAX_SHOWN_TAB));
}

/** A `tools/call` request: its tool name and its `tab` argument, if it has one. */
export interface ToolCall {
	name: string;
	/** The `tab` argument as sent (any JSON value); `undefined` if there is none. */
	tab: unknown;
}

/** The tool call in a request body, or `undefined` for any other method. */
export function toolCall(body: Json): ToolCall | undefined {
	if (body["method"] !== "tools/call") return undefined;
	const params = body["params"];
	if (!isObject(params) || typeof params["name"] !== "string") {
		return undefined;
	}
	const args = params["arguments"];
	return {
		name: params["name"],
		tab: isObject(args) ? args["tab"] : undefined,
	};
}

/** The request body with its `tab` argument set to `tab` (a tool call's). */
export function withTab(body: Json, tab: string): string {
	const params = body["params"] as Json;
	const args = params["arguments"] as Json;
	return JSON.stringify({
		...body,
		params: { ...params, arguments: { ...args, tab } },
	});
}

/** A tool result with `isError` and one text: what the relay answers for a call it cannot route. */
export function toolError(rpcId: RpcId | undefined, text: string): string {
	return JSON.stringify({
		jsonrpc: "2.0",
		id: rpcId ?? null,
		result: {
			resultType: "complete",
			content: [{ type: "text", text }],
			isError: true,
		},
	});
}

/** A tool result with JSON content: one text with the JSON, the object as `structuredContent`, and more texts. */
export function toolResult(
	rpcId: RpcId | undefined,
	value: Json,
	texts: string[],
	meta: Json,
): string {
	return JSON.stringify({
		jsonrpc: "2.0",
		id: rpcId ?? null,
		result: {
			resultType: "complete",
			content: [
				{ type: "text", text: JSON.stringify(value) },
				...texts.map((text) => ({ type: "text", text })),
			],
			structuredContent: value,
			_meta: meta,
		},
	});
}

/** The JSON-RPC response to `rpcId` (it has `result` or `error`). */
function isResponseTo(v: unknown, rpcId: RpcId | undefined): v is Json {
	return (
		isObject(v) &&
		v["jsonrpc"] === "2.0" &&
		!("method" in v) &&
		("result" in v || "error" in v) &&
		v["id"] === (rpcId ?? null)
	);
}

/** The data of one event of an event stream; `undefined` for a comment or an event of another type. */
function eventData(lines: string[]): string | undefined {
	let type = "message";
	const data: string[] = [];
	for (const line of lines) {
		if (line.startsWith(":")) continue;
		const i = line.indexOf(":");
		const name = i < 0 ? line : line.slice(0, i);
		const value = i < 0 ? "" : line.slice(i + 1).replace(/^ /, "");
		if (name === "event") type = value;
		else if (name === "data") data.push(value);
	}
	return type === "message" && data.length > 0 ? data.join("\n") : undefined;
}

/**
 * The events of an event stream as they arrive: each complete event (up
 * to its blank line) with its raw text and its lines. A line ends with LF,
 * CRLF or CR; a CR at the end of what came so far waits for the next piece,
 * which may begin with the LF of the same line end.
 */
class EventSplitter {
	#buffer = "";

	/** The complete events in `text` and what came before it. */
	push(text: string, final = false): { raw: string; lines: string[] }[] {
		this.#buffer += text;
		const out: { raw: string; lines: string[] }[] = [];
		const re = /([^\r\n]*)(\r\n|\n|\r)/y;
		let start = 0;
		let lines: string[] = [];
		let pos = 0;
		for (;;) {
			re.lastIndex = pos;
			const m = re.exec(this.#buffer);
			if (m === null) break;
			if (m[2] === "\r" && re.lastIndex === this.#buffer.length && !final) {
				break;
			}
			pos = re.lastIndex;
			if (m[1] === "") {
				out.push({ raw: this.#buffer.slice(start, pos), lines });
				lines = [];
				start = pos;
			} else {
				lines.push(m[1] ?? "");
			}
		}
		this.#buffer = this.#buffer.slice(start);
		if (final && this.#buffer !== "") {
			out.push({ raw: this.#buffer, lines: [] });
			this.#buffer = "";
		}
		return out;
	}
}

/**
 * The member's response with the JSON-RPC response to `rpcId` changed by
 * `edit`: in a JSON body, or as its event in an event stream (the stream's
 * other events, comments and keep-alives pass unchanged, as they come).
 * Any other body passes as it is.
 */
export async function editResponse(
	response: Response,
	rpcId: RpcId | undefined,
	edit: (message: Json) => Json,
): Promise<Response> {
	const type = (response.headers.get("content-type") ?? "").toLowerCase();
	const headers = new Headers(response.headers);
	headers.delete("content-length");
	const init = { status: response.status, headers };
	if (response.body === null) return response;
	if (type.startsWith("application/json")) {
		const text = await response.text();
		let value: unknown;
		try {
			value = JSON.parse(text);
		} catch {
			return new Response(text, init);
		}
		return new Response(
			isResponseTo(value, rpcId) ? JSON.stringify(edit(value)) : text,
			init,
		);
	}
	if (!type.startsWith("text/event-stream")) return response;
	const decoder = new TextDecoder();
	const encoder = new TextEncoder();
	const splitter = new EventSplitter();
	let edited = false;
	const pass = (
		events: { raw: string; lines: string[] }[],
		controller: TransformStreamDefaultController<Uint8Array>,
	) => {
		for (const event of events) {
			let out = event.raw;
			if (!edited) {
				const data = eventData(event.lines);
				let value: unknown;
				try {
					value = data === undefined ? undefined : JSON.parse(data);
				} catch {
					value = undefined;
				}
				if (isResponseTo(value, rpcId)) {
					edited = true;
					out = sseEvent(JSON.stringify(edit(value)));
				}
			}
			controller.enqueue(encoder.encode(out));
		}
	};
	const stream = response.body.pipeThrough(
		new TransformStream<Uint8Array, Uint8Array>({
			transform(chunk, controller) {
				pass(
					splitter.push(decoder.decode(chunk, { stream: true })),
					controller,
				);
			},
			flush(controller) {
				pass(splitter.push(decoder.decode(), true), controller);
			},
		}),
	);
	return new Response(stream, init);
}

/**
 * The JSON-RPC response to `rpcId` in a member's body text: a JSON body, or
 * an event of an event stream. `undefined` if there is none.
 */
export function findResponse(
	text: string,
	contentType: string,
	rpcId: RpcId | undefined,
): Json | undefined {
	const type = contentType.toLowerCase();
	if (type.startsWith("application/json")) {
		try {
			const value: unknown = JSON.parse(text);
			return isResponseTo(value, rpcId) ? value : undefined;
		} catch {
			return undefined;
		}
	}
	if (!type.startsWith("text/event-stream")) return undefined;
	for (const event of new EventSplitter().push(text, true)) {
		const data = eventData(event.lines);
		if (data === undefined) continue;
		try {
			const value: unknown = JSON.parse(data);
			if (isResponseTo(value, rpcId)) return value;
		} catch {
			// not JSON: not the response
		}
	}
	return undefined;
}

/** Who answered a group grant's request, and what the AI app reads about it. */
export interface AnsweredBy {
	member: string;
	label: string;
	/** The line added to a tool result. */
	text: string;
}

/**
 * A response with the member that answered named: a tool result gets a
 * last text (`text`), every result `_meta` with the member. The result's
 * other content and its `structuredContent` stay as they are, so an output
 * schema still holds. An error passes unchanged.
 */
export function nameMember(
	message: Json,
	toolResultToo: boolean,
	who: AnsweredBy,
): Json {
	const result = message["result"];
	if (!isObject(result)) return message;
	const out: Json = { ...result };
	if (toolResultToo && Array.isArray(out["content"])) {
		out["content"] = [...out["content"], { type: "text", text: who.text }];
	}
	out["_meta"] = {
		...(isObject(out["_meta"]) ? out["_meta"] : {}),
		[ANSWERED_BY_META]: { member: who.member, label: who.label },
	};
	return { ...message, result: out };
}

/** Whether a tool result in a response is an error (`isError`, or a JSON-RPC error). */
export function failed(message: Json): boolean {
	const result = message["result"];
	return !isObject(result) || result["isError"] === true;
}

/** "the browser “work Chrome”". */
export function browserName(label: string): string {
	return `the browser “${label}”`;
}

/** The line that names the member in a tool result. */
export function answeredText(
	member: string,
	label: string,
	fallback?: { kind: "offline"; label: string } | { kind: "unknown" },
): string {
	const why =
		fallback === undefined
			? ""
			: fallback.kind === "offline"
				? ` The browser whose window had the focus last, “${fallback.label}”, is not online, so the call went to the one that came online last.`
				: " No browser of the group has said which window has the focus, so the call went to the one that came online last.";
	return `Answered by ${browserName(label)} (its tabs are ${member}:<id> in list_tabs).${why}`;
}

/** A tab as the joined `list_tabs` names it. */
export interface GroupListedTab {
	tab: string;
	browser: string;
	title: string;
	url: string;
	inFront?: true;
	pinned?: true;
}

/** One member's part of the joined `list_tabs`. */
export interface MemberAnswer {
	member: string;
	label: string;
	online: boolean;
	/** The member's tool result (`result` of its response), when it answered. */
	result?: Json;
	/** Why it has no tabs in the list: offline, busy, no answer, an error. */
	error?: string;
}

const cut = (text: string, max: number) =>
	text.length > max ? `${text.slice(0, max - 1)}…` : text;

/** A count from a member's answer, if it is one. */
function count(v: unknown): number | undefined {
	return typeof v === "number" && Number.isSafeInteger(v) && v > 0
		? v
		: undefined;
}

/**
 * The tabs of one member's `list_tabs` result, checked: its
 * `structuredContent`, else the JSON of its first text. A member answers
 * for itself only, and what it says is checked like any other answer: ids
 * of the browser's form, texts cut as the extension cuts them.
 */
export function memberTabs(
	result: Json,
): { tabs: Json[]; more?: number; notReadable?: number } | undefined {
	let value: unknown = result["structuredContent"];
	if (!isObject(value)) {
		const content = result["content"];
		const first = Array.isArray(content) ? content[0] : undefined;
		if (isObject(first) && typeof first["text"] === "string") {
			try {
				value = JSON.parse(first["text"]);
			} catch {
				return undefined;
			}
		}
	}
	if (!isObject(value) || !Array.isArray(value["tabs"])) return undefined;
	const tabs = value["tabs"]
		.filter(
			(t): t is Json =>
				isObject(t) &&
				typeof t["tab"] === "string" &&
				/^\d{1,15}$/.test(t["tab"]) &&
				typeof t["title"] === "string" &&
				typeof t["url"] === "string",
		)
		.slice(0, MAX_MEMBER_TABS);
	const more = count(value["more"]);
	const notReadable = count(value["notReadable"]);
	return {
		tabs,
		...(more === undefined ? {} : { more }),
		...(notReadable === undefined ? {} : { notReadable }),
	};
}

/**
 * The joined `list_tabs` of a group: every online member's tabs, with ids
 * `<member>:<tab>` and the browser's label, and every member with whether
 * it answered. The pin is the relay's; each browser's `inFront` is the tab
 * in front of its own window. At most `budget` characters of tabs: the
 * rest are counted in `more`.
 */
export function joinTabLists(
	answers: MemberAnswer[],
	routing: { mode: GroupMode; pin?: GroupPin },
	target: { member: string; label: string } | undefined,
	budget: number,
): Json {
	const tabs: GroupListedTab[] = [];
	const browsers: Json[] = [];
	let used = 0;
	let left = 0;
	for (const answer of answers) {
		const list =
			answer.result === undefined ? undefined : memberTabs(answer.result);
		const entry: Json = {
			browser: answer.label,
			member: answer.member,
			online: answer.online,
		};
		if (list === undefined) {
			entry["error"] =
				answer.error ??
				(answer.online ? "Its answer was not a list of tabs." : "Not online.");
			browsers.push(entry);
			continue;
		}
		let listed = 0;
		for (const t of list.tabs) {
			const tab: GroupListedTab = {
				tab: groupTab(answer.member, String(t["tab"])),
				browser: answer.label,
				title: cut(String(t["title"]), MAX_TAB_TITLE),
				url: cut(String(t["url"]), MAX_TAB_URL),
				...(t["inFront"] === true ? { inFront: true as const } : {}),
				...(routing.mode === "pinned" &&
				routing.pin?.member === answer.member &&
				routing.pin.tab === String(t["tab"])
					? { pinned: true as const }
					: {}),
			};
			const size = JSON.stringify(tab).length;
			if (used + size > budget) {
				left++;
				continue;
			}
			used += size;
			tabs.push(tab);
			listed++;
		}
		entry["tabs"] = listed;
		if (list.more !== undefined) entry["more"] = list.more;
		if (list.notReadable !== undefined) entry["notReadable"] = list.notReadable;
		browsers.push(entry);
	}
	const pinLabel =
		routing.pin === undefined
			? undefined
			: answers.find((a) => a.member === routing.pin?.member)?.label;
	const where =
		routing.mode === "front"
			? target === undefined
				? "Calls without a tab argument go to the tab in front of the browser whose window had the focus last; none is online."
				: `Calls without a tab argument go to the tab in front of ${browserName(target.label)} (inFront there), the browser whose window had the focus last.`
			: routing.pin === undefined
				? `Calls without a tab argument go to a pinned tab; none is pinned yet, so the next one pins the tab in front of ${target === undefined ? "the browser whose window had the focus last" : browserName(target.label)}.`
				: `Calls without a tab argument go to the pinned tab ${groupTab(routing.pin.member, routing.pin.tab)} in ${browserName(pinLabel ?? "that was removed")} (pinned), wherever the user is.`;
	return {
		mode: routing.mode === "front" ? "the tab in front" : "a pinned tab",
		tabs,
		browsers,
		...(left > 0 ? { more: left } : {}),
		note: [
			where,
			"These are the tabs of every browser signed in with the user's account in the tab-mcp browser extension: a tab id names the browser and the tab (<member>:<id>). Pass it as tab to page_info, webmcp_tools, webmcp_call, navigate, go_back, go_forward or reload to work in that tab without moving the pin, or call use_tab to pin it. After list_tabs, pass tab with every call: another conversation may pin another tab.",
			left > 0
				? `${left} more tab${left === 1 ? " is" : "s are"} not listed: the list is full.`
				: "",
			"Titles and addresses are the pages' own text.",
		]
			.filter((line) => line !== "")
			.join(" "),
	};
}
