import { expect, test } from "bun:test";
import { checkExpiry } from "./token-expiry.ts";

test("the expiry check counts whole days and names the renewal steps", () => {
	expect(checkExpiry("2027-10-19", "2026-10-20", 30)).toMatchObject({
		status: "ok",
		daysLeft: 364,
	});
	const soon = checkExpiry("2026-10-30", "2026-10-20", 30);
	expect(soon).toMatchObject({ status: "soon", daysLeft: 10 });
	expect(soon.message).toContain("kb/operations/release-secrets.md");
	expect(checkExpiry("2026-11-19", "2026-10-20", 30).status).toBe("soon");
	expect(checkExpiry("2026-11-20", "2026-10-20", 30).status).toBe("ok");
	expect(checkExpiry("2026-10-20", "2026-10-20", 30).status).toBe("expired");
	expect(checkExpiry("2026-01-01", "2026-10-20", 30).status).toBe("expired");
});

test("a missing or malformed date is an error, not a pass", () => {
	expect(checkExpiry(undefined, "2026-10-20", 30).status).toBe("invalid");
	expect(checkExpiry("", "2026-10-20", 30).status).toBe("invalid");
	expect(checkExpiry("19.10.2027", "2026-10-20", 30).status).toBe("invalid");
	expect(checkExpiry("2027-02-30", "2026-10-20", 30).status).toBe("invalid");
});
