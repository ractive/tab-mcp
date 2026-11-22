/**
 * Headers on every response of the relay, set in one place: every route
 * handler, the fallback and the error handler pass their answer through
 * `withCommonHeaders` (`commonHeaderRoutes` wraps the routes). That covers
 * error answers, redirects, 405s and the MCP answers built from a tab's
 * response alike.
 */

import type { Serve } from "bun";

/**
 * `nosniff`: a browser takes each response as the type it says, never as a
 * script or style sheet it guessed (owner, 2026-11-22).
 */
const COMMON_HEADERS: Readonly<Record<string, string>> = {
	"x-content-type-options": "nosniff",
};

/**
 * `response` with the common headers. `undefined` (a request upgraded to a
 * WebSocket) stays as it is.
 */
export function withCommonHeaders<T extends Response | undefined>(
	response: T,
): T {
	if (!(response instanceof Response)) return response;
	try {
		for (const [k, v] of Object.entries(COMMON_HEADERS)) {
			response.headers.set(k, v);
		}
		return response;
	} catch {
		// Immutable headers (a response from `fetch`): a copy that has them.
		const copy = new Response(response.body, response);
		for (const [k, v] of Object.entries(COMMON_HEADERS)) {
			copy.headers.set(k, v);
		}
		return copy as T;
	}
}

/** A handler whose answer gets the common headers, synchronously if it was. */
export function withCommonHeadersOn<
	A extends unknown[],
	R extends Response | undefined,
>(handler: (...args: A) => R | Promise<R>): (...args: A) => R | Promise<R> {
	return (...args: A) => {
		const answer = handler(...args);
		return answer instanceof Promise
			? answer.then(withCommonHeaders)
			: withCommonHeaders(answer);
	};
}

/** `routes` with every handler's answer (and every fixed response) given the common headers. */
export function commonHeaderRoutes<WebSocketData, R extends string>(
	routes: Serve.RoutesWithUpgrade<WebSocketData, R>,
): Serve.RoutesWithUpgrade<WebSocketData, R> {
	const wrap = (value: unknown): unknown => {
		if (typeof value === "function") {
			return withCommonHeadersOn(
				value as (...args: unknown[]) => Response | undefined,
			);
		}
		if (value instanceof Response) return withCommonHeaders(value);
		return value;
	};
	const out: Record<string, unknown> = {};
	for (const [path, value] of Object.entries(routes)) {
		if (
			typeof value === "object" &&
			value !== null &&
			!(value instanceof Response) &&
			!("dir" in value) &&
			Object.getPrototypeOf(value) === Object.prototype
		) {
			// A handler per method.
			out[path] = Object.fromEntries(
				Object.entries(value).map(([method, h]) => [method, wrap(h)]),
			);
		} else {
			out[path] = wrap(value);
		}
	}
	return out as Serve.RoutesWithUpgrade<WebSocketData, R>;
}
