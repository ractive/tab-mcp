/**
 * The connection to the user's AI app, in the service worker (DEC-116): the
 * library's `TabMcp` with the extension's tools and the bridge to the page in
 * front, the questions of tools that ask first, and the state the side panels
 * show, and what pages with the client library are told (DEC-207). A
 * WebSocket that carries messages keeps the worker alive (Chrome 116),
 * and the relay's heartbeat (a ping every 25 s, answered) carries some even
 * when nothing else happens; the worker connects again whenever it starts
 * while the user left AI access on.
 */

import {
	type ConfirmRequest,
	type Icon,
	type ModelContextTool,
	type ReplacedDetail,
	TabMcp,
} from "@ractive-ch/tab-mcp-client";
import {
	CodeFiller,
	type FillAnswer,
	type FillContext,
	type FillHost,
	type PagePort,
	relayPageOrigin,
} from "@ractive-ch/tab-mcp-client/extension";
import {
	FIREFOX,
	notificationOptions,
	openPanel,
	PANEL,
	PRODUCT,
	questionNotification,
} from "../browser.ts";
import { alwaysAllowable, fillAccess } from "../fill.ts";
import { BADGE_LOOK } from "../look.ts";
import type { ContentRequest, ExtensionState } from "../messages.ts";
import {
	APP_ID,
	type CallView,
	type GrantView,
	type PanelCommand,
	type PanelState,
	parseCommand,
	SERVER_NAME,
	type TabView,
	type TargetView,
	type WorkerMessage,
} from "../protocol.ts";
import { relayProblem } from "../relay.ts";
import {
	ALL_SITES,
	askHistory,
	askPage,
	askTools,
	callInTab,
	getTab,
	giveWebMCP,
	isSitePage,
	NoAccessError,
	normalTabs,
	type TargetTab,
	tabInFront,
	tabInNormalWindow,
} from "../tabs.ts";
import {
	type AllowedTools,
	allowable,
	isAllowed,
	loadAllowed,
	setAllowed,
	setAllowedMany,
} from "./allowed.ts";
import { type BridgeState, type LookedUp, PageToolBridge } from "./bridge.ts";
import { RunningCalls } from "./calls.ts";
import { decide } from "./decide.ts";
import {
	codeWithPairingOn,
	FILLED_PREFIX,
	FillSetting,
	failureText,
	filledNotification,
	filledText,
	HOLD_MS,
	NOTICE_MS,
	pairingAnswer,
	syncPairingScript,
	UnaskedFills,
} from "./fill.ts";
import { type Kv, openKv } from "./kv.ts";
import { LateWebMCP, mayGiveLate } from "./late-webmcp.ts";
import { goInTab, navigationTools, settledPage } from "./navigation.ts";
import { notificationApi } from "./notifications.ts";
import { argsToSend, Questions, type QuestionsHost } from "./questions.ts";
import { RecentCalls } from "./recent.ts";
import { CachedSecretStorage } from "./secret.ts";
import {
	loadAiOn,
	loadGrants,
	loadRelay,
	loadReplaced,
	type Replaced,
	saveAiOn,
	saveGrants,
	saveRelay,
	saveReplaced,
} from "./settings.ts";
import { tabTools } from "./tab-tools.ts";
import { chromeSession, kvTargetStore, Targets } from "./targets.ts";
import { createTools, INSTRUCTIONS, tabOf } from "./tools.ts";

/** What a Disconnect while not connected says (it did nothing). */
export const DISCONNECT_WHILE_DOWN =
	"The AI app was not disconnected: AI access has to be on and connected first.";

/** Wakes the worker while AI access is on, should the connection be down. */
export const ALARM = "tab-mcp-keepup";

/** One open side panel. */
interface Panel {
	port: chrome.runtime.Port;
	windowId?: number;
	/** Its pairing view is open. */
	pairing: boolean;
	/** On screen, as it last said (covered by another extension's panel: not). */
	visible: boolean;
	/** The questions whose arguments it got (they are sent once). */
	argsSent: Set<string>;
	/** Its "Recent calls" is open: it gets the calls' changes (DEC-226). */
	calls: boolean;
}

/** The extension's icon for the AI app's connector list (a PNG `data:` URI). */
async function iconsFor(): Promise<Icon[]> {
	try {
		const bytes = new Uint8Array(
			await (
				await fetch(chrome.runtime.getURL("icons/icon-128.png"))
			).arrayBuffer(),
		);
		let binary = "";
		for (const byte of bytes) binary += String.fromCharCode(byte);
		return [
			{
				src: `data:image/png;base64,${btoa(binary)}`,
				mimeType: "image/png",
				sizes: ["128x128"],
			},
		];
	} catch {
		return [];
	}
}

/** Clear every notification of the extension. */
async function clearNotifications(): Promise<void> {
	try {
		const all = await notificationApi().getAll();
		await Promise.all(
			Object.keys(all).map((id) => notificationApi().clear(id)),
		);
	} catch {
		// None to clear, or notifications not available.
	}
}

const message = (error: unknown) =>
	error instanceof Error ? error.message : String(error);

/** What the panel's status is made from. */
export interface StatusInput {
	state: TabMcp["state"];
	grants: number;
	/** The user left AI access on. */
	aiOn: boolean;
	/** The address was taken over: nothing connects by itself. */
	replaced: boolean;
}

/**
 * The status the panel shows. Down while the user left AI access on (and the
 * address was not taken over) is "retrying", not "off": the alarm connects
 * again every minute, also after a first connect that failed, which the
 * library does not retry itself (EQ 3).
 */
export function panelStatus(s: StatusInput): PanelState["status"] {
	if (s.state === "connected") return s.grants > 0 ? "on" : "waiting";
	if (s.state === "connecting") return "connecting";
	if (s.state === "reconnecting" || (s.aiOn && !s.replaced)) return "retrying";
	return "off";
}

/**
 * A navigation tool whose call "Recent calls" names with the site of the
 * tab it acts on as it starts (DEC-226).
 */
function withSite(
	tool: ModelContextTool,
	recent: RecentCalls,
	targets: Targets,
): ModelContextTool {
	return {
		...tool,
		execute: (input, options) => {
			void targets
				.peek(tabOf(input))
				.then((tab) => {
					const { origin } = new URL(tab.url);
					if (origin !== "null") recent.note(options.signal, { site: origin });
				})
				.catch(() => {});
			return tool.execute(input, options);
		},
	};
}

