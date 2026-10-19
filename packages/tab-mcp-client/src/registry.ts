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

export class ToolRegistry {
	readonly #tools = new Map<string, RegisteredTool>();
	readonly #listeners = new Set<() => void>();

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
		this.#tools.set(registered.name, registered);
		signal?.addEventListener(
			"abort",
			() => {
				if (this.#tools.get(registered.name) === registered) {
					this.#tools.delete(registered.name);
					this.#changed();
				}
			},
			{ once: true },
		);
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
