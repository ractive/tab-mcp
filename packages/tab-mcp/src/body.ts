/**
 * Reading a request body with a size limit and a deadline. Bun's idle timeout
 * does not fire while a handler waits for an unfinished body (DEC-048), so a
 * client that sends its headers and then stalls would hold the socket and the
 * handler for as long as it keeps the connection open. Every endpoint that
 * reads a body goes through here (DEC-128).
 */

export type BodyResult =
	| { ok: true; bytes: ArrayBuffer }
	| { ok: false; reason: "too_large" | "timeout" | "unreadable" };

/** The body of `req`, at most `maxBytes`, within `timeoutMs`. */
export async function readBodyWithDeadline(
	req: Request,
	maxBytes: number,
	timeoutMs: number,
): Promise<BodyResult> {
	const length = Number(req.headers.get("content-length") ?? "0");
	if (length > maxBytes) return { ok: false, reason: "too_large" };
	const reading = req.arrayBuffer();
	reading.catch(() => {}); // rejects once the socket is closed
	let timer: Timer | undefined;
	const deadline = new Promise<"timeout">((resolve) => {
		timer = setTimeout(() => resolve("timeout"), timeoutMs);
	});
	let result: ArrayBuffer | "timeout";
	try {
		result = await Promise.race([reading, deadline]);
	} catch {
		return { ok: false, reason: "unreadable" };
	} finally {
		clearTimeout(timer);
	}
	if (result === "timeout") return { ok: false, reason: "timeout" };
	if (result.byteLength > maxBytes) return { ok: false, reason: "too_large" };
	return { ok: true, bytes: result };
}
