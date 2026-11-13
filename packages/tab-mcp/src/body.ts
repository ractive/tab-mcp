/**
 * Reading a request body with a size limit and a deadline. Bun's idle timeout
 * does not fire while a handler waits for an unfinished body (DEC-048), so a
 * client that sends its headers and then stalls would hold the socket and the
 * handler for as long as it keeps the connection open. Every endpoint that
 * reads a body goes through here (DEC-128).
 */

export type BodyResult =
	| { ok: true; bytes: Uint8Array }
	| { ok: false; reason: "too_large" | "timeout" | "unreadable" };

/**
 * The body of `req`, at most `maxBytes`, within `timeoutMs`. Counted while it
 * arrives: a body without `Content-Length` (chunked) is refused once it passes
 * the limit, not buffered whole first.
 */
export async function readBodyWithDeadline(
	req: Request,
	maxBytes: number,
	timeoutMs: number,
): Promise<BodyResult> {
	const length = Number(req.headers.get("content-length") ?? "0");
	if (length > maxBytes) return { ok: false, reason: "too_large" };
	const reader = req.body?.getReader();
	if (reader === undefined) return { ok: true, bytes: new Uint8Array(0) };
	const reading = (async (): Promise<Uint8Array | "too_large"> => {
		const chunks: Uint8Array[] = [];
		let size = 0;
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > maxBytes) {
				reader.cancel().catch(() => {});
				return "too_large";
			}
			chunks.push(value);
		}
		const bytes = new Uint8Array(size);
		let offset = 0;
		for (const chunk of chunks) {
			bytes.set(chunk, offset);
			offset += chunk.byteLength;
		}
		return bytes;
	})();
	reading.catch(() => {}); // rejects once the socket is closed
	let timer: Timer | undefined;
	const deadline = new Promise<"timeout">((resolve) => {
		timer = setTimeout(() => resolve("timeout"), timeoutMs);
	});
	let result: Uint8Array | "too_large" | "timeout";
	try {
		result = await Promise.race([reading, deadline]);
	} catch {
		return { ok: false, reason: "unreadable" };
	} finally {
		clearTimeout(timer);
	}
	if (result === "timeout") {
		reader.cancel().catch(() => {});
		return { ok: false, reason: "timeout" };
	}
	if (result === "too_large") return { ok: false, reason: "too_large" };
	return { ok: true, bytes: result };
}
