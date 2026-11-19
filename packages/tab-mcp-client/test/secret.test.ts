import { expect, spyOn, test } from "bun:test";
import { addressIdOf } from "../src/address.ts";
import { base64url, isSecret, newSecret, SecretStore } from "../src/secret.ts";
import { MemoryStorage, newTab } from "./helpers.ts";
import { StubRelay } from "./stub-relay.ts";

/** What a connection uses: the current secret, else a new one. */
const got = (store: SecretStore): string => store.current() ?? store.rotate();

test("current() makes no secret", () => {
	const storage = new MemoryStorage();
	const store = new SecretStore(storage, "k");
	expect(store.current()).toBeUndefined();
	expect(storage.items.size).toBe(0);
	const made = store.rotate();
	expect(store.current()).toBe(made);
});

test("base64url matches the platform encoder", () => {
	for (const n of [0, 1, 2, 3, 31, 32, 33]) {
		const bytes = crypto.getRandomValues(new Uint8Array(n));
		expect(base64url(bytes)).toBe(
			bytes.toBase64({ alphabet: "base64url", omitPadding: true }),
		);
	}
});

test("a secret is 43 base64url characters and gives a 52-character address id", async () => {
	const secret = newSecret();
	expect(isSecret(secret)).toBe(true);
	expect(await addressIdOf(secret)).toMatch(/^[a-z2-7]{52}$/);
});

test("the secret is kept in storage and stable", () => {
	const storage = new MemoryStorage();
	const a = got(new SecretStore(storage, "k"));
	expect(storage.items.get("k")).toBe(a);
	expect(got(new SecretStore(storage, "k"))).toBe(a);
});

test("an invalid stored value is replaced", () => {
	const storage = new MemoryStorage();
	storage.setItem("k", "too-short");
	const s = got(new SecretStore(storage, "k"));
	expect(isSecret(s)).toBe(true);
	expect(storage.items.get("k")).toBe(s);
});

test("rotate makes a new secret; another store on the same storage sees it", () => {
	const storage = new MemoryStorage();
	const a = new SecretStore(storage, "k");
	const b = new SecretStore(storage, "k");
	const first = got(a);
	expect(got(b)).toBe(first);
	const second = a.rotate();
	expect(second).not.toBe(first);
	expect(got(b)).toBe(second);
});

test("without storage, or with storage that throws, the secret lives as long as the page", () => {
	const none = new SecretStore(null, "k");
	expect(got(none)).toBe(got(none));
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
	const s = got(throwing);
	expect(isSecret(s)).toBe(true);
	expect(got(throwing)).toBe(s);
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
		const b = newTab(relay.url, { storage: own, storageKey: "mine" });
		await b.connect({ resume: true });
		b.disconnect();
		expect(isSecret(own.items.get("mine"))).toBe(true);
		expect(own.items.size).toBe(1);
	} finally {
		await relay.stop();
	}
});

test("a secret under the key of client 0.4 and older is not read: that page pairs again (DEC-083, DEC-178)", async () => {
	const relay = new StubRelay();
	try {
		const origin = new URL(relay.url).origin;
		const storage = new MemoryStorage();
		const old = newSecret();
		storage.setItem(`tab-mcp:secret:${origin}`, old);
		const t = newTab(relay.url, { storage });
		await t.connect({ resume: true });
		const hello = await relay.next("hello");
		t.disconnect();
		expect(hello["secret"]).not.toBe(old);
		// The old key is left alone and nothing marks it taken.
		expect(storage.items.get(`tab-mcp:secret:${origin}`)).toBe(old);
		expect(storage.items.has(`tab-mcp:secret:${origin}#moved`)).toBe(false);
	} finally {
		await relay.stop();
	}
});

// What the tabs of one page tell each other by (DEC-095): the library's own
// id of a secret. Not compared with the relay's id of a session, which no
// part of the library needs to know.
test("addressIdOf is base32(sha256(secret)), lower case without padding, computed with Web Crypto", async () => {
	expect(await addressIdOf("A".repeat(43))).toBe(
		"b4ahhbnw7hklp3vsosdall7bvgckbi57upybjue6fj4ez2pfzuna",
	);
	const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
	for (let i = 0; i < 20; i++) {
		const secret = newSecret();
		let bits = "";
		for (const byte of new Bun.CryptoHasher("sha256").update(secret).digest())
			bits += byte.toString(2).padStart(8, "0");
		let id = "";
		for (let at = 0; at < bits.length; at += 5)
			id += alphabet[Number.parseInt(bits.slice(at, at + 5).padEnd(5, "0"), 2)];
		expect(await addressIdOf(secret)).toBe(id);
	}
});

