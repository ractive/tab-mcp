/**
 * The sign-in's own parts (`worker/signin.ts`, DEC-233), without a
 * connection: what it reads of the relay's messages, its words, where calls
 * go from the group's record, and the announcement of a browser that joined,
 * also one that joined while this browser was off. connection.test.ts runs
 * the whole flow through the worker's connection.
 */

import { describe, expect, test } from "bun:test";
import { memoryKv } from "../src/worker/kv.ts";
import {
	ADMIN_APPROVAL,
	browserName,
	failedText,
	osName,
	parseGroup,
	parseSessionSignIn,
	redirectErrorText,
	SignIn,
	type SignInHost,
	settingOf,
} from "../src/worker/signin.ts";

const SELF = "m_self000000000000";
const B = "m_bbbbbbbbbbbbbbbb";
const C = "m_cccccccccccccccc";

describe("what it reads of the relay's messages", () => {
	test("session.signIn: the providers, this browser's member id; anything else left out", () => {
		expect(
			parseSessionSignIn({
				providers: [
					{ id: "google", name: "Google" },
					{ id: "bad id", name: "x" },
					{ id: "github" },
				],
				member: SELF,
			}),
		).toEqual({ providers: [{ id: "google", name: "Google" }], member: SELF });
		expect(parseSessionSignIn({ providers: [] })).toEqual({ providers: [] });
		expect(parseSessionSignIn(undefined)).toBeUndefined();
		expect(parseSessionSignIn({ member: SELF })).toBeUndefined();
	});

	test("group: members, mode, pin and focus checked; a pin only in mode pinned, a focus only in front; labels cut and cleaned", () => {
		const record = parseGroup({
			type: "group",
			self: SELF,
			maxMembers: 16,
			members: [
				{ id: SELF, label: "Chrome on macOS", online: true },
				{ id: B, label: "work‮Chrome", online: false },
				{ id: C, label: 3, online: true },
			],
			mode: "pinned",
			pin: { member: B, tab: "42" },
			focus: B,
			grants: [
				{
					grantId: "g_1",
					client: { id: "https://x", name: "Claude", host: "claude.ai" },
				},
				{ grantId: "g_2" },
			],
		});
		expect(record).toEqual({
			self: SELF,
			maxMembers: 16,
			members: [
				{ id: SELF, label: "Chrome on macOS", online: true },
				{ id: B, label: "workChrome", online: false },
			],
			mode: "pinned",
			pin: { member: B, tab: "42" },
			grants: [{ grantId: "g_1", name: "Claude", host: "claude.ai" }],
		});
		expect(
			parseGroup({
				self: SELF,
				members: [],
				mode: "front",
				pin: { member: B, tab: "1" },
				focus: B,
			}),
		).toMatchObject({ mode: "front", focus: B });
		expect(
			parseGroup({
				self: SELF,
				members: [],
				mode: "pinned",
				pin: { member: B, tab: "x1" },
			})?.pin,
		).toBeUndefined();
		// An unknown mode is the relay's default.
		expect(parseGroup({ self: SELF, members: [], mode: "?" })?.mode).toBe(
			"front",
		);
		expect(parseGroup({ members: [] })).toBeUndefined();
	});

	test("where calls go, from the group's record", () => {
		expect(settingOf(undefined)).toEqual({ mode: "front" });
		const base = { self: SELF, members: [], maxMembers: 16, grants: [] };
		expect(settingOf({ ...base, mode: "front", focus: B })).toEqual({
			mode: "front",
		});
		expect(settingOf({ ...base, mode: "pinned" })).toEqual({ mode: "pinned" });
		expect(
			settingOf({ ...base, mode: "pinned", pin: { member: SELF, tab: "7" } }),
		).toEqual({ mode: "pinned", pin: 7 });
		expect(
			settingOf({ ...base, mode: "pinned", pin: { member: B, tab: "7" } }),
		).toEqual({ mode: "pinned", elsewhere: true });
	});
});

