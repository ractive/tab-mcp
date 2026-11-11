/**
 * A small zip writer for the store package, from Overmark's `src/lib/zip.ts`
 * (writer only): stored and deflated entries, no zip64, no encryption.
 * Deflate is zlib's raw deflate in one call (`deflateRawSync`): Bun's
 * streaming `CompressionStream` cuts large inputs into chunks at varying
 * points, so the same file would not always pack to the same bytes.
 */

import { deflateRawSync } from "node:zlib";

export interface ZipEntry {
	/** Path inside the archive, `/`-separated. */
	name: string;
	data: Uint8Array;
}

export interface WriteZipOptions {
	/** The entries' modification time, in UTC (default: now). */
	date?: Date;
}

const LOCAL = 0x04034b50;
const CENTRAL = 0x02014b50;
const END = 0x06054b50;
const UTF8 = 0x0800;

const ALREADY_COMPRESSED = /\.(webp|png|jpe?g|gif|zip|woff2?)$/i;

let table: Uint32Array | undefined;

/** CRC-32 (IEEE), as zip uses it. */
export function crc32(data: Uint8Array): number {
	if (table === undefined) {
		table = new Uint32Array(256);
		for (let n = 0; n < 256; n++) {
			let c = n;
			for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
			table[n] = c >>> 0;
		}
	}
	let crc = 0xffffffff;
	for (const byte of data)
		crc = (table[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
	return (crc ^ 0xffffffff) >>> 0;
}

function deflate(data: Uint8Array): Uint8Array {
	return new Uint8Array(deflateRawSync(data, { level: 9 }));
}

/** A DOS date and time, in UTC, so a zip does not depend on the time zone. */
function dosTime(date: Date): { time: number; day: number } {
	if (date.getUTCFullYear() < 1980) date = new Date(Date.UTC(1980, 0, 1));
	return {
		time:
			(date.getUTCHours() << 11) |
			(date.getUTCMinutes() << 5) |
			Math.floor(date.getUTCSeconds() / 2),
		day:
			((date.getUTCFullYear() - 1980) << 9) |
			((date.getUTCMonth() + 1) << 5) |
			date.getUTCDate(),
	};
}

/** Pack `entries` into a zip archive. */
export async function writeZip(
	entries: readonly ZipEntry[],
	options: WriteZipOptions = {},
): Promise<Uint8Array> {
	if (entries.length > 0xffff)
		throw new Error("more than 65535 entries (zip64 is not supported)");
	const encoder = new TextEncoder();
	const { time, day } = dosTime(options.date ?? new Date());
	const locals: Uint8Array[] = [];
	const centrals: Uint8Array[] = [];
	const seen = new Set<string>();
	let offset = 0;
	for (const entry of entries) {
		if (seen.has(entry.name)) throw new Error(`duplicate entry: ${entry.name}`);
		seen.add(entry.name);
		const name = encoder.encode(entry.name);
		const crc = crc32(entry.data);
		let method = 0;
		let body = entry.data;
		if (!ALREADY_COMPRESSED.test(entry.name) && entry.data.length > 0) {
			const deflated = deflate(entry.data);
			if (deflated.length < entry.data.length) {
				method = 8;
				body = deflated;
			}
		}
		const local = new Uint8Array(30 + name.length);
		const lv = new DataView(local.buffer);
		lv.setUint32(0, LOCAL, true);
		lv.setUint16(4, 20, true);
		lv.setUint16(6, UTF8, true);
		lv.setUint16(8, method, true);
		lv.setUint16(10, time, true);
		lv.setUint16(12, day, true);
		lv.setUint32(14, crc, true);
		lv.setUint32(18, body.length, true);
		lv.setUint32(22, entry.data.length, true);
		lv.setUint16(26, name.length, true);
		local.set(name, 30);
		const central = new Uint8Array(46 + name.length);
		const cv = new DataView(central.buffer);
		cv.setUint32(0, CENTRAL, true);
		cv.setUint16(4, 20, true);
		cv.setUint16(6, 20, true);
		cv.setUint16(8, UTF8, true);
		cv.setUint16(10, method, true);
		cv.setUint16(12, time, true);
		cv.setUint16(14, day, true);
		cv.setUint32(16, crc, true);
		cv.setUint32(20, body.length, true);
		cv.setUint32(24, entry.data.length, true);
		cv.setUint16(28, name.length, true);
		cv.setUint32(42, offset, true);
		central.set(name, 46);
		locals.push(local, body);
		centrals.push(central);
		offset += local.length + body.length;
		if (offset > 0xffffffff)
			throw new Error("more than 4 GiB (zip64 is not supported)");
	}
	const centralSize = centrals.reduce((n, c) => n + c.length, 0);
	if (offset + centralSize > 0xffffffff)
		throw new Error("more than 4 GiB (zip64 is not supported)");
	const end = new Uint8Array(22);
	const ev = new DataView(end.buffer);
	ev.setUint32(0, END, true);
	ev.setUint16(8, entries.length, true);
	ev.setUint16(10, entries.length, true);
	ev.setUint32(12, centralSize, true);
	ev.setUint32(16, offset, true);
	const out = new Uint8Array(offset + centralSize + end.length);
	let at = 0;
	for (const part of [...locals, ...centrals, end]) {
		out.set(part, at);
		at += part.length;
	}
	return out;
}

/** The entry names in a zip's central directory (to check a package). */
export function zipNames(bytes: Uint8Array): string[] {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	let endAt = -1;
	for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--)
		if (view.getUint32(i, true) === END) {
			endAt = i;
			break;
		}
	if (endAt < 0) throw new Error("not a zip archive");
	const count = view.getUint16(endAt + 10, true);
	const decoder = new TextDecoder();
	const names: string[] = [];
	let at = view.getUint32(endAt + 16, true);
	for (let i = 0; i < count; i++) {
		if (at + 46 > bytes.length || view.getUint32(at, true) !== CENTRAL)
			throw new Error("broken central directory");
		const nameLength = view.getUint16(at + 28, true);
		const rest = view.getUint16(at + 30, true) + view.getUint16(at + 32, true);
		names.push(decoder.decode(bytes.subarray(at + 46, at + 46 + nameLength)));
		at += 46 + nameLength + rest;
	}
	return names;
}
