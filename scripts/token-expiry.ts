/**
 * Warn before the Docker Hub token expires (DEC-070,
 * kb/operations/release-secrets.md). Reads the repository variable
 * `DOCKERHUB_TOKEN_EXPIRES` (`YYYY-MM-DD`, the day the token stops working):
 *
 *   DOCKERHUB_TOKEN_EXPIRES=2027-10-19 bun scripts/token-expiry.ts [--mode fail|warn] [--days 30] [--today YYYY-MM-DD]
 *
 * `--mode fail` (the monthly check) fails when the token expires within
 * `--days` days; `--mode warn` (the release) only warns then and fails once
 * the token has expired. Both fail when the variable is missing or malformed.
 */

import { parseArgs } from "node:util";

export const RENEWAL_DOC =
	"https://github.com/ractive/tab-mcp/blob/main/kb/operations/release-secrets.md";

export interface ExpiryCheck {
	status: "ok" | "soon" | "expired" | "invalid";
	/** Whole days from `today` until the expiry date (0 = expires today). */
	daysLeft?: number;
	message: string;
}

const DAY_MS = 86_400_000;

function parseDay(text: string): number | undefined {
	const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
	if (match === null) return undefined;
	const [, y, m, d] = match.map(Number) as [number, number, number, number];
	const time = Date.UTC(y, m - 1, d);
	const back = new Date(time);
	if (back.getUTCMonth() !== m - 1 || back.getUTCDate() !== d) return undefined;
	return time;
}

export function checkExpiry(
	expires: string | undefined,
	today: string,
	warnDays: number,
): ExpiryCheck {
	const end = expires === undefined ? undefined : parseDay(expires.trim());
	const now = parseDay(today);
	if (now === undefined) throw new Error(`not a date: ${today}`);
	if (end === undefined)
		return {
			status: "invalid",
			message: `DOCKERHUB_TOKEN_EXPIRES is ${expires === undefined || expires === "" ? "not set" : `"${expires}", not YYYY-MM-DD`}; set it to the token's expiry date (${RENEWAL_DOC})`,
		};
	const daysLeft = Math.round((end - now) / DAY_MS);
	if (daysLeft <= 0)
		return {
			status: "expired",
			daysLeft,
			message: `The Docker Hub token DOCKERHUB_TOKEN expired on ${expires}: pushing the image will fail. Renew it: ${RENEWAL_DOC}`,
		};
	if (daysLeft <= warnDays)
		return {
			status: "soon",
			daysLeft,
			message: `The Docker Hub token DOCKERHUB_TOKEN expires on ${expires}, in ${daysLeft} day${daysLeft === 1 ? "" : "s"}. Renew it: ${RENEWAL_DOC}`,
		};
	return {
		status: "ok",
		daysLeft,
		message: `The Docker Hub token expires on ${expires}, in ${daysLeft} days.`,
	};
}

if (import.meta.main) {
	const { values } = parseArgs({
		args: Bun.argv.slice(2),
		options: {
			mode: { type: "string", default: "fail" },
			days: { type: "string", default: "30" },
			today: { type: "string" },
		},
	});
	if (values.mode !== "fail" && values.mode !== "warn") {
		console.error("usage: --mode fail|warn");
		process.exit(2);
	}
	const today = values.today ?? new Date().toISOString().slice(0, 10);
	const result = checkExpiry(
		process.env["DOCKERHUB_TOKEN_EXPIRES"],
		today,
		Number(values.days),
	);
	const fails =
		result.status === "invalid" ||
		result.status === "expired" ||
		(result.status === "soon" && values.mode === "fail");
	const level = fails ? "error" : result.status === "soon" ? "warning" : "";
	console.log(level ? `::${level}::${result.message}` : result.message);
	process.exit(fails ? 1 : 0);
}
