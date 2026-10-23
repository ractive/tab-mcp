/**
 * Serves the React todo page with Bun's HTML import (Bun bundles the TSX,
 * React and the CSS) and `/config.json`, which tells the page its relay.
 */

import index from "./src/index.html";

export interface ExampleServerOptions {
	/** The relay the page connects to (a function: read per request). */
	relay: string | (() => string);
	/** Listen port; 0 picks a free one. */
	port?: number;
	/** Listen address; loopback by default. */
	hostname?: string;
	/** Bun's development mode (bundles on request, browser console in the terminal). */
	development?: boolean;
}

export function serveExample(
	options: ExampleServerOptions,
): ReturnType<typeof Bun.serve> {
	const { relay } = options;
	return Bun.serve({
		port: options.port ?? 3001,
		hostname: options.hostname ?? "127.0.0.1",
		development: options.development === true ? { console: true } : false,
		routes: {
			"/": index,
			"/config.json": () =>
				Response.json(
					{ relay: typeof relay === "string" ? relay : relay() },
					{ headers: { "cache-control": "no-store" } },
				),
		},
		fetch: () => new Response("Not found", { status: 404 }),
	});
}
