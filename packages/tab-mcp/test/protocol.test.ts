import { describe, expect, test } from "bun:test";
import { parseTabMessage } from "../src/protocol.ts";

const ok = (v: unknown) => parseTabMessage(JSON.stringify(v));

describe("parseTabMessage", () => {
	test("hello", () => {
		const r = ok({
			type: "hello",
			library: { name: "lib", version: "1" },
			page: { title: "T" },
			secret: "s",
			extra: 1,
		});
		expect(r).toEqual({
			ok: true,
			message: {
				type: "hello",
				library: { name: "lib", version: "1" },
				page: { title: "T" },
				secret: "s",
			},
		});
	});

	test("hello without library, page or secret is refused", () => {
		expect(ok({ type: "hello", page: { title: "" }, secret: "s" }).ok).toBe(
			false,
		);
		expect(
			ok({ type: "hello", library: { name: "l", version: "1" }, secret: "s" })
				.ok,
		).toBe(false);
		expect(
			ok({
				type: "hello",
				library: { name: "l", version: "1" },
				page: { title: "" },
			}).ok,
		).toBe(false);
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
