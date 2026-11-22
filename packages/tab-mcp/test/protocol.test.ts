import { describe, expect, test } from "bun:test";
import { parseTabMessage } from "../src/protocol.ts";

const ok = (v: unknown) => parseTabMessage(JSON.stringify(v));

describe("parseTabMessage", () => {
	const hello = {
		type: "hello" as const,
		library: { name: "lib", version: "1" },
		app: { id: "my-app" },
		secret: "s",
	};

	test("hello", () => {
		expect(ok({ ...hello, page: { title: "T" }, extra: 1 })).toEqual({
			ok: true,
			message: hello,
		});
		// Only `id` and `name` of the app are kept.
		expect(
			ok({ ...hello, app: { id: "my-app", name: "My app", extra: 1 } }),
		).toEqual({
			ok: true,
			message: { ...hello, app: { id: "my-app", name: "My app" } },
		});
		expect(ok({ ...hello, revokeAll: true })).toEqual({
			ok: true,
			message: { ...hello, revokeAll: true },
		});
	});

	test("hello without library or secret is refused; page is not needed and never read (CC 6)", () => {
		const { library: _library, ...noLibrary } = hello;
		const { secret: _secret, ...noSecret } = hello;
		expect(ok(noLibrary).ok).toBe(false);
		expect(ok(noSecret).ok).toBe(false);
		expect(ok({ ...hello, page: 42 })).toEqual({ ok: true, message: hello });
	});

	test("hello.app.id is required: the <app> of the address, 1-32 of a-z, 0-9 and -, no - at either end (DEC-196)", () => {
		for (const id of [
			"a",
			"7",
			"ab",
			"my-app",
			"a--b",
			"0-0",
			"a".repeat(32),
			`a${"-".repeat(30)}b`,
		]) {
			expect(ok({ ...hello, app: { id } })).toEqual({
				ok: true,
				message: { ...hello, app: { id } },
			});
		}
		for (const id of [
			"",
			"-",
			"-a",
			"a-",
			"A",
			"My-App",
			"a_b",
			"a.b",
			"a b",
			"a/b",
			"a%2fb",
			"ä",
			"a\n",
			" a",
			"a".repeat(33),
			42,
			null,
			["a"],
			{ id: "a" },
		]) {
			expect(ok({ ...hello, app: { id } })).toEqual({
				ok: false,
				error: expect.stringContaining("hello.app.id"),
			});
		}
		// No app at all (libraries before 0.17), or only a name.
		const { app: _app, ...noApp } = hello;
		for (const message of [
			noApp,
			{ ...hello, app: {} },
			{ ...hello, app: { name: "My app" } },
			{ ...hello, app: "my-app" },
			{ ...hello, app: null },
			{ ...hello, app: ["my-app"] },
		]) {
			const r = ok(message);
			expect(r).toEqual({
				ok: false,
				error: expect.stringContaining("hello.app.id"),
			});
			// The text tells an old library's developer what to do.
			expect(r).toEqual({
				ok: false,
				error: expect.stringContaining("tab-mcp-client 0.17"),
			});
		}
	});

	test("hello.app.name is optional; when given it must be an app name (DEC-045)", () => {
		for (const name of ["x", "My app", "Größe ✓", "n".repeat(64)]) {
			expect(ok({ ...hello, app: { id: "my-app", name } })).toEqual({
				ok: true,
				message: { ...hello, app: { id: "my-app", name } },
			});
		}
		for (const name of [
			"",
			"   ",
			"n".repeat(65),
			"a\nb",
			"a\u0000",
			7,
			null,
		]) {
			expect(ok({ ...hello, app: { id: "my-app", name } })).toEqual({
				ok: false,
				error: expect.stringContaining("hello.app.name"),
			});
		}
	});

	test("not JSON, not an object, no type", () => {
		expect(parseTabMessage("{").ok).toBe(false);
		expect(parseTabMessage("[1]").ok).toBe(false);
		expect(ok({ id: "r1" }).ok).toBe(false);
	});

	test("http.response needs id, status, headers and body", () => {
		const good = {
			type: "http.response",
			id: "r1",
			status: 200,
			headers: { "content-type": "application/json" },
			body: "{}",
		};
		expect(ok(good).ok).toBe(true);
		expect(ok({ ...good, status: 99 })).toEqual({
			ok: false,
			error: "http.response.status invalid",
			id: "r1",
		});
		expect(ok({ ...good, headers: { "Content-Type": "x" } }).ok).toBe(false);
		expect(ok({ ...good, body: 1 }).ok).toBe(false);
		const { id: _, ...noId } = good;
		expect(ok(noId).ok).toBe(false);
	});

	test("streamed responses", () => {
		expect(
			ok({ type: "http.response.start", id: "r1", status: 200, headers: {} })
				.ok,
		).toBe(true);
		expect(ok({ type: "http.response.chunk", id: "r1", data: "x" }).ok).toBe(
			true,
		);
		expect(ok({ type: "http.response.chunk", id: "r1" }).ok).toBe(false);
		expect(ok({ type: "http.response.end", id: "r1" }).ok).toBe(true);
	});

	test("pong, bye, error", () => {
		expect(ok({ type: "pong", t: 5 })).toEqual({
			ok: true,
			message: { type: "pong", t: 5 },
		});
		expect(ok({ type: "pong" }).ok).toBe(false);
		expect(ok({ type: "bye" })).toEqual({
			ok: true,
			message: { type: "bye", reason: "" },
		});
		expect(ok({ type: "error", code: "x", message: "m", id: "r2" })).toEqual({
			ok: true,
			message: { type: "error", code: "x", message: "m", id: "r2" },
		});
	});

	test("identity and identity.logout (DEC-076, DEC-078)", () => {
		expect(ok({ type: "identity", assertion: "a.b.c" })).toEqual({
			ok: true,
			message: { type: "identity", assertion: "a.b.c" },
		});
		// The page's round number, echoed in the answer (review of PR #13).
		expect(ok({ type: "identity", assertion: "a.b.c", round: 7 })).toEqual({
			ok: true,
			message: { type: "identity", assertion: "a.b.c", round: 7 },
		});
		for (const round of [-1, 1.5, "7", 2 ** 53])
			expect(ok({ type: "identity", assertion: "a.b.c", round }).ok).toBe(
				false,
			);
		expect(ok({ type: "identity" }).ok).toBe(false);
		expect(ok({ type: "identity", assertion: "" }).ok).toBe(false);
		expect(ok({ type: "identity", assertion: "x".repeat(8193) }).ok).toBe(
			false,
		);
		expect(ok({ type: "identity.logout" })).toEqual({
			ok: true,
			message: { type: "identity.logout" },
		});
	});

	test("unknown types are reported with their id", () => {
		expect(ok({ type: "future.thing", id: "r3" })).toEqual({
			ok: true,
			unknown: true,
			type: "future.thing",
			id: "r3",
		});
		expect(ok({ type: "future.thing" })).toEqual({
			ok: true,
			unknown: true,
			type: "future.thing",
		});
	});
});
