/**
 * Reading a body with a size limit: a request's, with a deadline, and the
 * relay's own fetches'. Bun's idle timeout does not fire while a handler
 * waits for an unfinished body (DEC-048), so a client that sends its headers
 * and then stalls would hold the socket and the handler for as long as it
 * keeps the connection open. Every endpoint that reads a body goes through
 * `readBodyWithDeadline` (DEC-128).
 */

export type BodyResult =
	| { ok: true; bytes: Uint8Array }
	| { ok: false; reason: "too_large" | "timeout" | "unreadable" };

/**
 * Everything `reader` gives, or `"too_large"` once it passes `maxBytes` (the
 * reader is then cancelled). Counted while it arrives: a body without
 * `Content-Length` (chunked) is cut off at the limit, not buffered whole
 * first. No reader is an empty body. Rejects when the stream fails.
 */
export async function readCapped(
	reader:
		| Pick<ReadableStreamDefaultReader<Uint8Array>, "read" | "cancel">
		| undefined,
	maxBytes: number,
): Promise<Uint8Array | "too_large"> {
	const chunks: Uint8Array[] = [];
	let size = 0;
	while (reader !== undefined) {
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
}

/** The body of `req`, at most `maxBytes`, within `timeoutMs`. */
export async function readBodyWithDeadline(
	req: Request,
	maxBytes: number,
	timeoutMs: number,
): Promise<BodyResult> {
	const length = Number(req.headers.get("content-length") ?? "0");
	if (length > maxBytes) return { ok: false, reason: "too_large" };
	const reader = req.body?.getReader();
	if (reader === undefined) return { ok: true, bytes: new Uint8Array(0) };
	const reading = readCapped(reader, maxBytes);
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
