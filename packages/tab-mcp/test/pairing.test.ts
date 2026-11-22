/**
 * Pairing codes (DEC-028, DEC-196): format, how a typed code is read, the
 * index of live codes, lifetime, single use.
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import {
	CODE_ALPHABET,
	CODE_LENGTH,
	CodeIndex,
	type CodeReason,
	newPairingCode,
	normalizeCode,
	PairingCodes,
	shownCode,
} from "../src/oauth/pairing.ts";
import { waitFor } from "./helpers.ts";

const live: PairingCodes<string>[] = [];
const spies: { mockRestore(): void }[] = [];
afterEach(() => {
	for (const c of live.splice(0)) c.stop();
	for (const s of spies.splice(0)) s.mockRestore();
});

/** One owner's codes on `index`; `last()` is its code as `normalizeCode` gives it. */
function codes(
	options: { ttlMs?: number } = {},
	index = new CodeIndex<string>(),
	owner = "a",
) {
	const sent: { code: string; expiresAt: number }[] = [];
	const reasons: CodeReason[] = [];
	const c = new PairingCodes(
		index,
		owner,
		(code, expiresAt, reason) => {
			sent.push({ code, expiresAt });
			reasons.push(reason);
		},
		options,
	);
	live.push(c);
	const last = () => normalizeCode(sent.at(-1)?.code ?? "") ?? "";
	return { c, sent, last, reasons, index };
}

/**
 * Random bytes from a script: each call of `crypto.getRandomValues` fills
 * its buffer with the next value of `fills` (repeated), or with the bytes of
 * an array; real randomness once the script is used up.
 */
function scriptRandom(fills: (number | number[])[]): void {
	const real = crypto.getRandomValues.bind(crypto);
	const spy = spyOn(crypto, "getRandomValues");
	spy.mockImplementation(((buffer: Uint8Array) => {
		const next = fills.shift();
		if (next === undefined) return real(buffer);
		if (typeof next === "number") buffer.fill(next);
		else buffer.set(next);
		return buffer;
	}) as typeof crypto.getRandomValues);
	spies.push(spy);
}

describe("codes", () => {
	test("8 letters of the 20 consonants (RFC 8628 §6.1): no vowels, no Y, no digits", () => {
		expect(CODE_LENGTH).toBe(8);
		expect(CODE_ALPHABET).toBe("BCDFGHJKLMNPQRSTVWXZ");
		for (let i = 0; i < 1000; i++) {
			expect(newPairingCode()).toMatch(/^[BCDFGHJKLMNPQRSTVWXZ]{8}$/);
		}
	});

	test("every letter position roughly uniform", () => {
		const counts = Array.from(
			{ length: CODE_LENGTH },
			() => new Map<string, number>(),
		);
		for (let i = 0; i < 20_000; i++) {
			const code = newPairingCode();
			for (let p = 0; p < CODE_LENGTH; p++) {
				const letter = code[p] ?? "";
				counts[p]?.set(letter, (counts[p]?.get(letter) ?? 0) + 1);
			}
		}
		for (const row of counts) {
			expect([...row.keys()].sort().join("")).toBe(CODE_ALPHABET);
			// Expected 1000 each, standard deviation 31.
			for (const n of row.values()) {
				expect(n).toBeGreaterThan(800);
				expect(n).toBeLessThan(1200);
			}
		}
	});

	test("bytes from 240 up are thrown away, so no letter is more likely (256 is no multiple of 20)", () => {
		// 239 is the last byte kept (239 % 20 = 19: Z); 240 would be B again.
		scriptRandom([
			[240, 0, 255, 19, 250, 20, 241, 239, 0, 0, 0, 0, 0, 0, 0, 0],
		]);
		expect(newPairingCode()).toBe("BZBZBBBB");
		// A buffer with too few usable bytes: the rest comes from the next one.
		scriptRandom([255, [1, 2, 3, 240, 240, 240, 240, 240, 240, 240], 4]);
		expect(newPairingCode()).toBe("CDFGGGGG");
	});

	test("shownCode puts a dash in the middle", () => {
		expect(shownCode("BCDFGHJK")).toBe("BCDF-GHJK");
	});

	test("normalizeCode reads a code in any case, with or without dash and spaces", () => {
		for (const typed of [
			"BCDFGHJK",
			"BCDF-GHJK",
			"bcdf-ghjk",
			"bcdfghjk",
			"BcDf GhJk",
			"  bcdf - ghjk\t",
			"b c d f g h j k",
			"bcdf--ghjk",
		]) {
			expect(normalizeCode(typed)).toBe("BCDFGHJK");
		}
		expect(normalizeCode(shownCode("ZXWVTSRQ"))).toBe("ZXWVTSRQ");
	});

	test("normalizeCode: digits, other letters, other lengths and other characters are malformed", () => {
		for (const typed of [
			"",
			"-",
			"BCDFGHJ", // 7
			"BCDFGHJKL", // 9
			"BCDF-GHJ",
			"12345678",
			"BCDFGHJ1",
			"BCDFGH0K", // a digit that reads like a letter
			"ACDFGHJK", // vowels and Y are not in the alphabet
			"BCDFGHJE",
			"BCDFGHJY",
			"BCDF_GHJK",
			"BCDF.GHJK",
			"BCDF–GHJK", // an en dash is not the dash
			"ＢCDFGHJK", // a full-width B
			"BCDFGHJK\u0000",
			"BCDFGHJK;",
			"<b>CDFGHJK",
		]) {
			expect(normalizeCode(typed)).toBeUndefined();
		}
	});
});

