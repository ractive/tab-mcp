/**
 * WebMCP on a click (DEC-223): when the worker gives a page the extension's
 * own WebMCP, and what the panel is told meanwhile (`worker/late-webmcp.ts`).
 */

import { expect, test } from "bun:test";
import type { PageTools } from "../src/messages.ts";
import {
	canTakeWebMCP,
	LateWebMCP,
	mayGiveLate,
} from "../src/worker/late-webmcp.ts";

const read = (
	documentId: string,
	available = false,
	origin = "https://shop.example",
): PageTools => ({
	url: `${origin}/`,
	origin,
	documentId,
	more: 0,
	available,
	tools: [],
});

function late(
	options: { may?: boolean; fails?: boolean; elsewhere?: boolean } = {},
) {
	const given: [number, string][] = [];
	let failed = 0;
	let may = options.may ?? true;
	const late = new LateWebMCP(
		async (tabId, documentId) => {
			given.push([tabId, documentId]);
			if (options.fails) throw new Error("no grant");
			return options.elsewhere !== true;
		},
		() => may,
		() => failed++,
	);
	return {
		late,
		given,
		failed: () => failed,
		allow: (value: boolean) => {
			may = value;
		},
	};
}

test("only while AI access is on and connected (the handshake's on)", () => {
	const state = { name: "x", apps: [], whileInFront: true as const };
	expect(mayGiveLate({ ...state, on: true })).toBe(true);
	expect(mayGiveLate({ ...state, on: false })).toBe(false);
});

test("given once per document, pending until a read after it settled", async () => {
	const { late: l, given } = late();
	expect(l.pending(1, undefined)).toBe(true);
	l.read(1, read("a"));
	l.read(1, read("a"));
	// To the page that was read: its content script's id goes with it.
	expect(given).toEqual([[1, "a"]]);
	expect(l.pending(1, "a")).toBe(true);
	await Bun.sleep(0);
	// Given, but not read since: still on its way for the panel.
	expect(l.pending(1, "a")).toBe(true);
	l.read(1, read("a"));
	expect(l.pending(1, "a")).toBe(false);
	expect(given).toEqual([[1, "a"]]);
	// A new document of the tab: given again.
	l.read(1, read("b"));
	expect(given).toEqual([
		[1, "a"],
		[1, "b"],
	]);
	expect(l.pending(1, "b")).toBe(true);
	expect(l.pending(1, "a")).toBe(true);
});

test("never to a page that has WebMCP, nor while AI access is off", () => {
	const { late: l, given, allow } = late();
	l.read(1, read("a", true));
	allow(false);
	l.read(2, read("b"));
	expect(given).toEqual([]);
	expect(l.pending(2, "b")).toBe(false);
	allow(true);
	l.read(2, read("b"));
	expect(given).toEqual([[2, "b"]]);
});

test("only to a page that can take it, a secure context; another is settled at once (review of PR 234)", () => {
	expect(canTakeWebMCP("https://shop.example")).toBe(true);
	for (const loopback of [
		"http://localhost:8080",
		"http://app.localhost",
		"http://127.0.0.1:3000",
		"http://[::1]:3000",
	])
		expect(canTakeWebMCP(loopback)).toBe(true);
	for (const insecure of [
		"http://shop.example",
		"http://192.168.1.2",
		"http://localhost.example",
		"null",
	])
		expect(canTakeWebMCP(insecure)).toBe(false);
	const { late: l, given } = late();
	l.read(1, read("a", false, "http://shop.example"));
	expect(given).toEqual([]);
	// The panel says at once that it has none.
	expect(l.pending(1, "a")).toBe(false);
});

test("a give that fails, or finds another page in the tab, settles at once and says so", async () => {
	for (const options of [{ fails: true }, { elsewhere: true }]) {
		const { late: l, failed } = late(options);
		l.read(1, read("a"));
		await Bun.sleep(0);
		expect(failed()).toBe(1);
		expect(l.pending(1, "a")).toBe(false);
	}
});

test("a closed tab is forgotten", async () => {
	const { late: l, given } = late();
	l.read(1, read("a"));
	l.closed(1);
	l.read(1, read("a"));
	expect(given).toEqual([
		[1, "a"],
		[1, "a"],
	]);
});
