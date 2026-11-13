/**
 * The connection to the user's AI app, in the service worker (DEC-116): the
 * library's `TabMcp` with the extension's tools and the bridge to the page in
 * front, the questions of tools that ask first, and the state the side panels
 * show. A WebSocket that carries messages keeps the worker alive (Chrome 116),
 * and the relay's heartbeat (a ping every 25 s, answered) carries some even
 * when nothing else happens; the worker connects again whenever it starts
 * while the user left AI access on.
 */

import {
	type ConfirmRequest,
	type DisconnectDetail,
	type Icon,
	type ReplacedDetail,
	TabMcp,
} from "@ractive-ch/tab-mcp-client";
import {
	type PanelCommand,
	type PanelState,
	parseCommand,
	parseQuestionAnswer,
	QUESTION_PATH,
	SERVER_NAME,
	type TabView,
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
	type TargetTab,
	tabInFront,
} from "../tabs.ts";
import {
	type AllowedTools,
	allowable,
	isAllowed,
	loadAllowed,
	setAllowed,
	setAllowedMany,
} from "./allowed.ts";
import { type LookedUp, PageToolBridge } from "./bridge.ts";
import { decide } from "./decide.ts";
import { type Kv, openKv } from "./kv.ts";
import { goInTab, navigationTools, settledPage } from "./navigation.ts";
import { QuestionWindows } from "./question-windows.ts";
import { argsToSend, Questions, type QuestionsHost } from "./questions.ts";
import { CachedSecretStorage } from "./secret.ts";
import {
	loadAiOn,
	loadRelay,
	loadReplaced,
	type Replaced,
	saveAiOn,
	saveRelay,
	saveReplaced,
} from "./settings.ts";
import { createTools, INSTRUCTIONS } from "./tools.ts";

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
		const all = await chrome.notifications.getAll();
		await Promise.all(
			Object.keys(all).map((id) => chrome.notifications.clear(id)),
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
	reconnecting: boolean;
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
	if (s.reconnecting || (s.aiOn && !s.replaced)) return "retrying";
	return "off";
}

export class Connection {
	readonly #storage: CachedSecretStorage;
	readonly #icons: Icon[];
	readonly #questions: Questions;
	readonly #panels = new Set<Panel>();
	/** The windows opened for one question each. */
	readonly #questionWindows: QuestionWindows;
	#allowed: AllowedTools;
	#relay: string;
	#mcp: TabMcp;
	#bridge: PageToolBridge;
	#listening = new AbortController();
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
	#tabRead = 0;
	#sending = false;
	/** AI access is on, as last saved. */
	#aiOn: boolean;

