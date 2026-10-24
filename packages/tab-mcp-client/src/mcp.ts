/**
 * The tab's MCP server: the stateless 2026-07-28 subset tab-mcp needs
 * (DEC-049), written for the page instead of bundling the SDK. It answers
 * `server/discover`, `tools/list`, `tools/call` (as SSE, DEC-020) and
 * `subscriptions/listen`, and applies the request checks of the 2026-07-28
 * Streamable HTTP transport (content type, JSON-RPC shape, `_meta` envelope,
 * `MCP-Protocol-Version` / `Mcp-Method` / `Mcp-Name`). Status codes and error
 * codes follow the MCP TypeScript SDK's `createMcpHandler`; the conformance
 * tests compare the two.
 */

import {
	dereference,
	type OutputUnit,
	type Schema,
	validate as validateSchema,
} from "@cfworker/json-schema";
import {
	ANNOTATIONS_META_KEY,
	type CallToolResult,
	errorResult,
	mapAnnotations,
	thrownResult,
	toCallToolResult,
} from "./mapping.ts";
import type { GrantRef } from "./protocol.ts";
import type { RegisteredTool, ToolRegistry } from "./registry.ts";
import type {
	ConfirmRequest,
	ServerInfo,
	ToolCallClient,
	ToolCallEnd,
	ToolCallOutcome,
	ToolCallStart,
} from "./types.ts";

export const MCP_PROTOCOL_VERSION = "2026-07-28";
const META_VERSION = "io.modelcontextprotocol/protocolVersion";
const META_CAPABILITIES = "io.modelcontextprotocol/clientCapabilities";
const META_CLIENT_INFO = "io.modelcontextprotocol/clientInfo";
const META_SERVER_INFO = "io.modelcontextprotocol/serverInfo";
const META_SUBSCRIPTION = "io.modelcontextprotocol/subscriptionId";

const HEADER_MISMATCH = -32020;
const UNSUPPORTED_VERSION = -32022;

type Id = string | number;
type Json = Record<string, unknown>;

export interface ToolSource {
	list(): RegisteredTool[];
	get(name: string): RegisteredTool | undefined;
}

export interface McpHandlerOptions {
	tools: ToolSource;
	server: ServerInfo;
	/** Ask the user before a consequential tool runs. */
	confirm(request: ConfirmRequest): Promise<boolean>;
	/** The caller of a request, from its grant. */
	client(grant: GrantRef): ToolCallClient;
	/** Told about every call of a known tool, as it starts and as it ends. */
	observe?: {
		start(call: ToolCallStart): void;
		end(call: ToolCallEnd): void;
	};
}

/** Tool call ids, unique in the page. */
let lastCallId = 0;

/** Checks arguments against a tool's input schema. */
export type ArgumentValidator = (args: unknown) => {
	valid: boolean;
	errors: OutputUnit[];
};

const compiled = new WeakMap<RegisteredTool, ArgumentValidator>();

/**
 * The validator of a tool's input schema, built once per tool. Throws what
 * the validator would throw at call time: a `$ref` that does not resolve
 * (the validator resolves one only when an argument reaches it, against the
 * base of the nearest `$id`), an `$id` that is not a URL, a duplicate one.
 * `compileRegistry` makes the registry call it at registration (DEC-087).
 */
export function compileTool(tool: RegisteredTool): ArgumentValidator {
	const known = compiled.get(tool);
	if (known !== undefined) return known;
	const schema = tool.inputSchema as Schema;
	let lookup: Record<string, Schema | boolean>;
	try {
		lookup = dereference(schema);
	} catch (error) {
		// Only the first line: the validator appends the URIs it knows.
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(message.split("\n")[0]);
	}
	for (const node of Object.values(lookup)) {
		if (typeof node !== "object" || node.$ref === undefined) continue;
		const absolute = (node as { __absolute_ref__?: string }).__absolute_ref__;
		if (lookup[absolute ?? node.$ref] === undefined)
			throw new Error(`$ref ${JSON.stringify(node.$ref)} does not resolve`);
	}
	const validator: ArgumentValidator = (args) =>
		validateSchema(args, schema, "2020-12", lookup, false);
	compiled.set(tool, validator);
	return validator;
}

