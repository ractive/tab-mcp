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
	type TabView,
	type WorkerMessage,
} from "../protocol.ts";
import {
	loadAiOn,
	loadRelay,
	loadReplaced,
	type Replaced,
	relayProblem,
	saveAiOn,
	saveRelay,
	saveReplaced,
} from "../relay.ts";
import {
	ALL_SITES,
	askPage,
	askTools,
	callInTab,
	type TargetTab,
	tabInFront,
} from "../tabs.ts";
import {
	type AllowedTools,
	allowable,
	isAllowed,
	loadAllowed,
	setAllowed,
} from "./allowed.ts";
import { AlwaysAllowed } from "./always.ts";
import { PageToolBridge } from "./bridge.ts";
import {
	QUESTION_TIMEOUT_MS,
	Questions,
	type QuestionsHost,
} from "./questions.ts";
import { CachedSecretStorage } from "./secret.ts";
import { createTools, INSTRUCTIONS } from "./tools.ts";

/** Wakes the worker while AI access is on, should the connection be down. */
export const ALARM = "tab-mcp-keepup";

/** One open side panel. */
interface Panel {
	port: chrome.runtime.Port;
	windowId?: number;
	/** Its pairing view is open. */
	pairing: boolean;
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

export class Connection {
	readonly #storage: CachedSecretStorage;
	readonly #icons: Icon[];
	readonly #always = new AlwaysAllowed();
	readonly #questions: Questions;
	readonly #panels = new Set<Panel>();
	#allowed: AllowedTools;
	#relay: string;
	#mcp: TabMcp;
	#bridge: PageToolBridge;
	#listening = new AbortController();
	#problem: string | undefined;
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

	private constructor(
		storage: CachedSecretStorage,
		icons: Icon[],
		allowed: AllowedTools,
		relay: string,
		replaced: Replaced | undefined,
	) {
		this.#storage = storage;
		this.#icons = icons;
		this.#allowed = allowed;
		this.#relay = relay;
		this.#replaced = replaced;
		this.#questions = new Questions(this.#questionsHost());
		[this.#mcp, this.#bridge] = this.#create(relay);
		this.#watch(this.#mcp);
	}

	/**
	 * The connection, connected again if the user left AI access on and the
	 * address was not taken over meanwhile.
	 */
	static async start(): Promise<Connection> {
		// A previous worker's questions died with it: their notifications
		// would answer nothing.
		await clearNotifications();
		const [storage, icons, allowed, relay, on, replaced] = await Promise.all([
			CachedSecretStorage.load(chrome.storage.local),
			iconsFor(),
			loadAllowed(),
			loadRelay(),
			loadAiOn(),
			loadReplaced(),
		]);
		const connection = new Connection(storage, icons, allowed, relay, replaced);
		connection.#showBadge();
		if (on && replaced === undefined) connection.#connect();
		return connection;
	}

	// --- The library's connection and the bridge ---

	#create(relay: string): [TabMcp, PageToolBridge] {
		const mcp: TabMcp = new TabMcp({
			relay,
			server: {
				name: "tab-mcp-for-chrome",
				title: "tab-mcp for Chrome",
				version: chrome.runtime.getManifest().version,
				instructions: INSTRUCTIONS,
				icons: this.#icons,
			},
			appName: "tab-mcp for Chrome",
			storage: this.#storage,
			onConfirm: (request) => this.#decide(request),
		});
		const bridge = new PageToolBridge(
			mcp,
			{ current: tabInFront, list: askTools, call: callInTab },
			() => void this.#readTab(),
		);
		for (const tool of createTools(
			{ current: tabInFront, page: askPage },
			() => bridge,
			(request) => this.#decide(request),
		))
			void mcp.registerTool(tool);
		void bridge.refresh();
		return [mcp, bridge];
	}

	/**
	 * A tool that is not read-only: one the user allowed for its site runs,
	 * as does one they chose Always allow for (this AI app, this page);
	 * anything else asks.
	 */
	async #decide(request: ConfirmRequest): Promise<boolean> {
		const tool = this.#bridge.lookup(request.tool.name);
		if (tool !== undefined && isAllowed(this.#allowed, tool.origin, tool.name))
			return true;
		const { grantId } = request.client;
		// Always allow only for a page of a real site: opaque origins ("null")
		// would all share one entry.
		const always = tool !== undefined && allowable(tool.origin);
		if (always && this.#always.has(grantId, request.tool.name)) return true;
		const answer = await this.#questions.ask(
			request,
			tool === undefined ? {} : { tabId: tool.tabId, origin: tool.origin },
		);
		if (answer === "timeout")
			// The library declines; `webmcp_call` passes this on to the AI app.
			throw new Error(
				`The user was asked and did not answer within ${QUESTION_TIMEOUT_MS / 1000} s.`,
			);
		if (answer === "always" && always)
			this.#always.add(grantId, request.tool.name);
		return answer !== "deny";
	}

	#watch(mcp: TabMcp): void {
		this.#listening.abort();
		this.#listening = new AbortController();
		const { signal } = this.#listening;
		const changed = () => this.#changed();
		for (const type of ["statechange", "reconnecting", "pairingcode"] as const)
			mcp.addEventListener(type, changed, { signal });
		mcp.addEventListener(
			"grantschange",
			() => {
				this.#always.keepGrants(mcp.grants.map((g) => g.grantId));
				this.#changed();
			},
			{ signal },
		);
		mcp.addEventListener(
			"toolschange",
			() => this.#always.keepTools(mcp.tools),
			{ signal },
		);
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
		await saveReplaced(replaced);
	}

