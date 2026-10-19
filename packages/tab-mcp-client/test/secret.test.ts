import { expect, test } from "bun:test";
import { addressIdFromSecret } from "@ractive-ch/tab-mcp";
import { base64url, isSecret, newSecret, SecretStore } from "../src/secret.ts";
import { MemoryStorage } from "./helpers.ts";

test("base64url matches the platform encoder", () => {
	for (const n of [0, 1, 2, 3, 31, 32, 33]) {
		const bytes = crypto.getRandomValues(new Uint8Array(n));
		expect(base64url(bytes)).toBe(
			bytes.toBase64({ alphabet: "base64url", omitPadding: true }),
		);
	}
});

test("a secret is 43 base64url characters and gives a 52-character address id", () => {
	const secret = newSecret();
	expect(isSecret(secret)).toBe(true);
	expect(addressIdFromSecret(secret)).toMatch(/^[a-z2-7]{52}$/);
});

test("the secret is kept in storage and stable", () => {
	const storage = new MemoryStorage();
	const a = new SecretStore(storage, "k").get();
	expect(storage.items.get("k")).toBe(a);
	expect(new SecretStore(storage, "k").get()).toBe(a);
});

test("an invalid stored value is replaced", () => {
	const storage = new MemoryStorage();
	storage.setItem("k", "too-short");
	const s = new SecretStore(storage, "k").get();
	expect(isSecret(s)).toBe(true);
	expect(storage.items.get("k")).toBe(s);
});

test("rotate makes a new secret; another store on the same storage sees it", () => {
	const storage = new MemoryStorage();
	const a = new SecretStore(storage, "k");
	const b = new SecretStore(storage, "k");
	const first = a.get();
	expect(b.get()).toBe(first);
	const second = a.rotate();
	expect(second).not.toBe(first);
	expect(b.get()).toBe(second);
});

test("without storage, or with storage that throws, the secret lives as long as the page", () => {
	const none = new SecretStore(null, "k");
	expect(none.get()).toBe(none.get());
	const throwing = new SecretStore(
		{
			getItem: () => {
				throw new Error("blocked");
			},
			setItem: () => {
				throw new Error("quota");
			},
		},
		"k",
	);
	const s = throwing.get();
	expect(isSecret(s)).toBe(true);
	expect(throwing.get()).toBe(s);
});
