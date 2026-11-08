// The spike's probe: one self-contained function, so that it runs as a
// content script (isolated world) and through
// chrome.scripting.executeScript({ world }) from the service worker alike.
// It returns plain JSON.

// biome-ignore lint/correctness/noUnusedVariables: used by the other scripts
async function webmcpProbe(op, arg = {}) {
	const world =
		typeof chrome !== "undefined" && chrome.runtime?.id ? "isolated" : "main";
	const mc = document.modelContext;
	const native = (fn) =>
		typeof fn === "function" && /\[native code\]/.test(String(fn));
	const error = (e) => `${e?.name ?? "Error"}: ${e?.message ?? e}`;
	try {
		return await run();
	} catch (e) {
		return { world, ok: false, error: error(e) };
	}

	async function run() {
		if (op === "report") {
			if (!mc) return { world, present: false };
			const listed = await mc.getTools(arg.fromOrigins ? arg : undefined);
			return {
				world,
				present: true,
				constructor: mc.constructor?.name,
				native: native(mc.getTools) && native(mc.executeTool),
				tools: listed.map((t) => ({
					name: t.name,
					title: t.title,
					description: t.description,
					inputSchema: t.inputSchema,
					outputSchema: t.outputSchema,
					annotations: t.annotations,
					origin: t.origin,
					keys: Object.keys(t).sort(),
					ownWindow: t.window === window,
				})),
			};
		}

		if (op === "call") {
			// arg: { name, input, cancelAfterMs?, timeoutMs?, fromOrigins? }
			if (!mc) return { world, ok: false, error: "no document.modelContext" };
			const listed = await mc.getTools(
				arg.fromOrigins ? { fromOrigins: arg.fromOrigins } : undefined,
			);
			const tool = listed.find((t) => t.name === arg.name);
			if (!tool) return { world, ok: false, error: `no tool ${arg.name}` };
			const controller = new AbortController();
			if (arg.cancelAfterMs !== undefined)
				setTimeout(() => controller.abort(), arg.cancelAfterMs);
			const started = performance.now();
			const ms = () => Math.round(performance.now() - started);
			const timeout = new Promise((resolve) =>
				setTimeout(
					() => resolve({ world, ok: false, error: "timeout", ms: ms() }),
					arg.timeoutMs ?? 5000,
				),
			);
			const run = mc
				.executeTool(tool, arg.input ?? {}, { signal: controller.signal })
				.then(
					(value) => ({ world, ok: true, value, type: typeof value, ms: ms() }),
					(e) => ({ world, ok: false, error: error(e), ms: ms() }),
				);
			return Promise.race([run, timeout]);
		}

		if (op === "register") {
			// arg: { name }
			if (!mc) return { world, ok: false, error: "no document.modelContext" };
			try {
				await mc.registerTool({
					name: arg.name,
					description: `Registered by the extension (${world} world).`,
					inputSchema: { type: "object" },
					annotations: { readOnlyHint: true },
					async execute(input) {
						const ranIn =
							typeof chrome !== "undefined" && chrome.runtime?.id
								? "isolated"
								: "main";
						return { registeredIn: world, ranIn, input };
					},
				});
				return { world, ok: true };
			} catch (e) {
				return { world, ok: false, error: error(e) };
			}
		}

		return { world, ok: false, error: `unknown op ${op}` };
	}
}
