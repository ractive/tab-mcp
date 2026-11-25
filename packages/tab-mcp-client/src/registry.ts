/**
 * The tool registry, mirroring WebMCP's `registerTool(tool, { signal })`
 * (DEC-010). Part of the eagerly loaded core.
 */

import type {
	JsonSchema,
	ModelContextRegisterToolOptions,
	ModelContextTool,
	ToolAnnotations,
	ToolCaller,
} from "./types.ts";

const NAME = /^[A-Za-z0-9_.-]{1,128}$/;

/** A validated tool as the registry keeps it. */
export interface RegisteredTool {
	readonly name: string;
	readonly title: string | undefined;
	readonly description: string;
	readonly inputSchema: JsonSchema;
	readonly outputSchema?: JsonSchema | undefined;
	readonly annotations: ToolAnnotations;
	readonly execute: ModelContextTool["execute"];
	/**
	 * `ModelContextRegisterToolOptions.callers`, copied; `undefined`: the default, which
	 * `toolsFor` (serve.ts, the relay and a port) and `mirror` (webmcp.ts) apply.
	 */
	readonly callers?: readonly ToolCaller[] | undefined;
	/** `ModelContextRegisterToolOptions.exposedTo` as origins, passed on to the native registration. */
	readonly exposedTo?: string[] | undefined;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Keywords whose values are data, not schemas (CC 13). */
const DATA = /^(default|examples|const|enum)$/;
/** Keywords whose values map names to schemas: the names are not keywords. */
const NAMED =
	/^(properties|patternProperties|\$defs|definitions|dependentSchemas)$/;

/**
 * Calls `visit` for every schema object in `node`, itself included. The
 * values of `default`, `examples`, `const` and `enum` are data and are
 * skipped. An array, or the map under `properties` and the like (`map`), is
 * not a schema itself: its values are, and its keys are names, not keywords.
 */
function eachSchema(
	node: unknown,
	visit: (schema: Record<string, unknown>) => void,
	depth = 0,
	map = false,
): void {
	if (depth > 64 || typeof node !== "object" || node === null) return;
	map ||= Array.isArray(node);
	if (!map) visit(node as Record<string, unknown>);
	for (const [key, value] of Object.entries(node))
		if (map || !DATA.test(key))
			eachSchema(value, visit, depth + 1, !map && NAMED.test(key));
}

/** A JSON pointer (`/a/b~1c`) inside `root`, or `undefined`. */
function resolvePointer(root: unknown, pointer: string): unknown {
	let node: unknown = root;
	for (const raw of pointer.split("/").slice(1)) {
		let key: string;
		try {
			key = decodeURIComponent(raw);
		} catch {
			return undefined; // a malformed `%`
		}
		key = key.replaceAll("~1", "/").replaceAll("~0", "~");
		if (typeof node !== "object" || node === null || !Object.hasOwn(node, key))
			return undefined;
		node = (node as Record<string, unknown>)[key];
	}
	return node;
}

/**
 * What the validator (loaded only on `connect()`) would throw on later, found
 * now so that a bad schema fails registration: patterns that are not
 * regular expressions, and `$ref`s that do not resolve inside the schema.
 * Without `$id`s; once the validator is loaded, it checks too (`setCompiler`).
 * Also `x-mcp-header`, which makes the relay validate headers it does not
 * know; not supported in v1.
 */
function schemaProblem(root: unknown): string | undefined {
	const anchors = new Set<string>();
	const refs: string[] = [];
	const patterns: string[] = [];
	let header = false;
	eachSchema(root, (o) => {
		if (typeof o["$anchor"] === "string") anchors.add(o["$anchor"]);
		if (typeof o["$ref"] === "string") refs.push(o["$ref"]);
		if (typeof o["pattern"] === "string") patterns.push(o["pattern"]);
		const pp = o["patternProperties"];
		if (isPlainObject(pp)) patterns.push(...Object.keys(pp));
		if ("x-mcp-header" in o) header = true;
	});
	if (header) return "x-mcp-header is not supported by tab-mcp";
	for (const p of patterns) {
		try {
			new RegExp(p, "u");
		} catch {
			return `pattern ${JSON.stringify(p)} is not a valid regular expression`;
		}
	}
	for (const ref of refs) {
		if (!ref.startsWith("#"))
			return `$ref ${JSON.stringify(ref)} points outside the schema`;
		const target = ref.slice(1);
		const found =
			target === "" ||
			(target.startsWith("/")
				? resolvePointer(root, target) !== undefined
				: anchors.has(target));
		if (!found) return `$ref ${JSON.stringify(ref)} does not resolve`;
	}
	return undefined;
}

/**
 * Throw `registerTool`'s error: a `TypeError`, or a `DOMException` of the
 * name `kind`.
 */
function fail(message: string, kind?: string): never {
	message = `registerTool: ${message}`;
	throw kind ? new DOMException(message, kind) : new TypeError(message);
}

/** WebIDL's conversion to a string: a Symbol throws a `TypeError`. */
const text = (value: unknown): string => `${value}`;

/**
 * A copy of a list of the page's, as WebIDL converts a sequence of strings:
 * `undefined` stays, anything but a list (a string, `null`) is a `TypeError`.
 */
function listOf(value: unknown, what: string): string[] | undefined {
	if (value === undefined) return undefined;
	if (typeof value === "string") fail(`${what} must be a list`);
	return [...(value as string[])].map(text);
}

/**
 * The origin of `entry` if it is potentially trustworthy (`https:`, `wss:`
 * or a loopback host), as the draft wants an `exposedTo` entry; a
 * `SecurityError` otherwise.
 */
function trustworthy(entry: string): string {
	try {
		// The origin's own URL, as Secure Contexts asks of the origin: a
		// `blob:https://a.example/x` is `https://a.example`; an opaque origin
		// ("null") does not parse.
		const url = new URL(new URL(entry).origin);
		if (
			/^(https|wss):$/.test(url.protocol) ||
			/^(127(\.\d+){3}|\[::1\]|(.+\.)?localhost\.?)$/.test(url.hostname)
		)
			return url.origin;
	} catch {}
	fail(
		`exposedTo ${JSON.stringify(entry)} is not a potentially trustworthy origin`,
		"SecurityError",
	);
}

/** The validator's check of a schema: throws a `TypeError` naming the problem. */
export type SchemaCompiler = (tool: RegisteredTool) => void;

export class ToolRegistry {
	readonly #tools = new Map<string, RegisteredTool>();
	readonly #listeners = new Set<() => void>();
	#compile: SchemaCompiler | undefined;

