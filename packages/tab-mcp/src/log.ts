import type { LogLevel } from "./config.ts";

/**
 * Structured JSON-line logging (threat model A9). Callers pass only metadata:
 * never request or response bodies, tool names, arguments, results, tokens,
 * pairing codes or page secrets. There is deliberately no helper that accepts
 * a body.
 */

export type LogFields = Record<string, string | number | boolean | null>;

export interface Logger {
	error(event: string, fields?: LogFields): void;
	warn(event: string, fields?: LogFields): void;
	info(event: string, fields?: LogFields): void;
	debug(event: string, fields?: LogFields): void;
}

const ORDER: Record<LogLevel, number> = {
	error: 0,
	warn: 1,
	info: 2,
	debug: 3,
};

/** A logger that writes one JSON object per line to `sink` (stdout by default). */
export function createLogger(
	level: LogLevel,
	sink: (line: string) => void = (line) => {
		process.stdout.write(`${line}\n`);
	},
): Logger {
	const max = ORDER[level];
	const write = (lvl: LogLevel, event: string, fields?: LogFields) => {
		if (ORDER[lvl] > max) return;
		sink(
			JSON.stringify({
				time: new Date().toISOString(),
				level: lvl,
				event,
				...fields,
			}),
		);
	};
	return {
		error: (e, f) => write("error", e, f),
		warn: (e, f) => write("warn", e, f),
		info: (e, f) => write("info", e, f),
		debug: (e, f) => write("debug", e, f),
	};
}

/** Parse dotted-quad IPv4 into four octets, or undefined. */
function parseIpv4(ip: string): number[] | undefined {
	const parts = ip.split(".");
	if (parts.length !== 4) return undefined;
	const octets = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : -1));
	return octets.every((o) => o >= 0 && o <= 255) ? octets : undefined;
}

/** Parse IPv6 (with `::`, an optional zone, an embedded IPv4 tail) into 8 groups. */
function parseIpv6(ip: string): number[] | undefined {
	const address = ip.split("%")[0] ?? "";
	const halves = address.split("::");
	if (halves.length > 2) return undefined;
	const parseSide = (side: string): number[] | undefined => {
		if (side === "") return [];
		const groups: number[] = [];
		const items = side.split(":");
		for (const [i, item] of items.entries()) {
			if (i === items.length - 1 && item.includes(".")) {
				const v4 = parseIpv4(item);
				if (v4 === undefined) return undefined;
				groups.push(
					((v4[0] ?? 0) << 8) | (v4[1] ?? 0),
					((v4[2] ?? 0) << 8) | (v4[3] ?? 0),
				);
			} else if (/^[0-9a-fA-F]{1,4}$/.test(item)) {
				groups.push(Number.parseInt(item, 16));
			} else {
				return undefined;
			}
		}
		return groups;
	};
	const head = parseSide(halves[0] ?? "");
	const tail = halves.length === 2 ? parseSide(halves[1] ?? "") : [];
	if (head === undefined || tail === undefined) return undefined;
	if (halves.length === 1) return head.length === 8 ? head : undefined;
	const missing = 8 - head.length - tail.length;
	if (missing < 1) return undefined;
	return [...head, ...new Array<number>(missing).fill(0), ...tail];
}

/**
 * Truncate an IP for logs: IPv4 to /24, IPv6 to /48. IPv4-mapped IPv6
 * (`::ffff:a.b.c.d`) is treated as IPv4. `?` if it does not parse.
 */
export function truncateIp(ip: string): string {
	const v4 = parseIpv4(ip);
	if (v4 !== undefined) return `${v4.slice(0, 3).join(".")}.0/24`;
	const v6 = parseIpv6(ip);
	if (v6 === undefined) return "?";
	const mapped = v6.slice(0, 5).every((g) => g === 0) && v6[5] === 0xffff;
	if (mapped) {
		const hi = v6[6] ?? 0;
		return `${hi >> 8}.${hi & 0xff}.${(v6[7] ?? 0) >> 8}.0/24`;
	}
	return `${v6
		.slice(0, 3)
		.map((g) => g.toString(16))
		.join(":")}::/48`;
}

/**
 * Defence in depth (DEC-047). The relay catches errors per message and per
 * request; anything that still escapes is logged, never silently fatal:
 * - an unhandled promise rejection is logged and the relay keeps running, so one
 *   bad request or tab cannot end every other session;
 * - an uncaught exception is logged and the process exits with 1, because the
 *   relay's state may be inconsistent; the supervisor (Docker, systemd) restarts
 *   it and AI apps keep their tokens (they live in the store).
 * Only the error's name is logged: messages can carry request data.
 * Returns a function that removes the handlers.
 */
export function installCrashLogging(
	logger: Logger,
	exit: (code: number) => void = (code) => process.exit(code),
): () => void {
	const name = (error: unknown) =>
		error instanceof Error ? error.name : typeof error;
	const onRejection = (error: unknown) => {
		logger.error("process.unhandled_rejection", { error: name(error) });
	};
	const onException = (error: unknown) => {
		logger.error("process.uncaught_exception", { error: name(error) });
		exit(1);
	};
	process.on("unhandledRejection", onRejection);
	process.on("uncaughtException", onException);
	return () => {
		process.off("unhandledRejection", onRejection);
		process.off("uncaughtException", onException);
	};
}