describe("CodeIndex", () => {
	test("a code finds its owner until it is released", () => {
		const index = new CodeIndex<string>();
		const a = index.issue("a");
		const b = index.issue("b");
		expect(a).toMatch(/^[BCDFGHJKLMNPQRSTVWXZ]{8}$/);
		expect(index.size).toBe(2);
		expect(index.owner(a)).toBe("a");
		expect(index.owner(b)).toBe("b");
		index.release(a);
		expect(index.owner(a)).toBeUndefined();
		expect(index.owner(b)).toBe("b");
		expect(index.size).toBe(1);
		// Releasing a code nobody shows changes nothing.
		index.release("BCDFGHJK");
		expect(index.size).toBe(1);
	});

	test("only the normalised form is a key: the shown form and lower case find nobody", () => {
		const index = new CodeIndex<string>();
		const code = index.issue("a");
		expect(index.owner(shownCode(code))).toBeUndefined();
		expect(index.owner(code.toLowerCase())).toBeUndefined();
	});

	test("two owners never get the same live code: a code drawn twice is drawn again", () => {
		const index = new CodeIndex<string>();
		// The generator gives BBBBBBBB, then BBBBBBBB again, then CCCCCCCC.
		scriptRandom([0, 0, 1]);
		expect(index.issue("a")).toBe("BBBBBBBB");
		expect(index.issue("b")).toBe("CCCCCCCC");
		expect(index.owner("BBBBBBBB")).toBe("a");
		expect(index.owner("CCCCCCCC")).toBe("b");
		expect(index.size).toBe(2);
	});

	test("a released code may be issued again, to anyone", () => {
		const index = new CodeIndex<string>();
		scriptRandom([0, 0]);
		expect(index.issue("a")).toBe("BBBBBBBB");
		index.release("BBBBBBBB");
		expect(index.issue("b")).toBe("BBBBBBBB");
		expect(index.owner("BBBBBBBB")).toBe("b");
	});

	test("among many live codes all differ", () => {
		const index = new CodeIndex<number>();
		const issued = new Set<string>();
		for (let i = 0; i < 5000; i++) issued.add(index.issue(i));
		expect(issued.size).toBe(5000);
		expect(index.size).toBe(5000);
	});
});

