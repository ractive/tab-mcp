/** Pairing codes (DEC-028): format, lifetime, attempts, single use. */
import { afterEach, describe, expect, test } from "bun:test";
import { newPairingCode, PairingCodes } from "../src/oauth/pairing.ts";
import { waitFor } from "./helpers.ts";

const live: PairingCodes[] = [];
afterEach(() => {
	for (const c of live.splice(0)) c.stop();
});

function codes(options: { ttlMs?: number } = {}) {
	const sent: { code: string; expiresAt: number }[] = [];
	const c = new PairingCodes(
		(code, expiresAt) => sent.push({ code, expiresAt }),
		options,
	);
	live.push(c);
	const last = () => sent.at(-1)?.code ?? "";
	return { c, sent, last };
}

const other = (code: string) => (code === "000000" ? "000001" : "000000");

describe("codes", () => {
	test("six digits, every digit position roughly uniform", () => {
		const counts = Array.from({ length: 6 }, () =>
			new Array<number>(10).fill(0),
		);
		for (let i = 0; i < 20_000; i++) {
			const code = newPairingCode();
			expect(code).toMatch(/^\d{6}$/);
			for (let p = 0; p < 6; p++) {
				const row = counts[p];
				if (row !== undefined)
					row[Number(code[p])] = (row[Number(code[p])] ?? 0) + 1;
			}
		}
		for (const row of counts) {
			for (const n of row) expect(n).toBeGreaterThan(1700); // expected 2000
		}
	});
});

describe("PairingCodes", () => {
	test("start sends a code valid for 2 minutes; a second start repeats it", () => {
		const { c, sent } = codes();
		const before = Date.now();
		c.start();
		expect(sent).toHaveLength(1);
		const first = sent[0];
		expect(first?.expiresAt).toBeGreaterThanOrEqual(before + 120_000);
		expect(first?.expiresAt).toBeLessThanOrEqual(Date.now() + 120_000);
		c.start();
		expect(sent).toHaveLength(2);
		expect(sent[1]).toEqual(first);
	});

	test("the right code is accepted once and replaced", () => {
		const { c, sent, last } = codes();
		c.start();
		const code = last();
		expect(c.check(code)).toBe("ok");
		expect(sent).toHaveLength(2);
		expect(last()).not.toBe(code);
		expect(c.check(code)).toBe("wrong");
	});

	test("spaces and a dash are allowed (123 456); other input is malformed and not counted", () => {
		const { c, last } = codes();
		c.start();
		for (const bad of ["", "12345", "1234567", "abcdef"])
			expect(c.check(bad)).toBe("malformed");
		expect(c.attemptsLeft).toBe(5);
		const code = last();
		expect(c.check(`${code.slice(0, 3)} ${code.slice(3)}`)).toBe("ok");
	});

	test("5 wrong attempts replace the code", () => {
		const { c, sent, last } = codes();
		c.start();
		const code = last();
		for (let i = 0; i < 4; i++) expect(c.check(other(code))).toBe("wrong");
		expect(c.attemptsLeft).toBe(1);
		expect(c.check(other(code))).toBe("locked");
		expect(sent).toHaveLength(2);
		expect(c.check(code)).not.toBe("ok");
	});

	test("an expired code is replaced by itself; typing it says expired", async () => {
		const { c, last } = codes({ ttlMs: 40 });
		c.start();
		const code = last();
		await waitFor(() => last() !== code, "a new code");
		expect(c.check(code)).toBe("expired");
		expect(c.check(last())).toBe("ok");
	});

	test("a check after the expiry time but before the timer fires says expired", () => {
		const { c, last } = codes();
		c.start();
		const code = last();
		expect(c.check(code, Date.now() + 121_000)).toBe("expired");
		expect(last()).not.toBe(code);
	});

	test("stop ends pairing: nothing is accepted and no new codes come", async () => {
		const { c, sent, last } = codes({ ttlMs: 30 });
		c.start();
		const code = last();
		c.stop();
		expect(c.active).toBe(false);
		expect(c.check(code)).toBe("inactive");
		await Bun.sleep(80);
		expect(sent).toHaveLength(1);
	});
});
