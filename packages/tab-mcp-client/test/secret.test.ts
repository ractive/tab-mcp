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

const OLD = "tab-mcp:secret:https://relay.example";
const store = (storage: MemoryStorage, name: string) =>
	new SecretStore(storage, `${OLD}:${name}`, OLD);

test("the old shared key's secret is copied once: the first page keeps the address, the next gets its own, 0.4 pages keep theirs (DEC-083)", () => {
	const storage = new MemoryStorage();
	const old = newSecret();
	storage.setItem(OLD, old);
	expect(store(storage, "saturnus").get()).toBe(old);
	expect(storage.items.get(`${OLD}:saturnus`)).toBe(old);
	// Copied, not moved: a page still on 0.4 (or a rollback) reads it as before.
	expect(storage.items.get(OLD)).toBe(old);
	const second = store(storage, "todo").get();
	expect(second).not.toBe(old);
	// The first page keeps it on the next load.
	expect(store(storage, "saturnus").get()).toBe(old);
});

test("New address before the first connect marks the old secret taken, so no other page picks up the abandoned address", () => {
	const storage = new MemoryStorage();
	const old = newSecret();
	storage.setItem(OLD, old);
	const fresh = store(storage, "a").rotate();
	expect(fresh).not.toBe(old);
	expect(store(storage, "b").get()).not.toBe(old);
});

test("a secret that was read is kept even when writing the copy fails", () => {
	const storage = new MemoryStorage();
	const old = newSecret();
	storage.setItem(OLD, old);
	storage.setItem = () => {
		throw new Error("QuotaExceededError");
	};
	expect(store(storage, "page").get()).toBe(old);
});

test("TabMcp keys the secret by relay origin and the URI-encoded server name; an explicit storageKey is used as given", async () => {
	const relay = new StubRelay();
	try {
		const origin = new URL(relay.url).origin;
		const storage = new MemoryStorage();
		const a = newTab(relay.url, {
			storage,
			server: { name: "a:b#c", version: "1.0.0" },
		});
		await a.connect({ resume: true });
		a.disconnect();
		expect(
			isSecret(storage.items.get(`tab-mcp:secret:${origin}:a%3Ab%23c`)),
		).toBe(true);

		const own = new MemoryStorage();
		const shared = newSecret();
		own.setItem(`tab-mcp:secret:${origin}`, shared);
		const b = newTab(relay.url, { storage: own, storageKey: "mine" });
		await b.connect({ resume: true });
		b.disconnect();
		// No copy from the old default when the page names its key.
		expect(own.items.get("mine")).not.toBe(shared);
		expect(own.items.has(`tab-mcp:secret:${origin}#moved`)).toBe(false);
	} finally {
		await relay.stop();
	}
});