export class Connection {
	readonly #storage: CachedSecretStorage;
	readonly #icons: Icon[];
	readonly #questions: Questions;
	/** The relay's pairing pages in this browser (DEC-203). */
	readonly #filler: CodeFiller;
	/** Pairing is held on for a code just filled in, until this fires. */
	#fillHold: ReturnType<typeof setTimeout> | undefined;
	/** The pairing page's script registrations, one after the other. */
	#scriptSync: Promise<void> = Promise.resolve();
	/** "Fill in the code for me" (DEC-203, DEC-210). */
	readonly #fill: FillSetting;
	/** The panel's last "set-fill" the worker has handled, by its id. */
	#fillAnswered: string | undefined;
	/** Pages let through without a question, until their code comes (DEC-213). */
	readonly #unasked = new UnaskedFills();
	/** Tabs whose fill Remove withdrew: its "no code" is no problem. */
	readonly #quietFails = new Set<number>();
	/** The last fill without a question (DEC-213), for the panel's line. */
	#fillNotice: { text: string; at: number } | undefined;
	readonly #panels = new Set<Panel>();
	#allowed: AllowedTools;
	#relay: string;
	#mcp: TabMcp;
	#bridge: PageToolBridge;
	#listening = new AbortController();
	/**
	 * The AI apps' calls running now (DEC-225): only the panels hear when
	 * none or some run; the badge and the pages do not change with it.
	 */
	readonly #calls = new RunningCalls(() => this.#tellPanels());
	/**
	 * "Recent calls" (DEC-226), in memory only: each change goes to the
	 * panels that have it open; the state carries only the count.
	 */
	readonly #recent = new RecentCalls(
		(call, added) => this.#callChanged(call, added),
		{
			nameOf: (grantId) =>
				this.#grants.find((g) => g.grantId === grantId)?.name,
		},
	);
	/** The count the panels were last told. */
	#recentSent = 0;
	#problem: string | undefined;
	readonly #kv: Kv;
	/** Taken over (kept in storage too, so it holds across worker restarts). */
	#replaced: Replaced | undefined;
	/** The takeover happened in this worker's life: the library knows of it. */
	#replacedHere = false;
	/** Panel commands, one after the other. */
	#commands: Promise<void> = Promise.resolve();
	#allSites = false;
	#tab: TabView | undefined;
	/**
	 * The tools of the tab the panels show, as `#tab` lists them: the
	 * bridge's state, or a read of their own where calls go to another tab
	 * (a pinned one).
	 */
	#tabTools: BridgeState | undefined;
	#target: TargetView | undefined;
	#tabRead = 0;
	/** Where calls go: the tab in front or a pinned tab (DEC-230). */
	readonly #targets: Targets;
	/** WebMCP given late, where a page read has none (DEC-223). */
	readonly #late = new LateWebMCP(
		giveWebMCP,
		() => mayGiveLate(this.handshakeState()),
		() => void this.#readTab(),
	);
	#sending = false;
	/** What pages with the client library were told last, as JSON (DEC-207). */
	#told = "";
	/** AI access is on, as last saved. */
	#aiOn: boolean;
	/**
	 * The paired apps as the relay last listed them, kept in storage: a new
	 * worker's library knows of none until it is connected (EQ 8).
	 */
	#grants: GrantView[];

	private constructor(
		storage: CachedSecretStorage,
		icons: Icon[],
		allowed: AllowedTools,
		relay: string,
		replaced: Replaced | undefined,
		kv: Kv,
		aiOn: boolean,
		grants: GrantView[],
		fill: FillSetting,
	) {
		this.#kv = kv;
		this.#fill = fill;
		this.#aiOn = aiOn;
		this.#grants = grants;
		this.#storage = storage;
		this.#icons = icons;
		this.#allowed = allowed;
		this.#relay = relay;
		this.#replaced = replaced;
		this.#questions = new Questions(this.#questionsHost());
		// A change of the mode or the pin: the bridge offers the tools of the
		// tab calls go to now, and the panels show it.
		this.#targets = new Targets(
			kvTargetStore(kv, chromeSession()),
			{
				front: tabInFront,
				tab: tabInNormalWindow,
				// The rule of use_tab: page_info would answer.
				mayPin: (tab) =>
					askPage(tab).then(
						() => true,
						() => false,
					),
			},
			() => {
				this.tabChanged();
				void this.#readTab();
			},
		);
		this.#filler = new CodeFiller(this.#fillHost(), {
			grants: grants.map((g) => g.grantId),
		});
		[this.#mcp, this.#bridge] = this.#create(relay);
		this.#watch(this.#mcp);
	}

	/**
	 * The connection, connected again if the user left AI access on and the
	 * address was not taken over meanwhile.
	 */
	static async start(): Promise<Connection> {
		// The settings live in IndexedDB, out of content scripts' reach; the
		// extension has no `storage` permission (no chrome.storage at all).
		const kv = await openKv();
		// A previous worker's questions died with it: their notifications
		// would answer nothing.
		await clearNotifications();
		const [storage, icons, allowed, relay, on, replaced, grants, fill] =
			await Promise.all([
				CachedSecretStorage.load(kv),
				iconsFor(),
				loadAllowed(kv),
				loadRelay(kv),
				loadAiOn(kv),
				loadReplaced(kv),
				loadGrants(kv),
				FillSetting.load(kv),
			]);
		const connection = new Connection(
			storage,
			icons,
			allowed,
			relay,
			replaced,
			kv,
			on,
			grants,
			fill,
		);
		connection.#showBadge();
		connection.syncFill();
		// The alarm too, not only once connected: after an update (which
		// clears alarms) with the relay out of reach, the first connect fails
		// and the library does not retry it; the alarm does (EQ 14).
		if (on) await chrome.alarms.create(ALARM, { periodInMinutes: 1 });
		if (on && replaced === undefined) connection.#connect();
		return connection;
	}

	// --- The library's connection and the bridge ---

	#create(relay: string): [TabMcp, PageToolBridge] {
		const mcp: TabMcp = new TabMcp({
			relay,
			server: {
				name: SERVER_NAME,
				title: PRODUCT,
				version: chrome.runtime.getManifest().version,
				instructions: INSTRUCTIONS,
				icons: this.#icons,
			},
			app: APP_ID,
			appName: PRODUCT,
			storage: this.#storage,
			// No tool of the extension is consequential: the page tools ask in
			// the bridge, the navigation tools themselves (DEC-141).
			onConfirm: () => false,
			// Never into WebMCP (on by default, DEC-222): Firefox's event page
			// has a document, which gets `modelContext` once Firefox turns
			// WebMCP on, and the extension's tools are for its AI apps only.
			webmcp: false,
		});
		// Every tool of the extension's, the page's too, binds its call for
		// "Recent calls" as it runs (DEC-226).
		const recent = this.#recent;
		const targets = this.#targets;
		const bridge = new PageToolBridge(
			{
				registerTool: (tool, options) =>
					mcp.registerTool(recent.wrap(tool), options),
			},
			{
				// The tab calls go to: the tab in front, or the pinned tab.
				current: () => targets.peek(),
				// A page without WebMCP gets the extension's own now, where it
				// may (DEC-223); its toolchange then has it read again.
				list: async (tab) => {
					const tools = await askTools(tab);
					this.#late.read(tab.id, tools);
					return tools;
				},
				// With a vouch, the state too: the page may not have it yet.
				call: (tabId, target, input, signal, vouch) =>
					callInTab(
						tabId,
						target,
						input,
						signal,
						vouch,
						vouch === undefined ? undefined : this.handshakeState(),
					),
				settled: (tabId, signal) =>
					settledPage({ tab: getTab, page: askPage }, tabId, signal),
			},
			{
				changed: () => void this.#readTab(),
				confirm: (request, tool) => this.#decide(request, tool),
				note: (signal, fact) => recent.note(signal, fact),
				callIn: (tabId) => targets.callIn(tabId),
			},
		);
		for (const tool of createTools(
			{ current: (tab) => targets.forCall(tab), page: askPage },
			() => bridge,
		))
			void mcp.registerTool(recent.wrap(tool));
		// The tabs an AI app may use, and pinning one (DEC-230).
		for (const tool of tabTools(
			targets,
			{ tabs: normalTabs, front: tabInFront, page: askPage },
			() => bridge.refresh(),
		))
			void mcp.registerTool(recent.wrap(tool));
		// Navigation (iteration 27, DEC-121): to another origin it asks
		// through the same questions, never "allowed".
		for (const tool of navigationTools(
			{
				target: (tab) => targets.forCall(tab),
				current: (tab) => targets.peek(tab),
				tab: getTab,
				page: askPage,
				history: askHistory,
				go: goInTab,
			},
			(request, where) => this.#ask(request, where),
			() => bridge.refresh(),
		))
			void mcp.registerTool(recent.wrap(withSite(tool, recent, targets)));
		// A new connection is not up yet: it reads the page once it is, or
		// for a panel (`#readsWanted`).
		if (this.#panels.size > 0) void bridge.refresh();
		return [mcp, bridge];
	}

	/**
	 * A question for a page tool or a navigation; "Recent calls" shows it
	 * waiting, then the answer (DEC-226).
	 */
	async #ask(
		request: Parameters<Questions["ask"]>[0],
		where: Parameters<Questions["ask"]>[1],
	): ReturnType<Questions["ask"]> {
		this.#recent.note(request.signal, { waiting: true });
		const inTab =
			where.tabId === undefined ? undefined : await this.#otherTab(where.tabId);
		const answer = await this.#questions.ask(request, {
			...where,
			...(inTab !== undefined ? { inTab } : {}),
		});
		this.#recent.note(request.signal, { answer });
		return answer;
	}

	/**
	 * For a question about tab `tabId`: its title, and whether it is the
	 * pinned tab, if it is not the tab in front (DEC-230); else `undefined`.
	 */
	async #otherTab(
		tabId: number,
	): Promise<{ title: string; pinned: boolean } | undefined> {
		const front = await tabInFront().catch(() => undefined);
		if (front?.id === tabId) return undefined;
		const [tab, setting] = await Promise.all([
			getTab(tabId),
			this.#targets.setting(),
		]);
		return {
			title: tab?.title ?? "",
			pinned: setting.mode === "pinned" && setting.pin === tabId,
		};
	}

	/**
	 * A page tool that is not read-only: one the user allowed for its site
	 * runs; anything else asks. "Always allow on <host>" in the question
	 * allows it for its site.
	 */
	#decide(request: ConfirmRequest, tool: LookedUp): Promise<void> {
		return decide(
			{
				allowed: (origin, name) => {
					const yes = isAllowed(this.#allowed, origin, name);
					if (yes) this.#recent.note(request.signal, { allowedBefore: true });
					return yes;
				},
				ask: (r, where) => this.#ask(r, where),
				allow: (origin, name) =>
					this.#queue(async () => {
						this.#allowed = await setAllowed(this.#kv, origin, name, true);
						void this.#readTab();
					}),
			},
			request,
			tool,
		);
	}

	/**
	 * Run `task` after the panel commands before it, as one of them: two
	 * writes of the allowed tools must not overlap.
	 */
	#queue(task: () => Promise<void>): Promise<void> {
		const done = this.#commands.then(task);
		this.#commands = done.catch((error: unknown) => {
			this.#problem = message(error);
			this.#changed();
		});
		return done;
	}

	#watch(mcp: TabMcp): void {
		this.#listening.abort();
		this.#listening = new AbortController();
		const { signal } = this.#listening;
		this.#calls.watch(mcp, signal);
		this.#recent.watch(mcp, signal);
		const changed = () => this.#changed();
		// `statechange` and `grantschange` have their own listeners below, which
		// call `#changed` too.
		mcp.addEventListener("pairingcode", changed, { signal });
		// The library sets its list only from the relay (connected) or empties
		// it on Disconnect all apps: either way the list to keep (EQ 8).
		mcp.addEventListener(
			"grantschange",
			() => {
				// The list in memory is set at once; a failed write to storage
				// is shown as the problem, not left as an unhandled rejection.
				const grants = mcp.grants.map((g) => ({
					grantId: g.grantId,
					name: g.client.name,
					host: g.client.host,
				}));
				// An AI app that just connected withdraws its pairing question.
				this.#filler.grantsChanged(grants);
				this.#setGrants(grants).catch((error: unknown) => {
					this.#problem = message(error);
					this.#changed();
				});
				this.#changed();
			},
			{ signal },
		);
		mcp.addEventListener(
			"statechange",
			(event) => {
				const { state, reason } = event.detail;
				// Not read while nobody needed the tools (`#readsWanted`): read as
				// the connection is being made, so that the tools offered once it
				// is up are the tab's in front, and again once it is (the content
				// script answers both with one `getTools()`).
				if (state === "connecting" || state === "connected")
					void this.#bridge.refresh();
				if (state === "connected") {
					this.#problem = undefined;
					void this.#setReplaced(undefined);
					void this.#setAiOn(true);
				} else if (reason === "user") void this.#setAiOn(false);
				this.#changed();
			},
			{ signal },
		);
		mcp.addEventListener(
			"replaced",
			(event) => {
				const { sibling } = (event as CustomEvent<ReplacedDetail>).detail;
				this.#replacedHere = true;
				void this.#setReplaced({ sibling });
				this.#changed();
			},
			{ signal },
		);
		mcp.addEventListener(
			"error",
			(event) => {
				this.#problem = message(
					(event as CustomEvent<{ error: unknown }>).detail.error,
				);
				this.#changed();
			},
			{ signal },
		);
	}

	#connect(): void {
		this.#problem = undefined;
		// The extension's rule, not the library's: only the panel's button or
		// a start with AI access left on gets here.
		this.#mcp.connect({ resume: true }).catch((error: unknown) => {
			this.#problem = message(error);
			this.#changed();
		});
	}

	/** Taken over, or not any more: in memory and in storage. */
	async #setReplaced(replaced: Replaced | undefined): Promise<void> {
		this.#replaced = replaced;
		if (replaced === undefined) this.#replacedHere = false;
		await saveReplaced(this.#kv, replaced);
	}

	/** The paired apps to show: in memory and in storage. */
	async #setGrants(grants: GrantView[]): Promise<void> {
		this.#grants = grants;
		await saveGrants(this.#kv, grants);
	}

	async #setAiOn(on: boolean): Promise<void> {
		this.#aiOn = on;
		// Off: a pairing page's question is withdrawn at once (DEC-203).
		if (!on) this.#filler.withdrawAll();
		await saveAiOn(this.#kv, on);
		if (on) await chrome.alarms.create(ALARM, { periodInMinutes: 1 });
		else await chrome.alarms.clear(ALARM);
	}

	/**
	 * Use `relay` from now on. The connection to the one before is ended
	 * whatever its state: left retrying, it would connect again unseen.
	 */
	async #useRelay(relay: string): Promise<void> {
		const before = this.#mcp;
		// The old connection's events end here: a grant it reports during the
		// writes below must not come back as the new relay's list.
		this.#listening.abort();
		this.#bridge.stop();
		// The pages of the relay before are not this one's, and filling in is
		// off for the new one until turned on there; the old relay's site is
		// given back (DEC-203).
		this.#filler.reset();
		this.#releasePairing();
		const old = await this.#fill.reset();
		if (old !== undefined) await this.#giveBackAccess(old);
		this.#relay = relay;
		await this.#setReplaced(undefined);
		// Apps paired through the relay before are not paired with this one.
		await this.#setGrants([]);
		this.#problem = undefined;
		[this.#mcp, this.#bridge] = this.#create(relay);
		this.#watch(this.#mcp);
		await before.disconnect();
		this.syncFill();
		this.#changed();
	}

	// --- Chrome's events ---

	/** The tab in front changed, or what may be read of it. */
	tabChanged(): void {
		// The bridge reads the tab again for the panels after its refresh.
		if (this.#readsWanted()) void this.#bridge.refresh();
	}

	/**
	 * Another tab came to the front, or another window took the focus. With
	 * a tab pinned, the tools offered are the pin's and stay so: they are not
	 * read again (every read is a moment for Chromium issue 585631961,
	 * DEC-177); only the panels read the new tab in front.
	 */
	frontChanged(): void {
		void this.#targets.setting().then((setting) => {
			if (setting.mode === "pinned" && setting.pin !== undefined)
				void this.#readTab();
			else this.tabChanged();
		});
	}

	/**
	 * The page in tab `tabId` loaded or changed its tools: read again if it
	 * is the tab whose tools are offered, the tab in front (`active`) or,
	 * with a tab pinned, the pinned one; with a tab pinned, the panels read
	 * the tab in front of their own.
	 */
	pageChanged(tabId: number, active: boolean): void {
		void this.#targets.setting().then((setting) => {
			const pin = setting.mode === "pinned" ? setting.pin : undefined;
			if (pin === undefined ? active : pin === tabId) this.tabChanged();
			else if (active) void this.#readTab();
		});
	}

	/**
	 * Whether anyone needs the page's tools now: an open panel, or a
	 * connection to the relay (up or on its way). Otherwise the page is not
	 * read at all (DEC-177): every `getTools()` is a moment in which a
	 * navigation can crash Chrome (Chromium issue 585631961). A panel that
	 * opens and a connection that comes up read the page then.
	 */
	#readsWanted(): boolean {
		return this.#panels.size > 0 || this.#mcp.state !== "disconnected";
	}

	/** The worker woke for the alarm: connect if the connection is down. */
	keepUp(): void {
		void Promise.all([loadAiOn(this.#kv), loadReplaced(this.#kv)]).then(
			([on, replaced]) => {
				if (
					on &&
					replaced === undefined &&
					this.#mcp.state === "disconnected" &&
					this.#replaced === undefined
				)
					this.#connect();
			},
		);
	}

	/**
	 * A click on a notification's body: called at once from Chrome's event,
	 * so that `sidePanel.open` still has its user gesture.
	 */
	notificationClicked(id: string): void {
		this.#questions.notificationClicked(id);
	}

	/**
	 * The side panel of the tab's window, opened now, while Chrome's event
	 * still counts as the user's gesture, and its window brought to the
	 * front (the panel's Allow needs it there; where the panel is refused,
	 * the icon's "?" is there to click). Resolves `false` if Chrome refused
	 * the panel or the tab is not known.
	 */
	#showQuestion(
		tabId: number | undefined,
		windowId: number | undefined,
	): Promise<boolean> {
		if (tabId === undefined || windowId === undefined)
			return Promise.resolve(false);
		const toFront = () =>
			void chrome.windows.update(windowId, { focused: true }).catch(() => {});
		// Firefox opens the sidebar in the window in front: that window first
		// (if it is not in front in time, `openPanel` rejects, and the next
		// notification's click finds it there).
		if (FIREFOX) toFront();
		// No await before this: the gesture would be gone.
		return openPanel({ tabId, windowId }).then(
			() => {
				toFront();
				return true;
			},
			(error: unknown) => {
				console.warn("tab-mcp: side panel for a question", error);
				toFront();
				return false;
			},
		);
	}

	notificationButton(id: string, index: number): void {
		this.#questions.notificationButton(id, index);
	}

	notificationDismissed(id: string): void {
		this.#questions.notificationDismissed(id);
	}

	// --- The side panels ---

	/**
	 * A side panel's port, its sender already checked. Returns what takes
	 * the panel's messages: the service worker listens on the port from the
	 * moment it connects, before the connection has started, and hands
	 * them over in their order.
	 */
	addPanel(port: chrome.runtime.Port): (message: unknown) => void {
		const panel: Panel = {
			port,
			pairing: false,
			visible: true,
			argsSent: new Set(),
			calls: false,
		};
		this.#panels.add(panel);
		const receive = (raw: unknown) => {
			// Anything that is not a command is dropped.
			// The rest run one after the other: a connect still waiting on
			// storage must not end after the stop that came next, nor two
			// "allowed" writes overlap.
			const command = parseCommand(raw);
			if (command === undefined) return;
			// A failure is shown as the problem (`#queue`).
			this.#queue(() => this.#command(panel, command)).catch(() => {});
		};
		port.onDisconnect.addListener(() => {
			this.#panels.delete(panel);
			if (panel.pairing) this.#pairingOff();
			if (panel.windowId !== undefined)
				this.#questions.panelClosed(panel.windowId);
		});
		this.#send(panel);
		// The tab now, and again after the bridge's refresh: its tools may be
		// old (not read while nobody needed them, `#readsWanted`). The content
		// script answers both with one `getTools()`.
		void this.#readTab();
		void this.#bridge.refresh();
		return receive;
	}

	async #command(panel: Panel, command: PanelCommand): Promise<void> {
		switch (command.type) {
			case "hello":
				panel.windowId = command.windowId;
				return;
			case "visible":
				panel.visible = command.visible;
				// Hidden: the questions it alone showed go out as notifications.
				if (!command.visible && panel.windowId !== undefined)
					this.#questions.panelClosed(panel.windowId);
				return;
			case "connect":
				// The user's click takes the address back.
				await this.#setReplaced(undefined);
				await this.#setAiOn(true);
				this.#connect();
				this.#changed();
				return;
			case "stop":
				// A `statechange` with reason "user" comes only for a connection that was up.
				await this.#setAiOn(false);
				await this.#mcp.disconnect();
				this.#changed();
				return;
			case "pair":
				panel.pairing = command.on;
				if (command.on) this.#mcp.startPairing();
				else this.#pairingOff();
				this.#changed();
				return;
			case "calls":
				panel.calls = command.open;
				if (command.open)
					this.#post(panel, { type: "calls", calls: this.#recent.list });
				return;
			case "revoke":
				// Only the relay can disconnect an app: not while down (EQ 8). The
				// panel offers Disconnect only while connected; a refusal of the
				// relay (store_unavailable, a timeout) is shown as it is.
				this.#mcp.revoke(command.grantId).catch((error: unknown) => {
					this.#problem =
						error instanceof DOMException && error.name === "InvalidStateError"
							? DISCONNECT_WHILE_DOWN
							: message(error);
					this.#changed();
				});
				return;
			case "disconnect-all":
				await this.#disconnectAll();
				return;
			case "set-relay":
				if (
					relayProblem(command.relay) !== undefined ||
					command.relay === this.#relay
				)
					return;
				// AI access was on for the relay before, not for this one: the
				// user connects to it with a click.
				await this.#setAiOn(false);
				await saveRelay(this.#kv, command.relay);
				await this.#useRelay(command.relay);
				return;
			case "set-allowed":
				this.#allowed = await setAllowed(
					this.#kv,
					command.origin,
					command.name,
					command.on,
				);
				void this.#readTab();
				return;
			case "set-allowed-all": {
				// "Ask for all" takes away: every name given, from that origin,
				// whether offered now or not (one dropped, read-only or broken
				// since the panel showed it must not stay allowed for when it
				// comes back). "Allow all" gives: only tools the bridge offers
				// on that origin now that ask first; names from the panel are
				// not taken on trust.
				let names = command.names;
				if (command.on) {
					// The tools the panels list: the bridge's, or those of the
					// tab in front where calls go to a pinned one.
					const state = this.#tabTools ?? this.#bridge.state;
					if (state.origin !== command.origin) return;
					const wanted = new Set(command.names);
					names = state.tools
						.filter(
							(t) => t.tool !== undefined && !t.readOnly && wanted.has(t.name),
						)
						.map((t) => t.name);
				}
				this.#allowed = await setAllowedMany(
					this.#kv,
					command.origin,
					names,
					command.on,
				);
				void this.#readTab();
				return;
			}
			case "answer":
				this.#questions.answer(command.id, command.answer);
				return;
			case "set-fill":
				await this.#setFill(command.on, command.id);
				return;
			case "forget-fill-host":
				// Its next sign-in page asks again (DEC-213), and a fill of it
				// that still waits for its code goes, as with the switch off.
				this.#unasked.withdraw(command.host);
				await this.#fill.forget(this.#relay, command.host);
				this.#changed();
				return;
			case "set-target-mode":
				await this.#targets.setMode(command.mode);
				return;
			case "work-here": {
				// Only the tab the panels show now: a click on a tab shown
				// before (the user switched since) pins nothing.
				if (this.#tab?.tabId !== command.tabId) return;
				const tab = await tabInNormalWindow(command.tabId);
				if (tab === undefined) return;
				// Only a tab the extension may read, as use_tab: this throws
				// why not, which the panel shows as the problem.
				await askPage(tab);
				await this.#targets.use(tab.id);
				return;
			}
		}
	}

	/**
	 * Filling in the code on the relay's page on or off (DEC-203, DEC-210).
	 * On, for the relay in use: the panel has asked for its site first; if
	 * the site is gone by now (given back for an "off" just before), it
	 * stays off. Off: the questions waiting go, and the relay's site is
	 * given back unless the user gave access to all sites, which is not this
	 * feature's. The panel's command `id` comes back in the state, so the
	 * panel knows its switch shows the worker's answer.
	 */
	async #setFill(on: boolean, id: string): Promise<void> {
		const relay = this.#relay;
		if (on) await this.#fill.turnOn(relay);
		else {
			await this.#fill.turnOff();
			this.#filler.withdrawAll();
			this.#releasePairing();
			await this.#giveBackAccess(relay);
		}
		this.#fillAnswered = id;
		this.syncFill();
		this.#changed();
	}

	/** Give back the host access asked for `relay`'s pairing page. */
	async #giveBackAccess(relay: string): Promise<void> {
		const access = fillAccess(relay);
		if (access === undefined || (await chrome.permissions.contains(ALL_SITES)))
			return;
		await chrome.permissions
			.remove(access)
			.catch((error: unknown) =>
				console.warn("tab-mcp: giving back the relay's site", error),
			);
	}

	/**
	 * Disconnect all apps (`disconnectAll()`). After a takeover the library
	 * first takes the page back, so the relay disconnects the AI apps that
	 * now talk to whoever took it (DEC-095), but only if the takeover happened
	 * in this worker's life: a new worker's library knows nothing of it. Then
	 * the extension connects with the old secret itself, and the new secret
	 * is made while connected, which revokes every grant of the old one.
	 */
	async #disconnectAll(): Promise<void> {
		const takeBack = this.#replaced !== undefined && !this.#replacedHere;
		this.#problem = undefined;
		this.#changed();
		try {
			if (takeBack) await this.#mcp.connect({ resume: true });
			await this.#mcp.disconnectAll();
			await this.#setReplaced(undefined);
		} catch (error) {
			this.#problem = message(error);
		}
		this.#changed();
	}

	/**
	 * Pairing stops once no panel's pairing view is open and no code just
	 * filled in waits for the relay's check.
	 */
	#pairingOff(): void {
		if (
			![...this.#panels].some((p) => p.pairing) &&
			this.#fillHold === undefined
		)
			this.#mcp.stopPairing();
	}

	// --- The relay's pairing page in this browser (DEC-203) ---

	/**
	 * A port from a pairing page's content script; its sender is checked
	 * there. The filler never rejects: it closes the port and logs a failure.
	 */
	pairingPage(port: PagePort): void {
		void this.#filler.page(port);
	}

	/**
	 * Register the pairing page's content script for the relay in use, if
	 * the user gave access to its site: at each start, after a change of
	 * the relay or of the extension's permissions. On, but the site was
	 * taken away (in the browser's settings): filling in goes off, so it
	 * cannot come back by itself when the site does (with access to all
	 * sites, say); the panel says why, and its switch asks for the site.
	 */
	syncFill(): void {
		const relay = this.#relay;
		this.#scriptSync = this.#scriptSync
			.then(async () => {
				if (this.#relay === relay && (await this.#fill.check(relay))) {
					this.#filler.withdrawAll();
					this.#releasePairing();
					this.#changed();
				}
				await syncPairingScript(relay, this.#fillOn());
			})
			.catch((error: unknown) =>
				console.warn("tab-mcp: pairing page registration", error),
			);
	}

	/** Pairing held on for a code being filled in, for HOLD_MS from now. */
	#holdPairing(): void {
		clearTimeout(this.#fillHold);
		this.#fillHold = setTimeout(() => {
			this.#fillHold = undefined;
			this.#pairingOff();
		}, HOLD_MS);
	}

	#releasePairing(): void {
		if (this.#fillHold === undefined) return;
		clearTimeout(this.#fillHold);
		this.#fillHold = undefined;
		this.#pairingOff();
	}

	/** Filling in is on for the relay in use. */
	#fillOn(): boolean {
		return this.#fill.on(this.#relay);
	}

	/**
	 * The code to fill in, with pairing held on for it; the library releases
	 * the hold (`release`) once its code paired, or once no fill needs it.
	 */
	async #fillCode(
		signal: AbortSignal,
		context: FillContext,
	): Promise<string | undefined> {
		this.#holdPairing();
		const { tabId, client } = context;
		// A page let through without a question: Remove withdraws the wait.
		const withdraw = this.#unasked.signal(tabId, client.host);
		const code = await codeWithPairingOn(
			this.#mcp,
			withdraw === undefined ? signal : AbortSignal.any([signal, withdraw]),
		);
		const how = this.#unasked.finish(tabId, client.host, code !== undefined);
		if (how === "withdrawn") {
			// Removed meanwhile: nothing is filled in, and that is no problem.
			this.#quietFails.add(tabId);
			return undefined;
		}
		// Never silent (DEC-213). Said once the code is there: the library
		// sends it right after this, unless its last checks (the page went,
		// AI access or the setting off) stop it. So the notice errs on the
		// side of saying too much; it is no proof that the code was sent.
		if (how === "notice") this.#filledWithoutAsking(client);
		return code;
	}

	/**
	 * Ask about the pairing page in tab `tabId` (DEC-203), unless the user
	 * chose "Always allow" for the AI app's host and the brake lets it
	 * through (DEC-213). "Always allow" is offered only for a host that
	 * qualifies (`alwaysAllowable`).
	 */
	async #askPairing(
		tabId: number,
		client: { name: string; host: string },
		signal: AbortSignal,
	): Promise<FillAnswer> {
		const relay = this.#relay;
		// A mark of an earlier page in the tab whose code never came.
		this.#unasked.clear(tabId);
		if (await this.#fill.takeUnasked(relay, client.host, Date.now())) {
			this.#unasked.start(tabId, client.host, signal);
			return "allow";
		}
		const offered = alwaysAllowable(client.host);
		const { answer, always } = pairingAnswer(
			await this.#questions.askPairing({ tabId }, client, signal, offered),
			offered,
		);
		// "Always allow": this page now, and the host from now on.
		if (
			always &&
			this.#relay === relay &&
			(await this.#fill.allowAlways(relay, client.host))
		)
			this.#changed();
		return answer;
	}

	/** The panel's line and a notification for a fill without a question. */
	#filledWithoutAsking(client: { name: string; host: string }): void {
		this.#fillNotice = { text: filledText(client), at: Date.now() };
		this.#changed();
		const text = filledNotification(client);
		notificationApi()
			.create(
				`${FILLED_PREFIX}${crypto.randomUUID()}`,
				notificationOptions({
					type: "basic",
					iconUrl: chrome.runtime.getURL("icons/icon-128.png"),
					title: text.title,
					message: text.message,
					contextMessage: text.contextMessage,
					priority: 0,
				}),
			)
			.catch((error: unknown) =>
				// Not made (an error; notifications turned off in the system
				// are not one, and cannot be seen from here). The panel's line
				// is there for 10 minutes in any case.
				console.warn("tab-mcp: notification", error),
			);
	}

	/** A tab closed: what was kept for its pairing page, and for its WebMCP, goes. */
	tabClosed(tabId: number): void {
		this.#late.closed(tabId);
		this.#unasked.tabClosed(tabId);
		this.#quietFails.delete(tabId);
		// The pinned tab closed: its tools go, and the panels say so. The pin
		// stays, so calls fail instead of going elsewhere (DEC-230).
		this.pageChanged(tabId, false);
	}

	/** The extension's parts of the library's fill-in (DEC-206). */
	#fillHost(): FillHost {
		return {
			extensionId: chrome.runtime.id,
			app: APP_ID,
			relayOrigin: () => relayPageOrigin(this.#relay),
			aiOn: () => this.#status() !== "off",
			enabled: () => this.#fillOn(),
			ask: (tabId, client, signal) => this.#askPairing(tabId, client, signal),
			code: (signal, context) => this.#fillCode(signal, context),
			release: () => this.#releasePairing(),
			failed: (why, context) => {
				// A fill withdrawn by Remove ends with no code: not a problem.
				if (why === "no-code" && this.#quietFails.delete(context.tabId)) return;
				this.#problem = failureText(why);
				this.#changed();
			},
			now: () => Date.now(),
		};
	}

	#questionsHost(): QuestionsHost {
		return {
			windowOf: async (tabId) => {
				try {
					return (await chrome.tabs.get(tabId)).windowId;
				} catch {
					return undefined;
				}
			},
			panelInFocus: async (windowId) => {
				// Open is not enough: it has to be on screen, not covered by
				// another extension's panel for the tab.
				if (
					![...this.#panels].some((p) => p.windowId === windowId && p.visible)
				)
					return false;
				return (await chrome.windows.get(windowId)).focused;
			},
			notify: async (id, text) => {
				await notificationApi().create(
					id,
					questionNotification(
						text,
						chrome.runtime.getURL("icons/icon-128.png"),
					),
				);
			},
			clear: (id) =>
				void notificationApi()
					.clear(id)
					.catch(() => {}),
			showQuestion: ({ tabId, windowId }) =>
				this.#showQuestion(tabId, windowId),
			changed: () => this.#changed(),
			now: () => Date.now(),
		};
	}

	/** The tab in front as the panels show it (only while one is open). */
	async #readTab(): Promise<void> {
		if (this.#panels.size === 0) return;
		const read = ++this.#tabRead;
		const [allSites, target] = await Promise.all([
			chrome.permissions.contains(ALL_SITES),
			this.#targetView(),
		]);
		let tab: TargetTab;
		try {
			tab = await tabInFront();
		} catch {
			if (read !== this.#tabRead) return;
			this.#allSites = allSites;
			this.#target = target;
			this.#tabTools = undefined;
			this.#tab = {
				title: "No tab",
				host: "",
				access: "",
				tools: [],
				canAllow: false,
			};
			this.#changed();
			return;
		}
		let view: TabView;
		let tools: BridgeState | undefined;
		let host = "";
		let tabOrigin: string | undefined;
		try {
			const url = new URL(tab.url);
			host = url.host || tab.url;
			tabOrigin = url.origin;
		} catch {
			host = tab.url;
		}
		try {
			const page = await askPage(tab);
			// The bridge's last read, or, where calls go to another tab (a
			// pinned one), a read of the tab in front of its own: the panel
			// lists the tools of the tab it shows.
			let state = this.#bridge.state;
			if (state.tabId !== tab.id && target.pinned?.tabId !== undefined)
				state = await this.#bridge.stateOf(tab, { refresh: false });
			tools = state;
			// The bridge's last read is of this tab and its site. Not the
			// address: a pushState or #part changes it without a new read
			// (EQ 12), and the tools stay the page's.
			const current =
				state.tabId === tab.id &&
				state.origin !== undefined &&
				state.origin === tabOrigin;
			const origin = state.origin;
			// WebMCP is on its way (DEC-223): the bridge has not read this tab
			// yet, or the extension's own is being given to the page it read.
			const pending =
				!page.webmcp.available &&
				(current
					? this.#late.pending(tab.id, state.documentId)
					: state.tabId !== tab.id && this.#late.pending(tab.id, undefined));
			view = {
				tabId: tab.id,
				title: page.title || tab.title || host || "(no title)",
				host,
				// The tools the bridge lists for this page; the page's own count
				// until it has read them.
				webmcp: {
					available: page.webmcp.available,
					tools: current ? state.tools.length : page.webmcp.tools,
					...(page.webmcp.late ? { late: true as const } : {}),
					...(pending ? { pending: true as const } : {}),
				},
				// Readable, but reading its tools failed: why, instead of an
				// empty list.
				access:
					!current && state.tabId === tab.id && state.error !== undefined
						? state.error
						: "",
				...(current && origin ? { origin } : {}),
				canAllow: current && origin !== undefined && allowable(origin),
				// The client library, as the page announced it (DEC-207).
				...(current && state.library !== undefined
					? { library: { apps: state.library.apps } }
					: {}),
				tools: current
					? state.tools.map((t) => ({
							name: t.name,
							...(t.title ? { title: t.title } : {}),
							readOnly: t.readOnly,
							...(t.problem ? { problem: t.problem } : {}),
							allowed:
								origin !== undefined &&
								isAllowed(this.#allowed, origin, t.name),
						}))
					: [],
			};
		} catch (error) {
			view = {
				tabId: tab.id,
				title: tab.title || host || "(no title)",
				host,
				// An access problem in the panel's own words (EQ 6).
				...(error instanceof NoAccessError ? { noAccess: error.reason } : {}),
				access: error instanceof NoAccessError ? "" : message(error),
				tools: [],
				canAllow: false,
			};
		}
		if (read !== this.#tabRead) return;
		this.#allSites = allSites;
		this.#target = target;
		this.#tabTools = tools;
		this.#tab = view;
		this.#changed();
	}

	/** Where calls go, for the panels: the mode, and the pinned tab's title. */
	async #targetView(): Promise<TargetView> {
		const { mode, pin } = await this.#targets.setting();
		if (mode === "front" || pin === undefined) return { mode };
		const tab = await tabInNormalWindow(pin);
		return {
			mode,
			pinned:
				tab === undefined
					? { tabId: pin, title: "", closed: true }
					: { tabId: pin, title: tab.title },
		};
	}

	// --- State ---

	/** Whether the user left AI access on. */
	get aiOn(): boolean {
		return this.#aiOn;
	}

	get state(): PanelState {
		const mcp = this.#mcp;
		const status = this.#status();
		const address = mcp.session?.address;
		const code = mcp.pairingCode?.code;
		const problem = this.#problem;
		return {
			relay: this.#relay,
			status,
			...(address !== undefined ? { address } : {}),
			grants: this.#grants,
			pairing: [...this.#panels].some((p) => p.pairing),
			calling: this.#calls.any,
			recentCalls: this.#recent.count,
			...(code !== undefined ? { code } : {}),
			...(problem !== undefined ? { problem } : {}),
			...(this.#replaced !== undefined
				? { replaced: { sibling: this.#replaced.sibling } }
				: {}),
			allSites: this.#allSites,
			fillCode: this.#fillOn(),
			fillLost: this.#fill.lost(this.#relay),
			fillAlways: this.#fill.alwaysHosts(this.#relay),
			...(this.#fillNotice !== undefined &&
			Date.now() - this.#fillNotice.at < NOTICE_MS
				? { fillNotice: this.#fillNotice }
				: {}),
			...(this.#fillAnswered !== undefined
				? { fillAnswered: this.#fillAnswered }
				: {}),
			...(this.#tab !== undefined ? { tab: this.#tab } : {}),
			...(this.#target !== undefined ? { target: this.#target } : {}),
			questions: this.#questions.list.map(({ args: _, ...q }) => q),
			expired: this.#questions.expired,
		};
	}

	/**
	 * What a page that announced the client library may be told (DEC-207):
	 * the extension's name, whether AI access is on and connected, and the
	 * AI apps connected now; the content script tells it only while on
	 * (DEC-221). Nothing else: not the version, the relay, the address or
	 * other tabs.
	 */
	handshakeState(): ExtensionState {
		const mcp = this.#mcp;
		const on = mcp.state === "connected";
		return {
			name: PRODUCT,
			on,
			apps: on
				? mcp.grants.map((g) => ({ name: g.client.name, host: g.client.host }))
				: [],
			// An AI app reaches a tab that is not in front too (a pinned
			// one, a call's tab argument), in either mode: the page does not
			// say "while this tab is in front" (DEC-230).
			whileInFront: false,
		};
	}

	/**
	 * Tell the pages when the state above changes (or, `again`, when host
	 * access changed): every tab's content script of a site the extension
	 * may read hears it, and passes it on only to a page that announced the
	 * library. A tab the extension may not read (no address: host access
	 * withdrawn, say) hears only "off": a content script left there from
	 * before tells a page it told "on" that it is off, and nothing more
	 * (DEC-221).
	 */
	#tellPages(again = false): void {
		const state = this.handshakeState();
		const told = JSON.stringify(state);
		if (told === this.#told && !again) return;
		this.#told = told;
		const message: ContentRequest = { type: "extension-state", state };
		const off: ContentRequest = {
			type: "extension-state",
			state: { ...state, on: false, apps: [] },
		};
		chrome.tabs.query({}).then(
			(tabs) => {
				for (const tab of tabs) {
					const to =
						tab.url === undefined
							? off
							: isSitePage(tab.url)
								? message
								: undefined;
					if (tab.id !== undefined && to !== undefined)
						chrome.tabs.sendMessage(tab.id, to, { frameId: 0 }).catch(() => {
							// No content script there: nothing to tell.
						});
				}
			},
			() => {},
		);
	}

	/** Host access was granted or withdrawn: the pages hear the state again. */
	hostAccessChanged(): void {
		this.#tellPages(true);
	}

	#status(): PanelState["status"] {
		return panelStatus({
			state: this.#mcp.state,
			grants: this.#mcp.grants.length,
			aiOn: this.#aiOn,
			replaced: this.#replaced !== undefined,
		});
	}

	/** Tell the panels and the pages, and set the badge. */
	#changed(): void {
		this.#showBadge();
		this.#tellPages();
		this.#tellPanels();
	}

	/**
	 * A call added to "Recent calls" or changed: to the panels that have it
	 * open; the others learn only the count, in the state, while it grows.
	 */
	#callChanged(call: CallView, added: boolean): void {
		for (const panel of this.#panels)
			if (panel.calls) this.#post(panel, { type: "call", call });
		if (added && this.#recent.count !== this.#recentSent) {
			this.#recentSent = this.#recent.count;
			this.#tellPanels();
		}
	}

	#post(panel: Panel, message: WorkerMessage): void {
		try {
			panel.port.postMessage(message);
		} catch {
			// Closed meanwhile: its onDisconnect removes it.
		}
	}

	/** Tell the panels, once per turn of the event loop. */
	#tellPanels(): void {
		if (this.#sending) return;
		this.#sending = true;
		queueMicrotask(() => {
			this.#sending = false;
			for (const panel of this.#panels) this.#send(panel);
		});
	}

	/**
	 * The state to a panel. A question's arguments (up to the relay's 1 MiB
	 * per request, more once escaped) go once per panel, each in a message
	 * of its own before the state that first lists the question: repeated
	 * in every state, a few large ones could pass Chrome's limit for one
	 * message, and the panel would get no state at all.
	 */
	#send(panel: Panel): void {
		try {
			for (const args of argsToSend(this.#questions.list, panel.argsSent))
				panel.port.postMessage(args);
			const message: WorkerMessage = { type: "state", state: this.state };
			panel.port.postMessage(message);
		} catch {
			// Closed meanwhile: its onDisconnect removes it.
		}
	}

	/**
	 * The icon says what is going on with no panel open: a question waits
	 * ("?"), AI access is on ("on"), or it is connecting or retrying ("…").
	 */
	#showBadge(): void {
		const questions = this.#questions.list.length;
		const status = this.#status();
		const [text, color, title] =
			questions > 0
				? [
						"?",
						BADGE_LOOK.question,
						`${PRODUCT}: ${questions === 1 ? "a question waits" : `${questions} questions wait`} for your answer. Open the ${PANEL} to answer.`,
					]
				: status === "on" || status === "waiting"
					? ["on", BADGE_LOOK.on, `${PRODUCT}: AI access is on`]
					: status === "connecting" || status === "retrying"
						? ["…", BADGE_LOOK.idle, `${PRODUCT}: connecting…`]
						: ["", BADGE_LOOK.idle, PRODUCT];
		void chrome.action.setBadgeText({ text }).catch(() => {});
		// Said, not left to Chrome's choice between black and white.
		void chrome.action
			.setBadgeTextColor({ color: BADGE_LOOK.text })
			.catch(() => {});
		void chrome.action.setBadgeBackgroundColor({ color }).catch(() => {});
		void chrome.action.setTitle({ title }).catch(() => {});
	}
}