	async #setAiOn(on: boolean): Promise<void> {
		await saveAiOn(on);
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
		void Promise.all([loadAiOn(), loadReplaced()]).then(([on, replaced]) => {
			if (
				on &&
				replaced === undefined &&
				this.#mcp.state === "disconnected" &&
				this.#mcp.reconnecting === undefined &&
				this.#replaced === undefined
			)
				this.#connect();
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
		const panel: Panel = { port, pairing: false };
		this.#panels.add(panel);
		const receive = (raw: unknown) => {
			// Anything that is not a command is dropped.
			// The rest run one after the other: a connect still waiting on
			// storage must not end after the stop that came next, nor two
			// "allowed" writes overlap.
			const command = parseCommand(raw);
			if (command === undefined) return;
			this.#commands = this.#commands
				.then(() => this.#command(panel, command))
				.catch((error: unknown) => {
					this.#problem = message(error);
					this.#changed();
				});
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
				await saveRelay(command.relay);
				await this.#useRelay(command.relay);
				return;
			case "set-allowed":
				this.#allowed = await setAllowed(
					command.origin,
					command.name,
					command.on,
				);
				void this.#readTab();
				return;
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
				if (![...this.#panels].some((p) => p.windowId === windowId))
					return false;
				return (await chrome.windows.get(windowId)).focused;
			},
			notify: async (id, text) => {
				await chrome.notifications.create(id, {
					type: "basic",
					iconUrl: chrome.runtime.getURL("icons/icon-128.png"),
					...text,
					buttons: [{ title: "Don't allow" }, { title: "Allow" }],
					requireInteraction: true,
					priority: 2,
				});
			},
			clear: (id) => void chrome.notifications.clear(id).catch(() => {}),
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
				mirrored: 0,
				canAllow: false,
			};
			this.#changed();
			return;
		}
		let view: TabView;
		let host = "";
		try {
			host = tab.url ? new URL(tab.url).host || tab.url : "";
		} catch {
			host = tab.url;
		}
		try {
			const page = await askPage(tab);
			const state = this.#bridge.state;
			const current = state.url === tab.url;
			const origin = state.origin;
			view = {
				title: page.title || tab.title || host || "(no title)",
				host,
				// The tools the bridge lists for this page, without the page's
				// tab-mcp mirrors; the page's own count until it has read them.
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
				mirrored: current ? state.mirrored.length : 0,
			};
		} catch (error) {
			view = {
				title: tab.title || host || "(no title)",
				host,
				access: message(error),
				tools: [],
				mirrored: 0,
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
		const connected = mcp.state === "connected";
		const status: PanelState["status"] = connected
			? mcp.grants.length
				? "on"
				: "waiting"
			: mcp.state === "connecting"
				? "connecting"
				: mcp.reconnecting
					? "retrying"
					: "off";
		const address = mcp.address;
		const code = mcp.pairingCode?.code;
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
			...(this.#problem !== undefined ? { problem: this.#problem } : {}),
			...(this.#replaced !== undefined
				? { replaced: { sibling: this.#replaced.sibling } }
				: {}),
			allSites: this.#allSites,
			...(this.#tab !== undefined ? { tab: this.#tab } : {}),
			questions: this.#questions.list,
		};
	}

	/** Tell the panels (once per turn of the event loop) and set the badge. */
	#changed(): void {
		this.#showBadge();
		if (this.#sending) return;
		this.#sending = true;
		queueMicrotask(() => {
			this.#sending = false;
			for (const panel of this.#panels) this.#send(panel);
		});
	}

	#send(panel: Panel): void {
		const message: WorkerMessage = { type: "state", state: this.state };
		try {
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
		const state = this.#mcp.state;
		const [text, color, title] =
			questions > 0
				? [
						"?",
						"#b45309",
						`tab-mcp for Chrome: ${questions === 1 ? "a tool asks" : `${questions} tools ask`} for your answer. Open the side panel to answer.`,
					]
				: state === "connected"
					? ["on", "#15803d", "tab-mcp for Chrome: AI access is on"]
					: state === "connecting" || this.#mcp.reconnecting
						? ["…", "#6b7280", "tab-mcp for Chrome: connecting"]
						: ["", "#6b7280", "tab-mcp for Chrome"];
		void chrome.action.setBadgeText({ text }).catch(() => {});
		void chrome.action.setBadgeBackgroundColor({ color }).catch(() => {});
		void chrome.action.setTitle({ title }).catch(() => {});
	}
}