function schemaError(name: string, error: unknown, suffix = ""): TypeError {
	const message = error instanceof Error ? error.message : String(error);
	return new TypeError(
		`registerTool: the inputSchema of ${name}: ${message}${suffix}`,
	);
}

/**
 * The validator is loaded (on `connect()`): compile the schemas of the tools
 * registered so far, before any AI app lists them, and from now on at
 * registration, so that `registerTool` rejects a schema the validator cannot
 * use. A tool registered before that it refuses is unregistered; the errors
 * are for the page's `error` event.
 */
export function compileRegistry(registry: ToolRegistry): TypeError[] {
	const refused: TypeError[] = [];
	for (const tool of registry.list()) {
		try {
			compileTool(tool);
		} catch (error) {
			registry.remove(tool);
			refused.push(
				schemaError(tool.name, error, "; the tool was unregistered"),
			);
		}
	}
	registry.setCompiler((tool) => {
		try {
			compileTool(tool);
		} catch (error) {
			throw schemaError(tool.name, error);
		}
	});
	return refused;
}

/** A deep copy for an event; the value itself when it cannot be cloned. */
function copy<T>(value: T): T {
	try {
		return structuredClone(value);
	} catch {
		return value;
	}
}

export interface McpRequestContext {
	grant: GrantRef;
	/** The body as text when the caller already has it. */
	body?: string;
}

export interface McpHandler {
	handle(request: Request, context: McpRequestContext): Promise<Response>;
	/** The tool list changed: tell the listen streams. */
	toolsChanged(): void;
	/** End every listen stream (the session is over). */
	close(): void;
}

const encoder = new TextEncoder();

function isObject(v: unknown): v is Json {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

function json(status: number, value: unknown): Response {
	return new Response(JSON.stringify(value), {
		status,
		headers: { "content-type": "application/json" },
	});
}

function rpcError(
	status: number,
	id: Id | null,
	code: number,
	message: string,
	data?: unknown,
): Response {
	const error: Json = { code, message };
	if (data !== undefined) error["data"] = data;
	return json(status, { jsonrpc: "2.0", id, error });
}

function mismatch(id: Id | null, header: string, body: string): Response {
	return rpcError(
		400,
		id,
		HEADER_MISMATCH,
		`Bad Request: the request headers and body disagree: ${body}`,
		{
			mismatch: { header, body },
		},
	);
}

function sseEvent(message: unknown): Uint8Array {
	return encoder.encode(`event: message\ndata: ${JSON.stringify(message)}\n\n`);
}

const SSE_HEADERS = {
	"content-type": "text/event-stream",
	"cache-control": "no-cache",
};

/** `application/json`, with or without parameters. */
function isJsonContentType(value: string | null): boolean {
	return (
		(value ?? "").split(";")[0]?.trim().toLowerCase() === "application/json"
	);
}

/** Decode the `=?base64?…?=` sentinel of SEP-2243 headers; `undefined` if malformed. */
export function decodeHeaderValue(value: string): string | undefined {
	if (!(value.startsWith("=?base64?") && value.endsWith("?="))) return value;
	const b64 = value.slice(9, -2);
	if (
		!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
			b64,
		)
	)
		return undefined;
	try {
		const bin = atob(b64);
		const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
		return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		return undefined;
	}
}

/** The first problem of a 2026-07-28 `_meta` envelope, or `undefined`. */
function envelopeIssue(
	meta: Json,
): { key: string; problem: string } | undefined {
	if (!(META_VERSION in meta)) return { key: META_VERSION, problem: "missing" };
	if (!(META_CAPABILITIES in meta))
		return { key: META_CAPABILITIES, problem: "missing" };
	if (typeof meta[META_VERSION] !== "string") {
		return { key: META_VERSION, problem: "expected a protocol version string" };
	}
	if (!isObject(meta[META_CAPABILITIES]))
		return { key: META_CAPABILITIES, problem: "expected an object" };
	const info = meta[META_CLIENT_INFO];
	if (
		info !== undefined &&
		!(
			isObject(info) &&
			typeof info["name"] === "string" &&
			typeof info["version"] === "string"
		)
	) {
		return { key: META_CLIENT_INFO, problem: "expected {name, version}" };
	}
	return undefined;
}