	/**
	 * Register a tool, with the checks of the WebMCP draft's `registerTool`
	 * in its order (DEC-227): a `TypeError` for what WebIDL refuses (no
	 * object, no name, description or `execute`), an `InvalidStateError`
	 * `DOMException` for a duplicate, a bad name or an empty description,
	 * the schema's `TypeError`, the abort reason of an aborted signal, a
	 * `SecurityError` for an `exposedTo` entry that is no potentially
	 * trustworthy origin. tab-mcp's own checks are `TypeError`s: a schema
	 * without `"type": "object"` or that the validator cannot use (with the
	 * schemas), a hint that is not a boolean, unknown `callers` and the old
	 * option `webmcp` (with WebIDL's conversion).
	 */
	register(
		tool: ModelContextTool,
		options: ModelContextRegisterToolOptions | null = {},
	): void {
		// WebIDL's conversion of both dictionaries comes first.
		if (!isPlainObject(tool)) fail("the tool must be an object");
		const {
			name: rawName,
			title,
			description,
			inputSchema,
			outputSchema,
			execute,
			annotations,
		} = tool;
		if (rawName === undefined || description === undefined)
			fail("a tool needs a name and a description");
		// Each converted once, as WebIDL does: a page's `toString` runs once.
		const name = text(rawName);
		const about = text(description);
		const heading = title === undefined ? undefined : text(title);
		if (typeof execute !== "function")
			fail(`${name} needs an execute function`);
		for (const [what, schema] of [
			["inputSchema", inputSchema],
			["outputSchema", outputSchema],
		])
			if (schema !== undefined && (typeof schema !== "object" || !schema))
				fail(`the ${what} of ${name} must be an object`);
		if (annotations != null && !isPlainObject(annotations))
			fail(`the annotations of ${name} must be an object`);
		// A hint that is not a boolean is refused, not converted: WebIDL would
		// make `readOnlyHint: "false"` true, and a tool that asks would run
		// unasked (CC 2). Every key ending in `Hint`, and `debugging`, counts
		// as a hint, also one tab-mcp does not know (a later draft's, or a
		// misspelt one); other keys that are not booleans are ignored.
		const hints: ToolAnnotations = {};
		for (const [key, value] of Object.entries(annotations ?? {})) {
			if (typeof value === "boolean")
				(hints as Record<string, boolean>)[key] = value;
			else if (value !== undefined && /Hint$|^debugging$/.test(key))
				fail(`${key} of ${name} must be a boolean`);
		}
		// WebIDL takes `null` options as none.
		const given = options ?? {};
		const { signal } = given;
		if (signal !== undefined && typeof signal?.throwIfAborted !== "function")
			fail("signal must be an AbortSignal");
		// Copies: the page's arrays may change later, what was registered
		// does not.
		const callers = listOf(given.callers, "callers") as
			| ToolCaller[]
			| undefined;
		// The option of 0.15 and before, refused rather than ignored: an
		// ignored `webmcp: false` would put the tool into WebMCP (DEC-165).
		if (
			"webmcp" in given ||
			callers?.some((c) => !/^(relay|local|webmcp)$/.test(c))
		)
			fail(
				'callers must be "relay", "local" or "webmcp"; option webmcp is gone',
			);
		const exposed = listOf(given.exposedTo, "exposedTo");
		const taken = () => {
			if (this.#tools.has(name))
				fail(`a tool named ${name} is already registered`, "InvalidStateError");
		};
		taken();
		if (!NAME.test(name))
			fail(
				`the name must be 1–128 characters of A–Z, a–z, 0–9, "_", "-" or "." (got ${JSON.stringify(name)})`,
				"InvalidStateError",
			);
		if (about === "") fail(`${name} needs a description`, "InvalidStateError");
		/**
		 * An object schema (MCP wants `"type": "object"`), copied as JSON and
		 * checked by `schemaProblem`: an AI app compiles the output schema too.
		 */
		const copy = (schema: unknown, what: string): JsonSchema => {
			if (!isPlainObject(schema) || schema["type"] !== "object")
				fail(
					`the ${what} of ${name} must be a JSON Schema object with "type": "object"`,
				);
			let copied: JsonSchema;
			try {
				copied = JSON.parse(JSON.stringify(schema)) as JsonSchema;
			} catch {
				fail(`the ${what} of ${name} must be JSON`);
			}
			const problem = schemaProblem(copied);
			if (problem !== undefined) fail(`the ${what} of ${name}: ${problem}`);
			return copied;
		};
		const checked: RegisteredTool = {
			name,
			title: heading,
			description: about,
			inputSchema:
				inputSchema === undefined
					? { type: "object" }
					: copy(inputSchema, "inputSchema"),
			outputSchema:
				outputSchema === undefined
					? undefined
					: copy(outputSchema, "outputSchema"),
			annotations: hints,
			execute,
			callers,
		};
		// The validator's check is the schemas' too.
		this.#compile?.(checked);
		// Script in a schema's `toJSON` may have registered the name meanwhile.
		taken();
		signal?.throwIfAborted();
		const registered: RegisteredTool = {
			...checked,
			exposedTo: exposed?.map(trustworthy),
		};
		this.#tools.set(registered.name, registered);
		signal?.addEventListener("abort", () => this.remove(registered), {
			once: true,
		});
		this.#changed();
	}

	/**
	 * The validator is loaded: from now on each schema is compiled when it is
	 * registered, and a tool it refuses is refused (DEC-086).
	 */
	setCompiler(compile: SchemaCompiler): void {
		this.#compile ??= compile;
	}

	/** Unregister this tool, if it still is. */
	remove(tool: RegisteredTool): void {
		if (this.#tools.get(tool.name) !== tool) return;
		this.#tools.delete(tool.name);
		this.#changed();
	}

	get(name: string): RegisteredTool | undefined {
		return this.#tools.get(name);
	}

	/** Tools in registration order. */
	list(): RegisteredTool[] {
		return [...this.#tools.values()];
	}

	/** Listen for changes; returns a function that stops listening. */
	onChange(listener: () => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	#changed(): void {
		for (const listener of [...this.#listeners]) listener();
	}
}
