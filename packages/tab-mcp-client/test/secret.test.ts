import { expect, test } from "bun:test";
import { addressIdFromSecret } from "@ractive-ch/tab-mcp";
import { base64url, isSecret, newSecret, SecretStore } from "../src/secret.ts";
import { MemoryStorage, newTab } from "./helpers.ts";
import { StubRelay } from "./stub-relay.ts";

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

test("a secret under the old shared key is moved once: the first page keeps the address, the next gets its own (DEC-083)", () => {
	const storage = new MemoryStorage();
	const old = newSecret();
	storage.setItem("tab-mcp:secret:https://relay.example", old);
	const first = new SecretStore(
		storage,
		"tab-mcp:secret:https://relay.example:saturnus",
		"tab-mcp:secret:https://relay.example",
	).get();
	expect(first).toBe(old);
	expect(
		storage.items.get("tab-mcp:secret:https://relay.example:saturnus"),
	).toBe(old);
	expect(storage.items.has("tab-mcp:secret:https://relay.example")).toBe(false);
	const second = new SecretStore(
		storage,
		"tab-mcp:secret:https://relay.example:todo",
		"tab-mcp:secret:https://relay.example",
	).get();
	expect(second).not.toBe(old);
	// The first page keeps it on the next load.
	expect(
		new SecretStore(
			storage,
			"tab-mcp:secret:https://relay.example:saturnus",
			"tab-mcp:secret:https://relay.example",
		).get(),
	).toBe(old);
});

test("storage without removeItem still moves the secret (the old key just stays)", () => {
	const items = new Map<string, string>();
	const storage = {
		getItem: (k: string) => items.get(k) ?? null,
		setItem: (k: string, v: string) => void items.set(k, v),
	};
	const old = newSecret();
	items.set("old", old);
	expect(new SecretStore(storage, "new", "old").get()).toBe(old);
	expect(items.get("new")).toBe(old);
});

test("TabMcp keys the secret by relay origin and server name; an explicit storageKey is used as given", async () => {
	const relay = new StubRelay();
	try {
		const storage = new MemoryStorage();
		const a = newTab(relay.url, { storage });
		await a.connect({ resume: true });
		a.disconnect();
		const origin = new URL(relay.url).origin;
		expect([...storage.items.keys()]).toEqual([
			`tab-mcp:secret:${origin}:test-page`,
		]);

		const own = new MemoryStorage();
		own.setItem(`tab-mcp:secret:${origin}`, newSecret());
		const b = newTab(relay.url, { storage: own, storageKey: "mine" });
		await b.connect({ resume: true });
		b.disconnect();
		// No move from the old default when the page names its key.
		expect(own.items.has(`tab-mcp:secret:${origin}`)).toBe(true);
		expect(isSecret(own.items.get("mine"))).toBe(true);
	} finally {
		await relay.stop();
	}
});