describe("its words", () => {
	const microsoft = { id: "microsoft", name: "Microsoft" };
	const github = { id: "github", name: "GitHub" };
	test("a Microsoft sign-in its organisation has to approve says so, not the code", () => {
		for (const description of [
			"AADSTS65001: The user or administrator has not consented",
			"AADSTS90094: Admin consent is required",
			"AADSTS90095: Admin consent is required",
		]) {
			const text = redirectErrorText(
				"provider_error",
				microsoft,
				new URLSearchParams({
					signin_error: "provider_error",
					error_description: description,
				}),
			);
			expect(text).toBe(ADMIN_APPROVAL);
			expect(text).not.toContain("AADSTS");
		}
		expect(
			redirectErrorText("admin_approval", microsoft, new URLSearchParams()),
		).toBe(ADMIN_APPROVAL);
		// Without the provider's word, that it may be the reason.
		expect(
			redirectErrorText("provider_error", microsoft, new URLSearchParams()),
		).toContain("may have to approve tab-mcp relay first");
		expect(
			redirectErrorText("provider_error", github, new URLSearchParams()),
		).toBe("GitHub did not sign you in: cancelled or refused.");
		expect(
			redirectErrorText("session_gone", github, new URLSearchParams()),
		).toBe(
			"The connection to the relay was renewed during the sign-in. Sign in again.",
		);
	});

	test("every refusal of the relay in a sentence of its own, none with the relay's code", () => {
		const reasons = [
			"not_offered",
			"bad_redirect",
			"rate_limited",
			"busy",
			"provider_unavailable",
			"code_refused",
			"group_full",
			"store_unavailable",
			"something_new",
		];
		const texts = reasons.map((r) => failedText(r, "Google"));
		expect(new Set(texts).size).toBe(reasons.length);
		for (const t of texts) expect(t).not.toContain("_");
	});

	test("a member's default label: the browser on the system", () => {
		expect(
			`${browserName(false, "Mozilla/5.0 Chrome/150.0")} on ${osName("mac")}`,
		).toBe("Chrome on macOS");
		expect(browserName(false, "Mozilla/5.0 Chrome/150.0 Edg/150.0")).toBe(
			"Edge",
		);
		expect(browserName(true, "")).toBe("Firefox");
		expect(osName("win")).toBe("Windows");
		expect(osName("linux")).toBe("Linux");
	});
});

describe("a browser that joined the group", () => {
	function host() {
		const sent: Record<string, unknown>[] = [];
		const notified: { title: string; message: string }[] = [];
		const h: SignInHost = {
			send: (m) => {
				sent.push(m);
				return true;
			},
			auth: {
				redirectUrl: () => "https://x.chromiumapp.org/",
				launch: async () => undefined,
			},
			label: async () => "Chrome on macOS",
			relayOrigin: () => "https://relay.example",
			notify: (_id, title, message) => void notified.push({ title, message }),
			changed: () => {},
			targetsChanged: () => {},
			targetShown: () => {},
			focusedHere: async () => false,
		};
		return { h, sent, notified };
	}
	const group = (members: string[]) => ({
		type: "group",
		self: SELF,
		members: members.map((id) => ({
			id,
			label: id === SELF ? "here" : `browser ${id.slice(2, 3)}`,
			online: true,
		})),
		mode: "front",
		grants: [],
	});
	const settle = () => Bun.sleep(5);

	test("announced once, also after the worker restarted; one that left and comes back is announced again", async () => {
		const kv = memoryKv();
		const first = host();
		const signIn = new SignIn(kv, first.h, await SignIn.stored(kv));
		signIn.receive({
			type: "session",
			signIn: { providers: [], member: SELF },
		});
		signIn.receive(group([SELF, B]));
		await settle();
		// The members there when it signed in (or first saw the group) are not news.
		expect(signIn.view()?.notice).toBeUndefined();
		expect(first.notified).toEqual([]);
		// A new worker (the browser restarted): C joined meanwhile.
		const second = host();
		const again = new SignIn(kv, second.h, await SignIn.stored(kv));
		again.receive({ type: "session", signIn: { providers: [], member: SELF } });
		again.receive(group([SELF, B, C]));
		await settle();
		expect(again.view()?.notice).toBe(
			"“browser c” signed in with your account and joined your browsers. If you did not sign it in, remove it below.",
		);
		expect(second.notified).toEqual([
			{
				title: "A browser joined your browsers",
				message:
					"“browser c” signed in with your account. If you did not sign it in, remove it in the tab-mcp panel.",
			},
		]);
		again.receive(group([SELF, B, C]));
		await settle();
		expect(second.notified.length).toBe(1);
		// C was removed, then signed in again.
		again.receive(group([SELF, B]));
		again.receive(group([SELF, B, C]));
		await settle();
		expect(second.notified.length).toBe(2);
	});

	test("a group of another member id than the session's is not this browser's", async () => {
		const kv = memoryKv();
		const { h, notified } = host();
		const signIn = new SignIn(kv, h);
		signIn.receive({
			type: "session",
			signIn: { providers: [], member: SELF },
		});
		signIn.receive({ ...group([B, C]), self: B });
		await settle();
		expect(signIn.group).toBeUndefined();
		expect(notified).toEqual([]);
	});
});
