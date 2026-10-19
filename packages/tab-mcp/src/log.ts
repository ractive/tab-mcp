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

/** Truncate an IP for logs: IPv4 to /24, IPv6 to /48. */
export function truncateIp(ip: string): string {
	if (ip.includes(":")) {
		const parts = ip.split(":").filter((p) => p !== "");
		return `${parts.slice(0, 3).join(":")}::/48`;
	}
	const parts = ip.split(".");
	return parts.length === 4 ? `${parts.slice(0, 3).join(".")}.0/24` : "?";
}
