import { describe, expect, test } from "bun:test";
import {
	addressIdFromSecret,
	base32,
	isAddressId,
	isWellFormedSecret,
	newSecret,
} from "../src/address.ts";

describe("base32 (RFC 4648 §10 test vectors, lower case, no padding)", () => {
	const vectors: [string, string][] = [
		["", ""],
		["f", "my"],
		["fo", "mzxq"],
		["foo", "mzxw6"],
		["foob", "mzxw6yq"],
		["fooba", "mzxw6ytb"],
		["foobar", "mzxw6ytboi"],
	];
	for (const [input, output] of vectors) {
		test(JSON.stringify(input), () => {
			expect(base32(new TextEncoder().encode(input))).toBe(output);
		});
	}
});

describe("addresses from secrets (DEC-027)", () => {
	test("a new secret is 43 base64url characters", () => {
		const s = newSecret();
		expect(isWellFormedSecret(s)).toBe(true);
		expect(newSecret()).not.toBe(s);
	});

	test("the address id is base32(sha256(secret)), 52 characters", () => {
		const secret = "A".repeat(43);
		const digest = new Bun.CryptoHasher("sha256").update(secret).digest();
		expect(addressIdFromSecret(secret)).toBe(base32(new Uint8Array(digest)));
		expect(addressIdFromSecret(secret)).toHaveLength(52);
		expect(isAddressId(addressIdFromSecret(secret))).toBe(true);
	});

	test("the same secret gives the same address, another secret another", () => {
		const s = newSecret();
		expect(addressIdFromSecret(s)).toBe(addressIdFromSecret(s));
		expect(addressIdFromSecret(newSecret())).not.toBe(addressIdFromSecret(s));
	});

	test("malformed secrets and ids are refused", () => {
		expect(isWellFormedSecret("short")).toBe(false);
		expect(isWellFormedSecret(`${"A".repeat(42)}=`)).toBe(false);
		expect(isWellFormedSecret("A".repeat(44))).toBe(false);
		expect(isAddressId("A".repeat(52))).toBe(false);
		expect(isAddressId("a".repeat(51))).toBe(false);
		expect(isAddressId("a1".repeat(26))).toBe(false);
	});
});
