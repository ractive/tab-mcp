/**
 * The tool registry, mirroring WebMCP's `registerTool(tool, { signal })`
 * (DEC-010). Part of the eagerly loaded core.
 */

import type {
	JsonSchema,
	RegisterToolOptions,
	Tool,
	ToolAnnotations,
} from "./types.ts";

const NAME = /^[A-Za-z0-9_.-]{1,128}$/;

/** A validated tool as the registry keeps it. */
export interface RegisteredTool {
	readonly name: string;
	readonly title: string | undefined;
	readonly description: string;
	readonly inputSchema: JsonSchema;
	readonly annotations: ToolAnnotations;
	readonly execute: Tool["execute"];
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** `x-mcp-header` makes the relay validate headers it does not know; not supported in v1. */
function usesMcpHeader(schema: unknown, depth = 0): boolean {
	if (depth > 64 || typeof schema !== "object" || schema === null) return false;
	if (!Array.isArray(schema) && "x-mcp-header" in schema) return true;
	return Object.values(schema).some((v) => usesMcpHeader(v, depth + 1));
}

/** A JSON pointer (`/a/b~1c`) inside `root`, or `undefined`. */
function resolvePointer(root: unknown, pointer: string): unknown {
	let node: unknown = root;
	for (const raw of pointer.split("/").slice(1)) {
		const key = decodeURIComponent(raw)
			.replaceAll("~1", "/")
			.replaceAll("~0", "~");
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
 */
function schemaProblem(root: unknown): string | undefined {
	const anchors = new Set<string>();
	const refs: string[] = [];
	const patterns: string[] = [];
	const walk = (node: unknown, depth: number): void => {
		if (depth > 64 || typeof node !== "object" || node === null) return;
		if (!Array.isArray(node)) {
			const o = node as Record<string, unknown>;
			if (typeof o["$anchor"] === "string") anchors.add(o["$anchor"]);
			if (typeof o["$ref"] === "string") refs.push(o["$ref"]);
			if (typeof o["pattern"] === "string") patterns.push(o["pattern"]);
			const pp = o["patternProperties"];
			if (typeof pp === "object" && pp !== null)
				patterns.push(...Object.keys(pp));
		}
		for (const v of Object.values(node)) walk(v, depth + 1);
	};
	walk(root, 0);
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
	const { name, title, description, inputSchema, execute, annotations } = tool;
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
	const schema = inputSchema ?? { type: "object" };
	if (!isPlainObject(schema) || schema["type"] !== "object") {
		throw new TypeError(
			`registerTool: the inputSchema of ${name} must be a JSON Schema object with "type": "object"`,
		);
	}
	if (usesMcpHeader(schema)) {
		throw new TypeError(
			`registerTool: ${name} uses x-mcp-header, which tab-mcp does not support`,
		);
	}
	const problem = schemaProblem(schema);
	if (problem !== undefined) {
		throw new TypeError(`registerTool: the inputSchema of ${name}: ${problem}`);
	}
	let copied: JsonSchema;
	try {
		copied = JSON.parse(JSON.stringify(schema)) as JsonSchema;
	} catch {
		throw new TypeError(
			`registerTool: the inputSchema of ${name} must be JSON`,
		);
	}
	if (annotations !== undefined && !isPlainObject(annotations)) {
		throw new TypeError(
			`registerTool: the annotations of ${name} must be an object`,
		);
	}
	const hints: ToolAnnotations = {};
	for (const [key, value] of Object.entries(annotations ?? {})) {
		if (typeof value === "boolean")
			(hints as Record<string, boolean>)[key] = value;
	}
	return {
		name,
		title,
		description,
		inputSchema: copied,
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
	 * Register a tool; throws `TypeError` for an invalid tool and an
	 * `InvalidStateError` `DOMException` for a duplicate name.
	 */
	register(tool: Tool, options: RegisterToolOptions = {}): void {
		const registered = validateTool(tool);
		const { signal } = options;
		if (signal?.aborted) return;
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
	 * registered, and a tool it refuses is refused (DEC-087).
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