describe("PairingCodes", () => {
	test("start sends a code as XXXX-XXXX, valid for 2 minutes and kept in the index; a second start repeats it", () => {
		const { c, sent, last, reasons, index } = codes();
		expect(c.active).toBe(false);
		const before = Date.now();
		c.start();
		expect(c.active).toBe(true);
		expect(sent).toHaveLength(1);
		const first = sent[0];
		expect(first?.code).toMatch(
			/^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/,
		);
		expect(first?.expiresAt).toBeGreaterThanOrEqual(before + 120_000);
		expect(first?.expiresAt).toBeLessThanOrEqual(Date.now() + 120_000);
		expect(index.owner(last())).toBe("a");
		c.start();
		expect(sent).toHaveLength(2);
		expect(sent[1]).toEqual(first);
		expect(reasons).toEqual(["start", "start"]);
		expect(index.size).toBe(1);
	});

	test("redeem accepts the current code once; the owner then shows a new one and the old one is nobody's", () => {
		const { c, sent, last, reasons, index } = codes();
		c.start();
		const code = last();
		expect(c.redeem(code)).toBe(true);
		expect(sent).toHaveLength(2);
		expect(reasons).toEqual(["start", "used"]);
		expect(last()).not.toBe(code);
		expect(c.redeem(code)).toBe(false);
		expect(index.owner(code)).toBeUndefined();
		expect(index.owner(last())).toBe("a");
		expect(index.size).toBe(1);
		// The refused old code did not use up the new one.
		expect(sent).toHaveLength(2);
		expect(c.redeem(last())).toBe(true);
	});

	test("redeem takes the code as normalizeCode gives it, not as it is shown", () => {
		const { c, sent } = codes();
		c.start();
		const shown = sent[0]?.code ?? "";
		expect(c.redeem(shown)).toBe(false);
		expect(c.redeem(shown.toLowerCase().replace("-", ""))).toBe(false);
		expect(sent).toHaveLength(1);
		expect(c.redeem(normalizeCode(shown) ?? "")).toBe(true);
	});

	test("a wrong code changes nothing: no attempts are counted against a code", () => {
		const { c, sent, last } = codes();
		c.start();
		const code = last();
		const wrong = code === "BBBBBBBB" ? "CCCCCCCC" : "BBBBBBBB";
		for (let i = 0; i < 50; i++) expect(c.redeem(wrong)).toBe(false);
		expect(sent).toHaveLength(1);
		expect(c.redeem(code)).toBe(true);
	});

	test("another owner's code is refused and stays good for its owner", () => {
		const index = new CodeIndex<string>();
		const a = codes({}, index, "a");
		const b = codes({}, index, "b");
		a.c.start();
		b.c.start();
		expect(a.last()).not.toBe(b.last());
		const theirs = b.last();
		expect(a.c.redeem(theirs)).toBe(false);
		expect(a.sent).toHaveLength(1);
		expect(b.sent).toHaveLength(1);
		expect(index.owner(theirs)).toBe("b");
		expect(b.c.redeem(theirs)).toBe(true);
		// `used` went to the owner whose code it was, and only there.
		expect(b.reasons).toEqual(["start", "used"]);
		expect(a.reasons).toEqual(["start"]);
	});

	test("an expired code is replaced by itself and released; typing it finds nobody", async () => {
		const { c, last, reasons, index } = codes({ ttlMs: 40 });
		c.start();
		const code = last();
		await waitFor(() => last() !== code, "a new code");
		expect(reasons).toEqual(["start", "expired"]);
		expect(index.owner(code)).toBeUndefined();
		expect(c.redeem(code)).toBe(false);
		expect(index.size).toBe(1);
		expect(c.redeem(last())).toBe(true);
	});

	test("a code typed after its time but before the timer fires is refused, and a new one comes as expired", () => {
		const { c, sent, last, reasons, index } = codes();
		c.start();
		const code = last();
		const expiresAt = sent[0]?.expiresAt ?? 0;
		expect(c.redeem(code, expiresAt)).toBe(false);
		expect(reasons).toEqual(["start", "expired"]);
		expect(last()).not.toBe(code);
		expect(index.owner(code)).toBeUndefined();
		expect(c.redeem(code)).toBe(false);
		expect(c.redeem(last())).toBe(true);
	});

	test("a code is good up to the millisecond before it expires", () => {
		const { c, sent, last } = codes();
		c.start();
		expect(c.redeem(last(), (sent[0]?.expiresAt ?? 0) - 1)).toBe(true);
	});

	test("stop ends pairing: the code is released, nothing is accepted and no new codes come", async () => {
		const { c, sent, last, index } = codes({ ttlMs: 30 });
		c.start();
		const code = last();
		c.stop();
		expect(c.active).toBe(false);
		expect(index.owner(code)).toBeUndefined();
		expect(index.size).toBe(0);
		expect(c.redeem(code)).toBe(false);
		await Bun.sleep(80);
		expect(sent).toHaveLength(1);
		expect(index.size).toBe(0);
	});

	test("start after stop shows a new code", () => {
		const { c, last, reasons, index } = codes();
		c.start();
		const first = last();
		c.stop();
		c.start();
		expect(last()).not.toBe(first);
		expect(reasons).toEqual(["start", "start"]);
		expect(index.owner(first)).toBeUndefined();
		expect(c.redeem(first)).toBe(false);
		expect(c.redeem(last())).toBe(true);
	});

	test("many owners on one index: each code is redeemed only by its owner, and every used or stopped code leaves the index", () => {
		const index = new CodeIndex<string>();
		const owners = Array.from({ length: 50 }, (_, i) =>
			codes({}, index, `o${i}`),
		);
		for (const o of owners) o.c.start();
		expect(index.size).toBe(50);
		expect(new Set(owners.map((o) => o.last())).size).toBe(50);
		for (const [i, o] of owners.entries()) {
			const next = owners[(i + 1) % owners.length];
			expect(next?.c.redeem(o.last())).toBe(false);
			expect(index.owner(o.last())).toBe(`o${i}`);
		}
		for (const o of owners.slice(0, 25))
			expect(o.c.redeem(o.last())).toBe(true);
		expect(index.size).toBe(50); // each got a new one
		for (const o of owners) o.c.stop();
		expect(index.size).toBe(0);
	});
});
