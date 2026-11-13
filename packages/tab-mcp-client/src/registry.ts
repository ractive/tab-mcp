/**
 * The tool registry, mirroring WebMCP's `registerTool(tool, { signal })`
 * (DEC-010). Part of the eagerly loaded core.
 */

import type {
	JsonSchema,
	RegisterToolOptions,
	Tool,
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
	readonly execute: Tool["execute"];
	/**
	 * `RegisterToolOptions.callers`, copied; `undefined`: the default, which
	 * `toolsFor` (serve.ts, the relay and a port) and `mirror` (webmcp.ts) apply.
	 */
	readonly callers?: readonly ToolCaller[] | undefined;
	/** `RegisterToolOptions.exposedTo`, passed on to the native registration. */
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

/** Validate a tool; throws a `TypeError` naming the problem. */
export function validateTool(tool: Tool): RegisteredTool {
	if (!isPlainObject(tool))
		throw new TypeError("registerTool: the tool must be an object");
	const {
		name,
		title,
		description,
		inputSchema,
		outputSchema,
		execute,
		annotations,
	} = tool;
	if (typeof name !== "string" || !NAME.test(name)) {
		throw new TypeError(
			`registerTool: the name must be 1–128 characters of A–Z, a–z, 0–9, "_", "-" or "." (got ${JSON.stringify(name)})`,
		);
	}
	if (typeof description !== "string" || description.trim() === "") {
		throw new TypeError(`registerTool: tool ${name} needs a description`);
	}
	if (title !== undefined && typeof title !== "string") {
		throw new TypeError(`registerTool: the title of ${name} must be a string`);
	}
	if (typeof execute !== "function") {
		throw new TypeError(`registerTool: tool ${name} needs an execute function`);
	}
	/**
	 * An object schema (MCP wants `"type": "object"`), copied as JSON and
	 * checked by `schemaProblem`: an AI app compiles the output schema too.
	 */
	const copy = (schema: unknown, what: string): JsonSchema => {
		if (!isPlainObject(schema) || schema["type"] !== "object") {
			throw new TypeError(
				`registerTool: the ${what} of ${name} must be a JSON Schema object with "type": "object"`,
			);
		}
		let copied: JsonSchema;
		try {
			copied = JSON.parse(JSON.stringify(schema)) as JsonSchema;
		} catch {
			throw new TypeError(`registerTool: the ${what} of ${name} must be JSON`);
		}
		const problem = schemaProblem(copied);
		if (problem !== undefined)
			throw new TypeError(`registerTool: the ${what} of ${name}: ${problem}`);
		return copied;
	};
	const copied = copy(inputSchema ?? { type: "object" }, "inputSchema");
	if (annotations !== undefined && !isPlainObject(annotations)) {
		throw new TypeError(
			`registerTool: the annotations of ${name} must be an object`,
		);
	}
	// A hint that is not a boolean is refused, not dropped: a dropped
	// `consequentialHint: "true"` would run the tool without asking (CC 2).
	// Every key ending in `Hint`, and `debugging`, counts as a hint, also
	// one tab-mcp does not know (a later draft's, or a misspelt one); other
	// keys that are not booleans are ignored.
	const hints: ToolAnnotations = {};
	for (const [key, value] of Object.entries(annotations ?? {})) {
		if (typeof value === "boolean")
			(hints as Record<string, boolean>)[key] = value;
		else if (value !== undefined && /Hint$|^debugging$/.test(key))
			throw new TypeError(`registerTool: ${key} of ${name} must be a boolean`);
	}
	return {
		name,
		title,
		description,
		inputSchema: copied,
		outputSchema:
			outputSchema === undefined
				? undefined
				: copy(outputSchema, "outputSchema"),
		annotations: hints,
		execute,
	};
}

/** The validator's check of a schema: throws a `TypeError` naming the problem. */
export type SchemaCompiler = (tool: RegisteredTool) => void;

export class ToolRegistry {
	readonly #tools = new Map<string, RegisteredTool>();
	readonly #listeners = new Set<() => void>();
	#compile: SchemaCompiler | undefined;

	/**
	 * Register a tool; throws `TypeError` for an invalid tool, an
	 * `InvalidStateError` `DOMException` for a duplicate name and the abort
	 * reason for an aborted signal (as WebMCP).
	 */
	register(tool: Tool, options: RegisterToolOptions = {}): void {
		const { signal, exposedTo } = options;
		// A copy: the page's array may change later, what was registered does
		// not. Not a list: the spread throws a `TypeError` itself.
		const callers = options.callers && [...options.callers];
		// The option of 0.15 and before, refused rather than ignored: an ignored
		// `webmcp: false` would put the tool into WebMCP (DEC-165).
		if (
			"webmcp" in options ||
			callers?.some((c) => !/^(relay|local|webmcp)$/.test(c))
		)
			throw new TypeError(
				'registerTool: callers must be "relay", "local" or "webmcp"; option webmcp is gone',
			);
		const registered: RegisteredTool = {
			...validateTool(tool),
			callers,
			exposedTo,
		};
		signal?.throwIfAborted();
		if (this.#tools.has(registered.name)) {
			throw new DOMException(
				`registerTool: a tool named ${registered.name} is already registered`,
				"InvalidStateError",
			);
		}
		this.#compile?.(registered);
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
