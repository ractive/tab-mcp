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

describe("address ids from secrets (DEC-027): what a tab is, no longer part of a URL (DEC-196)", () => {
	test("a new secret is 43 base64url characters", () => {
		const s = newSecret();
		expect(isWellFormedSecret(s)).toBe(true);
		expect(newSecret()).not.toBe(s);
	});

	test("the address id is base32(sha256(app, a line feed, secret)), 52 characters", () => {
		const secret = "A".repeat(43);
		const digest = new Bun.CryptoHasher("sha256")
			.update(`calc\n${secret}`)
			.digest();
		expect(addressIdFromSecret(secret, "calc")).toBe(
			base32(new Uint8Array(digest)),
		);
		expect(addressIdFromSecret(secret, "calc")).toHaveLength(52);
		expect(isAddressId(addressIdFromSecret(secret, "calc"))).toBe(true);
	});

	test("the same secret and app give the same address id; another secret or another app another", () => {
		const s = newSecret();
		expect(addressIdFromSecret(s, "calc")).toBe(addressIdFromSecret(s, "calc"));
		expect(addressIdFromSecret(newSecret(), "calc")).not.toBe(
			addressIdFromSecret(s, "calc"),
		);
		// The same secret under another app is another page (DEC-196).
		expect(addressIdFromSecret(s, "notes")).not.toBe(
			addressIdFromSecret(s, "calc"),
		);
		// No two (app, secret) pairs share the hashed text: an app id has no
		// line feed, so where the app ends is never in doubt.
		expect(addressIdFromSecret(`b${s.slice(1)}`, "a")).not.toBe(
			addressIdFromSecret(s.slice(1), "ab"),
		);
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