	private constructor(
		storage: CachedSecretStorage,
		icons: Icon[],
		allowed: AllowedTools,
		relay: string,
		replaced: Replaced | undefined,
		kv: Kv,
		aiOn: boolean,
	) {
		this.#kv = kv;
		this.#aiOn = aiOn;
		this.#storage = storage;
		this.#icons = icons;
		this.#allowed = allowed;
		this.#relay = relay;
		this.#replaced = replaced;
		this.#questions = new Questions(this.#questionsHost());
		this.#questionWindows = new QuestionWindows({
			create: async () =>
				(
					await chrome.windows.create({
						url: chrome.runtime.getURL(QUESTION_PATH),
						type: "popup",
						width: 440,
						height: 560,
						focused: true,
					})
				)?.id,
			remove: (windowId) =>
				void chrome.windows.remove(windowId).catch(() => {}),
			list: () => this.#questions.list,
			answer: (id, answer) => this.#questions.answer(id, answer),
			parse: parseQuestionAnswer,
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
		const [storage, icons, allowed, relay, on, replaced] = await Promise.all([
			CachedSecretStorage.load(kv),
			iconsFor(),
			loadAllowed(kv),
			loadRelay(kv),
			loadAiOn(kv),
			loadReplaced(kv),
		]);
		const connection = new Connection(
			storage,
			icons,
			allowed,
			relay,
			replaced,
			kv,
			on,
		);
		connection.#showBadge();
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
				title: "tab-mcp for Chrome",
				version: chrome.runtime.getManifest().version,
				instructions: INSTRUCTIONS,
				icons: this.#icons,
			},
			appName: "tab-mcp for Chrome",
			storage: this.#storage,
			// No tool of the extension is consequential: the page tools ask in
			// the bridge, the navigation tools themselves (DEC-141).
			onConfirm: () => false,
		});
		const bridge = new PageToolBridge(
			mcp,
			{
				current: tabInFront,
				list: askTools,
				call: callInTab,
				settled: (tabId, signal) =>
					settledPage({ tab: getTab, page: askPage }, tabId, signal),
			},
			{
				changed: () => void this.#readTab(),
				confirm: (request, tool) => this.#decide(request, tool),
			},
		);
		for (const tool of createTools(
			{ current: tabInFront, page: askPage },
			() => bridge,
		))
			void mcp.registerTool(tool);
		// Navigation (iteration 27, DEC-121): to another origin it asks
		// through the same questions, never "allowed".
		for (const tool of navigationTools(
			{
				current: tabInFront,
				tab: getTab,
				page: askPage,
				history: askHistory,
				go: goInTab,
			},
			(request, where) => this.#questions.ask(request, where),
			() => bridge.refresh(),
		))
			void mcp.registerTool(tool);
		void bridge.refresh();
		return [mcp, bridge];
	}

	/**
	 * A page tool that is not read-only: one the user allowed for its site
	 * runs; anything else asks. "Don't ask again on <host>" in the question
	 * allows it for its site.
	 */
	#decide(request: ConfirmRequest, tool: LookedUp): Promise<void> {
		return decide(
			{
				allowed: (origin, name) => isAllowed(this.#allowed, origin, name),
				ask: (r, where) => this.#questions.ask(r, where),
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
		const changed = () => this.#changed();
		for (const type of [
			"statechange",
			"reconnecting",
			"pairingcode",
			"grantschange",
		] as const)
			mcp.addEventListener(type, changed, { signal });
		mcp.addEventListener(
			"connected",
			() => {
				this.#problem = undefined;
				void this.#setReplaced(undefined);
				void this.#setAiOn(true);
				this.#changed();
			},
			{ signal },
		);
		mcp.addEventListener(
			"disconnected",
			(event) => {
				if ((event as CustomEvent<DisconnectDetail>).detail.reason === "user")
					void this.#setAiOn(false);
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

	async #setAiOn(on: boolean): Promise<void> {
		this.#aiOn = on;
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
		this.#bridge.stop();
		this.#relay = relay;
		await this.#setReplaced(undefined);
		this.#problem = undefined;
		[this.#mcp, this.#bridge] = this.#create(relay);
		this.#watch(this.#mcp);
		await before.disconnect();
		this.#changed();
	}

	// --- Chrome's events ---

	/** The tab in front changed, or what may be read of it. */
	tabChanged(): void {
		// The bridge reads the tab again for the panels after its refresh.
		void this.#bridge.refresh();
	}

	/** The worker woke for the alarm: connect if the connection is down. */
	keepUp(): void {
		void Promise.all([loadAiOn(this.#kv), loadReplaced(this.#kv)]).then(
			([on, replaced]) => {
				if (
					on &&
					replaced === undefined &&
					this.#mcp.state === "disconnected" &&
					this.#mcp.reconnecting === undefined &&
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

	/** A window closed: one opened for a question is its Don't allow. */
	windowRemoved(windowId: number): void {
		this.#questionWindows.windowRemoved(windowId);
	}

	/**
	 * Question `id`, whole: in the side panel of its tab's window (opened
	 * now, while Chrome's event still counts as the user's gesture), or, if
	 * that is refused or there is no tab, in a small window of its own.
	 */
	#showQuestion(
		id: string,
		tabId: number | undefined,
		windowId: number | undefined,
	): void {
		const ownWindow = (error?: unknown) => {
			if (error !== undefined)
				console.warn("tab-mcp: side panel for a question", error);
			this.#questionWindows.open(id).catch((error: unknown) =>
				// The question stays in the panels and the badge says so.
				console.warn("tab-mcp: question window", error),
			);
		};
		if (tabId === undefined || windowId === undefined) {
			ownWindow();
			return;
		}
		// No await before this: the gesture would be gone.
		chrome.sidePanel.open({ tabId, windowId }).then(
			// The panel's Allow needs its window in front.
			() =>
				void chrome.windows.update(windowId, { focused: true }).catch(() => {}),
			ownWindow,
		);
	}

	/**
	 * The port of a question window's page, its sender already checked: it
	 * gets the question of the window it is in, and may answer that one only.
	 */
	addQuestionWindow(port: chrome.runtime.Port): void {
		this.#questionWindows.addPort({
			windowId: port.sender?.tab?.windowId,
			postMessage: (message) => port.postMessage(message),
			disconnect: () => port.disconnect(),
			onMessage: (listener) => port.onMessage.addListener(listener),
			onDisconnect: (listener) => port.onDisconnect.addListener(listener),
		});
	}

	notificationButton(id: string, index: number): void {
		this.#questions.notificationButton(id, index);
	}

	notificationDismissed(id: string): void {
		this.#questions.notificationDismissed(id);
	}

	// --- The side panels ---

	/**
	 * A side panel's port, its sender already checked, with the messages it
	 * sent before the connection had started.
	 */
	addPanel(port: chrome.runtime.Port, early: unknown[] = []): void {
		const panel: Panel = {
			port,
			pairing: false,
			visible: true,
			argsSent: new Set(),
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
		for (const raw of early) receive(raw);
		port.onMessage.addListener(receive);
		port.onDisconnect.addListener(() => {
			this.#panels.delete(panel);
			if (panel.pairing) this.#pairingOff();
			if (panel.windowId !== undefined)
				this.#questions.panelClosed(panel.windowId);
		});
		this.#send(panel);
		void this.#readTab();
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
				// "disconnected" fires only for a connection that was up.
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
			case "revoke":
				this.#mcp.revoke(command.grantId);
				return;
			case "new-address":
				await this.#newAddress();
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
					const state = this.#bridge.state;
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
		}
	}

	/**
	 * A new address. After a takeover the library first takes the old address
	 * back, so the relay disconnects the AI apps that now talk to whoever took
	 * it (DEC-095), but only if the takeover happened in this worker's life:
	 * a new worker's library knows nothing of it. Then the extension connects
	 * with the old address itself, and the new address is made while
	 * connected, which revokes every grant of the old one.
	 */
	async #newAddress(): Promise<void> {
		const takeBack = this.#replaced !== undefined && !this.#replacedHere;
		this.#problem = undefined;
		this.#changed();
		try {
			if (takeBack) await this.#mcp.connect({ resume: true });
			await this.#mcp.newAddress();
			await this.#setReplaced(undefined);
		} catch (error) {
			this.#problem = message(error);
		}
		this.#changed();
	}

	/** Pairing stops once no panel's pairing view is open. */
	#pairingOff(): void {
		if (![...this.#panels].some((p) => p.pairing)) this.#mcp.stopPairing();
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
				await chrome.notifications.create(id, {
					type: "basic",
					iconUrl: chrome.runtime.getURL("icons/icon-128.png"),
					title: text.title,
					message: text.message,
					contextMessage: text.contextMessage,
					buttons: text.buttons.map((title) => ({ title })),
					requireInteraction: true,
					priority: 2,
				});
			},
			clear: (id) => void chrome.notifications.clear(id).catch(() => {}),
			showQuestion: ({ id, tabId, windowId }) =>
				this.#showQuestion(id, tabId, windowId),
			changed: () => this.#changed(),
			now: () => Date.now(),
		};
	}

	/** The tab in front as the panels show it (only while one is open). */
	async #readTab(): Promise<void> {
		if (this.#panels.size === 0) return;
		const read = ++this.#tabRead;
		const allSites = await chrome.permissions.contains(ALL_SITES);
		let tab: TargetTab;
		try {
			tab = await tabInFront();
		} catch {
			if (read !== this.#tabRead) return;
			this.#allSites = allSites;
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
			const state = this.#bridge.state;
			// The bridge's last read is of this tab and its site. Not the
			// address: a pushState or #part changes it without a new read
			// (EQ 12), and the tools stay the page's.
			const current =
				state.tabId === tab.id &&
				state.origin !== undefined &&
				state.origin === tabOrigin;
			const origin = state.origin;
			view = {
				title: page.title || tab.title || host || "(no title)",
				host,
				// The tools the bridge lists for this page; the page's own count
				// until it has read them.
				webmcp: {
					available: page.webmcp.available,
					tools: current ? state.tools.length : page.webmcp.tools,
				},
				access: "",
				...(current && origin ? { origin } : {}),
				canAllow: current && origin !== undefined && allowable(origin),
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
				title: tab.title || host || "(no title)",
				host,
				access: message(error),
				tools: [],
				canAllow: false,
			};
		}
		if (read !== this.#tabRead) return;
		this.#allSites = allSites;
		this.#tab = view;
		this.#changed();
	}

	// --- State ---

	get state(): PanelState {
		const mcp = this.#mcp;
		const status = this.#status();
		const address = mcp.address;
		const code = mcp.pairingCode?.code;
		const problem = this.#problem;
		return {
			relay: this.#relay,
			status,
			...(address !== undefined ? { address } : {}),
			grants: mcp.grants.map((g) => ({
				grantId: g.grantId,
				name: g.client.name,
				host: g.client.host,
			})),
			pairing: [...this.#panels].some((p) => p.pairing),
			...(code !== undefined ? { code } : {}),
			...(problem !== undefined ? { problem } : {}),
			...(this.#replaced !== undefined
				? { replaced: { sibling: this.#replaced.sibling } }
				: {}),
			allSites: this.#allSites,
			...(this.#tab !== undefined ? { tab: this.#tab } : {}),
			questions: this.#questions.list.map(({ args: _, ...q }) => q),
		};
	}

	#status(): PanelState["status"] {
		return panelStatus({
			state: this.#mcp.state,
			reconnecting: this.#mcp.reconnecting !== undefined,
			grants: this.#mcp.grants.length,
			aiOn: this.#aiOn,
			replaced: this.#replaced !== undefined,
		});
	}

	/** Tell the panels (once per turn of the event loop) and set the badge. */
	#changed(): void {
		this.#showBadge();
		if (this.#sending) return;
		this.#sending = true;
		queueMicrotask(() => {
			this.#sending = false;
			for (const panel of this.#panels) this.#send(panel);
			this.#questionWindows.sync();
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
						"#b45309",
						`tab-mcp for Chrome: ${questions === 1 ? "a tool asks" : `${questions} tools ask`} for your answer. Open the side panel to answer.`,
					]
				: status === "on" || status === "waiting"
					? ["on", "#15803d", "tab-mcp for Chrome: AI access is on"]
					: status === "connecting" || status === "retrying"
						? ["…", "#6b7280", "tab-mcp for Chrome: connecting"]
						: ["", "#6b7280", "tab-mcp for Chrome"];
		void chrome.action.setBadgeText({ text }).catch(() => {});
		void chrome.action.setBadgeBackgroundColor({ color }).catch(() => {});
		void chrome.action.setTitle({ title }).catch(() => {});
	}
}