/** Listen streams honour only the tool list (the tab has nothing else). */
function honoured(params: Json): Json {
	const requested = params["notifications"];
	return isObject(requested) && requested["toolsListChanged"] === true
		? { toolsListChanged: true }
		: {};
}

export function createMcpHandler(options: McpHandlerOptions): McpHandler {
	const { tools, server } = options;
	const serverInfo: Json = { name: server.name, version: server.version };
	if (server.title !== undefined) serverInfo["title"] = server.title;
	const listeners = new Set<{
		id: Id;
		send(message: unknown): void;
		end(): void;
	}>();
	let changeQueued = false;

	const resultMeta = (extra: Json = {}) => ({
		...extra,
		[META_SERVER_INFO]: serverInfo,
	});

	function result(id: Id, value: Json): Json {
		return {
			jsonrpc: "2.0",
			id,
			result: { ...value, resultType: "complete", _meta: resultMeta() },
		};
	}

	function validate(tool: RegisteredTool, args: Json): string | undefined {
		let outcome: ReturnType<ArgumentValidator>;
		try {
			outcome = compileTool(tool)(args);
		} catch (error) {
			// Refused at registration through `TabMcp`; this is for any other registry.
			const message = error instanceof Error ? error.message : String(error);
			return `The input schema of tool ${tool.name} cannot be used: ${message}`;
		}
		if (outcome.valid) return undefined;
		const detail = outcome.errors
			.filter((e) => e.keyword !== "properties" && e.keyword !== "$ref")
			.map((e) => `${e.instanceLocation} ${e.error}`)
			.slice(0, 5)
			.join("; ");
		return `Input validation error: Invalid arguments for tool ${tool.name}: ${detail || "the arguments do not match the schema"}`;
	}

	function listTools(): Json[] {
		return tools.list().map((tool) => {
			const entry: Json = { name: tool.name };
			if (tool.title !== undefined) entry["title"] = tool.title;
			entry["description"] = tool.description;
			entry["inputSchema"] = tool.inputSchema;
			const { annotations, meta } = mapAnnotations(tool.annotations);
			if (annotations !== undefined) entry["annotations"] = annotations;
			if (meta !== undefined) entry["_meta"] = { [ANNOTATIONS_META_KEY]: meta };
			return entry;
		});
	}

	/**
	 * A call's outcome: a JSON-RPC error (`invalid`) or a result. Tagged, so
	 * that a result's own keys never decide which (a tool may return any).
	 */
	type RunOutcome =
		| { kind: "invalid"; message: string }
		| { kind: "result"; result: CallToolResult };

	const invalidParams = (message: string): RunOutcome => ({
		kind: "invalid",
		message,
	});

	async function runTool(
		params: Json,
		signal: AbortSignal,
		grant: GrantRef,
	): Promise<RunOutcome> {
		const name = params["name"];
		if (typeof name !== "string")
			return invalidParams("Invalid params: name must be a string");
		const tool = tools.get(name);
		if (tool === undefined) return invalidParams(`Tool ${name} not found`);
		const raw = params["arguments"] ?? {};
		if (!isObject(raw))
			return invalidParams("Invalid params: arguments must be an object");
		const client = options.client(grant);
		// Copies: a listener cannot change what the tool gets or the AI app receives.
		const call: ToolCallStart = {
			id: ++lastCallId,
			tool: tool.name,
			arguments: copy(raw),
			client: { ...client },
		};
		if (tool.title !== undefined) call.title = tool.title;
		const started = Date.now();
		options.observe?.start(call);
		// Every start has its end, also when something fails outside the tool.
		let outcome: ToolCallOutcome = "error";
		let res: CallToolResult = errorResult("Internal error");
		try {
			[outcome, res] = await decideAndRun(tool, raw, signal, client);
		} finally {
			options.observe?.end({
				id: call.id,
				tool: tool.name,
				client: { ...client },
				outcome,
				result: copy(res),
				durationMs: Date.now() - started,
			});
		}
		return { kind: "result", result: res };
	}

	/** Validate, confirm and run one call. */
	async function decideAndRun(
		tool: RegisteredTool,
		raw: Json,
		signal: AbortSignal,
		client: ToolCallClient,
	): Promise<[ToolCallOutcome, CallToolResult]> {
		const invalid = validate(tool, raw);
		if (invalid !== undefined) return ["error", errorResult(invalid)];
		if (tool.annotations.consequentialHint === true) {
			const question: ConfirmRequest = {
				tool: { name: tool.name, description: tool.description },
				arguments: raw,
				client,
				signal,
			};
			if (tool.title !== undefined) question.tool.title = tool.title;
			let allowed = false;
			try {
				allowed = await options.confirm(question);
			} catch {
				allowed = false;
			}
			if (!allowed)
				return [
					signal.aborted ? "cancelled" : "declined",
					errorResult("The user declined"),
				];
		}
		if (signal.aborted) return ["cancelled", errorResult("Cancelled")];
		// Unregistered (or replaced) while the user was asked: not the tool
		// the user allowed, or one the page still offers.
		if (tools.get(tool.name) !== tool)
			return ["error", errorResult("The tool is no longer available")];
		let res: CallToolResult;
		try {
			res = toCallToolResult(await tool.execute(raw, { signal, client }));
		} catch (error) {
			res = thrownResult(error);
		}
		// Cancelled is cancelled, however the tool answered the abort.
		if (signal.aborted) return ["cancelled", res];
		return [res.isError === true ? "error" : "ok", res];
	}

	function callTool(
		id: Id,
		params: Json,
		signal: AbortSignal,
		grant: GrantRef,
	): Response {
		const stream = new ReadableStream<Uint8Array>({
			start: (controller) => {
				/** Send the one answer and end the stream, whatever happens. */
				const finish = (message: unknown) => {
					if (signal.aborted) return; // nobody listens any more
					let event: Uint8Array;
					try {
						event = sseEvent(message);
					} catch {
						// e.g. a BigInt or a cycle inside a passed-through result
						event = sseEvent(
							result(
								id,
								errorResult("The tool returned a result that is not JSON."),
							),
						);
					}
					try {
						controller.enqueue(event);
						controller.close();
					} catch {
						// the stream was cancelled meanwhile
					}
				};
				runTool(params, signal, grant).then(
					(outcome) =>
						finish(
							outcome.kind === "invalid"
								? {
										jsonrpc: "2.0",
										id,
										error: { code: -32602, message: outcome.message },
									}
								: result(id, outcome.result),
						),
					() =>
						finish({
							jsonrpc: "2.0",
							id,
							error: { code: -32603, message: "Internal error" },
						}),
				);
			},
		});
		return new Response(stream, { status: 200, headers: SSE_HEADERS });
	}

	function listen(id: Id, params: Json, signal: AbortSignal): Response {
		const notifications = honoured(params);
		const finalResult = {
			jsonrpc: "2.0",
			id,
			result: {
				resultType: "complete",
				_meta: resultMeta({ [META_SUBSCRIPTION]: id }),
			},
		};
		// This stream's own listener: two AI apps may both use the same id.
		let own: { id: Id; send(m: unknown): void; end(): void } | undefined;
		const stream = new ReadableStream<Uint8Array>({
			start: (controller) => {
				controller.enqueue(
					sseEvent({
						jsonrpc: "2.0",
						method: "notifications/subscriptions/acknowledged",
						params: { notifications, _meta: { [META_SUBSCRIPTION]: id } },
					}),
				);
				if (Object.keys(notifications).length === 0) {
					controller.enqueue(sseEvent(finalResult));
					controller.close();
					return;
				}
				const listener = {
					id,
					send: (message: unknown) => {
						try {
							controller.enqueue(sseEvent(message));
						} catch {
							listeners.delete(listener);
						}
					},
					end: () => {
						listeners.delete(listener);
						try {
							controller.enqueue(sseEvent(finalResult));
							controller.close();
						} catch {
							// already cancelled
						}
					},
				};
				own = listener;
				listeners.add(listener);
				signal.addEventListener("abort", () => {
					listeners.delete(listener);
					try {
						controller.close();
					} catch {
						// already closed
					}
				});
			},
			cancel: () => {
				if (own !== undefined) listeners.delete(own);
			},
		});
		return new Response(stream, { status: 200, headers: SSE_HEADERS });
	}

	/** The request checks; a `Response` when the request is refused. */
	function check(
		request: Request,
		body: unknown,
	): Response | { id: Id; method: string; params: Json } | "notification" {
		if (Array.isArray(body)) {
			return rpcError(
				400,
				null,
				-32600,
				"Bad Request: JSON-RPC batches are not supported by this endpoint",
			);
		}
		if (!isObject(body) || body["jsonrpc"] !== "2.0") {
			return rpcError(
				400,
				null,
				-32600,
				"Bad Request: the request body is not a valid JSON-RPC message",
			);
		}
		const method = body["method"];
		const rawId = body["id"];
		if (typeof method !== "string") {
			return "result" in body || "error" in body
				? rpcError(
						400,
						null,
						-32600,
						"Bad Request: JSON-RPC responses cannot be posted to this endpoint",
					)
				: rpcError(
						400,
						null,
						-32600,
						"Bad Request: the request body is not a valid JSON-RPC message",
					);
		}
		const headerVersion = request.headers.get("mcp-protocol-version");
		const headerMethod = request.headers.get("mcp-method");
		const params = isObject(body["params"]) ? body["params"] : {};
		const meta = isObject(params["_meta"]) ? params["_meta"] : undefined;
		const claim = meta !== undefined && META_VERSION in meta;
		const claimed =
			typeof meta?.[META_VERSION] === "string"
				? (meta[META_VERSION] as string)
				: undefined;
		const headerModern =
			headerVersion !== null && headerVersion >= MCP_PROTOCOL_VERSION;

		if (rawId === undefined) {
			// A notification: nothing to answer, but the headers must agree.
			if (
				claimed !== undefined &&
				headerVersion !== null &&
				headerVersion !== claimed
			) {
				return mismatch(
					null,
					headerVersion,
					`the notification envelope names protocol version ${claimed} but the MCP-Protocol-Version header names ${headerVersion}`,
				);
			}
			if (
				(claim || headerModern) &&
				headerMethod !== null &&
				headerMethod !== method
			) {
				return mismatch(
					null,
					headerMethod,
					`the notification body names method ${method} but the Mcp-Method header names ${headerMethod}`,
				);
			}
			return "notification";
		}
		if (typeof rawId !== "string" && typeof rawId !== "number") {
			return rpcError(
				400,
				null,
				-32600,
				"Bad Request: the request body is not a valid JSON-RPC message",
			);
		}
		const id = rawId;
		if (
			!claim ||
			(method === "initialize" &&
				(claimed === undefined || claimed < MCP_PROTOCOL_VERSION))
		) {
			if (method === "initialize") {
				if (headerModern) {
					return mismatch(
						id,
						headerVersion,
						"an initialize request (legacy handshake) was sent with a modern MCP-Protocol-Version header",
					);
				}
				const requested =
					typeof params["protocolVersion"] === "string"
						? params["protocolVersion"]
						: undefined;
				return unsupported(id, requested);
			}
			if (headerModern) {
				const missing = meta === undefined ? ["_meta"] : [META_VERSION];
				return rpcError(
					400,
					id,
					-32602,
					`Invalid params: the MCP-Protocol-Version header names protocol revision ${headerVersion}, but the request is missing the required per-request envelope key(s): ${missing.join(", ")}`,
					{ envelope: { missing } },
				);
			}
			return unsupported(id, headerVersion ?? undefined);
		}
		const issue = envelopeIssue(meta);
		if (issue !== undefined) {
			return rpcError(
				400,
				id,
				-32602,
				`Invalid _meta envelope for protocol revision ${MCP_PROTOCOL_VERSION}: ${issue.key}: ${issue.problem}`,
				{ envelope: issue },
			);
		}
		if (
			headerVersion !== null &&
			claimed !== undefined &&
			headerVersion !== claimed
		) {
			return mismatch(
				id,
				headerVersion,
				`the body envelope names protocol version ${claimed} but the MCP-Protocol-Version header names ${headerVersion}`,
			);
		}
		if (headerMethod !== null && headerMethod !== method) {
			return mismatch(
				id,
				headerMethod,
				`the body names method ${method} but the Mcp-Method header names ${headerMethod}`,
			);
		}
		if (claimed !== MCP_PROTOCOL_VERSION) return unsupported(id, claimed);
		if (headerVersion === null) {
			return mismatch(
				id,
				"(missing)",
				`the body envelope names protocol version ${claimed} but the required MCP-Protocol-Version header is absent`,
			);
		}
		if (headerMethod === null) {
			return mismatch(
				id,
				"(missing)",
				`the body names method ${method} but the required Mcp-Method header is absent`,
			);
		}
		if (method === "tools/call" && typeof params["name"] === "string") {
			const name = params["name"];
			const header = request.headers.get("mcp-name");
			if (header === null) {
				return mismatch(
					id,
					"(missing)",
					`the body carries params.name="${name}" but the required Mcp-Name header is absent`,
				);
			}
			const decoded = decodeHeaderValue(header);
			if (decoded === undefined) {
				return mismatch(
					id,
					header,
					"the Mcp-Name header carries an invalid Base64 sentinel value",
				);
			}
			if (decoded !== name) {
				return mismatch(
					id,
					header,
					`the body carries params.name="${name}" but the Mcp-Name header names "${decoded}"`,
				);
			}
		}
		return { id, method, params };
	}

	function unsupported(id: Id, requested: string | undefined): Response {
		return requested === undefined
			? rpcError(
					400,
					id,
					UNSUPPORTED_VERSION,
					"Unsupported protocol version: the request did not name a protocol version",
					{ supported: [MCP_PROTOCOL_VERSION] },
				)
			: rpcError(
					400,
					id,
					UNSUPPORTED_VERSION,
					`Unsupported protocol version: ${requested}`,
					{ supported: [MCP_PROTOCOL_VERSION], requested },
				);
	}

	async function handle(
		request: Request,
		context: McpRequestContext,
	): Promise<Response> {
		if (request.method.toUpperCase() !== "POST")
			return rpcError(405, null, -32000, "Method not allowed.");
		if (!isJsonContentType(request.headers.get("content-type"))) {
			return rpcError(
				415,
				null,
				-32000,
				"Unsupported Media Type: Content-Type must be application/json",
			);
		}
		let body: unknown;
		try {
			body = JSON.parse(context.body ?? (await request.text()));
		} catch {
			return rpcError(
				400,
				null,
				-32700,
				"Parse error: the request body is not valid JSON",
			);
		}
		const checked = check(request, body);
		if (checked instanceof Response) return checked;
		if (checked === "notification") return new Response(null, { status: 202 });
		const { id, method, params } = checked;
		switch (method) {
			case "server/discover": {
				const discover: Json = {
					supportedVersions: [MCP_PROTOCOL_VERSION],
					capabilities: { tools: { listChanged: true } },
				};
				if (server.instructions !== undefined)
					discover["instructions"] = server.instructions;
				discover["ttlMs"] = 0;
				discover["cacheScope"] = "private";
				return json(200, result(id, discover));
			}
			case "tools/list":
				return json(
					200,
					result(id, { tools: listTools(), ttlMs: 0, cacheScope: "private" }),
				);
			case "tools/call":
				return callTool(id, params, request.signal, context.grant);
			case "subscriptions/listen":
				return listen(id, params, request.signal);
			default:
				return rpcError(404, id, -32601, "Method not found");
		}
	}

	return {
		handle: (request, context) =>
			handle(request, context).catch(() =>
				rpcError(500, null, -32603, "Internal server error"),
			),
		toolsChanged() {
			if (changeQueued) return;
			changeQueued = true;
			// Several registrations in one task produce one notification.
			queueMicrotask(() => {
				changeQueued = false;
				for (const listener of [...listeners]) {
					listener.send({
						jsonrpc: "2.0",
						method: "notifications/tools/list_changed",
						params: { _meta: { [META_SUBSCRIPTION]: listener.id } },
					});
				}
			});
		},
		close() {
			for (const listener of [...listeners]) listener.end();
		},
	};
}
