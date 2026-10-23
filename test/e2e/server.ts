/**
 * Serves the calculator test page with Bun's HTML import (Bun bundles the
 * page's TypeScript and CSS) and `/config.json`, which tells the page its relay.
 */

import index from "./src/index.html";

export interface TestPageOptions {
	/** The relay the page connects to, e.g. `http://localhost:8080` (a function: read per request). */
	relay: string | (() => string);
	/** Listen port on the loopback address; 0 picks a free one. */
	port: number;
}

export function serveTestPage(
	options: TestPageOptions,
): ReturnType<typeof Bun.serve> {
	const { relay } = options;
	return Bun.serve({
		port: options.port,
		hostname: "127.0.0.1",
		development: false,
		routes: {
			"/": index,
			"/config.json": () =>
				new Response(
					JSON.stringify({
						relay: typeof relay === "string" ? relay : relay(),
					}),
					{
						headers: {
							"content-type": "application/json",
							"cache-control": "no-store",
						},
					},
				),
		},
		fetch: () => new Response("Not found", { status: 404 }),
	});
}
