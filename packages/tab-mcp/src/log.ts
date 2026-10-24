import type { LogLevel } from "./config.ts";
import { parseIpv4, parseIpv6 } from "./ip.ts";

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
 * An error for a log line: its name only. Messages can carry request data,
 * and a custom store's can hold token hashes or a connection string.
 */
export function errorName(error: unknown): string {
	return error instanceof Error ? error.name : typeof error;
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
	const onRejection = (error: unknown) => {
		logger.error("process.unhandled_rejection", { error: errorName(error) });
	};
	const onException = (error: unknown) => {
		logger.error("process.uncaught_exception", { error: errorName(error) });
		exit(1);
	};
	process.on("unhandledRejection", onRejection);
	process.on("uncaughtException", onException);
	return () => {
		process.off("unhandledRejection", onRejection);
		process.off("uncaughtException", onException);
	};
}