test("addressIdOf is undefined without Web Crypto (an insecure context) or when it fails", async () => {
	const secret = newSecret();
	expect(await addressIdOf(secret, null)).toBeUndefined();
	const broken = {
		digest: () => Promise.reject(new Error("NotSupportedError")),
	} as unknown as SubtleCrypto;
	expect(await addressIdOf(secret, broken)).toBeUndefined();
});

test("the /tab URL has no query: no URL the library opens has the secret, its address id or the app in it (DEC-196)", async () => {
	const relay = new StubRelay();
	// Every socket the library opens, as it asked for it.
	const Real = globalThis.WebSocket;
	const opened: { url: string; protocols: unknown }[] = [];
	globalThis.WebSocket = class extends Real {
		constructor(url: string | URL, protocols?: string | string[]) {
			opened.push({ url: String(url), protocols });
			super(url, protocols);
		}
	} as typeof WebSocket;
	const fetched = spyOn(globalThis, "fetch");
	try {
		const t = newTab(relay.url, { app: "calc-2", appName: "Calc" });
		await t.connect();
		const first = String((await relay.next("hello"))["secret"]);
		// "Disconnect all apps": one connection with the old secret, one with the new.
		await t.newAddress();
		expect(await relay.next("hello")).toMatchObject({
			secret: first,
			revokeAll: true,
		});
		const second = String((await relay.next("hello"))["secret"]);
		expect(second).not.toBe(first);
		t.disconnect();

		const tab = `${relay.url.replace("http", "ws")}/tab`;
		expect(opened).toEqual([
			{ url: tab, protocols: "tab-mcp.v1" },
			{ url: tab, protocols: "tab-mcp.v1" },
			{ url: tab, protocols: "tab-mcp.v1" },
		]);
		expect(relay.urls).toHaveLength(3);
		for (const href of relay.urls) {
			const url = new URL(href);
			expect(url.pathname).toBe("/tab");
			expect(url.search).toBe("");
			for (const secret of [first, second]) {
				expect(href).not.toContain(secret);
				expect(href).not.toContain((await addressIdOf(secret)) as string);
			}
			expect(href).not.toContain("calc-2");
		}
		// Nothing but the socket: the library fetches nothing.
		expect(fetched).not.toHaveBeenCalled();
	} finally {
		fetched.mockRestore();
		globalThis.WebSocket = Real;
		await relay.stop();
	}
});

test("a tab tells its sibling tabs of its claim by the address id of its secret, never the secret; after newAddress() by the new one's", async () => {
	const relay = new StubRelay();
	const origin = new URL(relay.url).origin;
	const channel = new BroadcastChannel(
		`tab-mcp:secret:${origin}:test-page#tabs`,
	);
	const heard: unknown[] = [];
	let wake = () => {};
	channel.onmessage = (e) => {
		heard.push(e.data);
		wake();
	};
	const count = async (n: number) => {
		while (heard.length < n) {
			await new Promise<void>((resolve) => {
				wake = resolve;
			});
		}
	};
	try {
		const t = newTab(relay.url);
		const { address } = await t.connect();
		const first = String((await relay.next("hello"))["secret"]);
		await count(1);
		const firstId = (await addressIdOf(first)) as string;
		expect(firstId).toMatch(/^[a-z2-7]{52}$/);
		expect(heard).toEqual([{ type: "claimed", address: firstId }]);
		await t.newAddress();
		await relay.next("hello");
		const second = String((await relay.next("hello"))["secret"]);
		// The address the AI apps have is the same; what the tabs go by is new.
		expect(t.session?.address).toBe(address);
		await count(3);
		const secondId = (await addressIdOf(second)) as string;
		expect(heard.slice(1)).toEqual([
			{ type: "claimed", address: firstId },
			{ type: "claimed", address: secondId },
		]);
		expect(secondId).not.toBe(firstId);
		expect(JSON.stringify(heard)).not.toContain(first);
		expect(JSON.stringify(heard)).not.toContain(second);
		t.disconnect();
	} finally {
		channel.close();
		await relay.stop();
	}
});
