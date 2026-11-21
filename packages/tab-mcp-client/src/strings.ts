/**
 * `@ractive-ch/tab-mcp-client/strings`: every text the library can show to
 * a person, in English, in one table (`STRINGS`), `pickStrings` to choose
 * a page's own translation by the user's languages, and `withEnglish` for
 * a page that shows these texts in its own UI. The package ships English only;
 * a page passes its own table once, as `ui.strings` of `TabMcp` (or of
 * `<TabMcpProvider>`), and every missing key stays English.
 *
 * `{name}` is a placeholder the library fills in: names of tools and AI
 * apps (isolated, so that they cannot reorder the sentence), the code,
 * counts. A text that depends on a count is a {@link PluralText}, one form
 * per plural category of the language (`Intl.PluralRules`). Lists of names
 * are joined by `Intl.ListFormat`. Both follow `lang`, the language of the
 * texts, which the dialogs also set on themselves with its direction.
 *
 * Texts an AI app reads (tool results, refusals) are not here: they stay
 * English on purpose, as the AI app quotes them back in its own words.
 */

/**
 * A text that depends on a count `{n}` (or on the number of names in a
 * list): one form per plural category the language has, as
 * `Intl.PluralRules` names them. `other` is required; English needs `one`
 * and `other`, Polish `one`, `few`, `many` and `other`, Japanese only
 * `other`. A category the table lacks uses `other`.
 */
export type PluralText = { other: string } & {
	[category in Intl.LDMLPluralRule]?: string;
};

const english = {
	/**
	 * The language of the texts (a BCP 47 tag): set on every dialog, and the
	 * language `Intl.PluralRules` and `Intl.ListFormat` follow.
	 */
	lang: "en",

	// The confirmation of a consequential tool call.
	confirmTitle: "Allow {tool}?",
	confirmWho: "{client} wants to run {tool}.",
	deny: "Don't allow",
	allow: "Allow once",
	/** `alwaysAllow: true`: kept until the AI app is disconnected. */
	alwaysAllow: "Always allow",
	alwaysAllowNote:
		"Always allow: {tool} will run for {client} without asking, with any arguments, until you disconnect {client} from this page.",
	/** `alwaysAllow: "until-reload"`, or kept in memory only (`storage: null`). */
	allowUntilReload: "Allow until reload",
	allowUntilReloadNote:
		"Allow until reload: {tool} will run for {client} without asking, with any arguments, until you reload this page or disconnect {client}.",
	argumentsHidden:
		"The arguments cannot be shown, so this call cannot be allowed.",
	scrollToAllow: "Scroll to the end of the arguments to allow this call.",
	waiting: {
		one: "{n} more call is waiting after this one.",
		other: "{n} more calls are waiting after this one.",
	},
	/** Before the page's title while a confirmation waits in a hidden tab. */
	titlePrefix: "Allow? – ",

	// How the dialogs name a caller.
	clientWebMcp: "An agent in this browser",
	clientLocal: "{name} (this site's assistant)",
	/** An AI app through the relay: its name and the host of its client id. */
	clientRelay: "{name} ({host})",

	// Copy buttons.
	copy: "Copy",
	copied: "Copied",
	/** On the button after a refused Copy: the text is selected instead. */
	pressMac: "Press ⌘C",
	pressOther: "Press Ctrl+C",
	/** The same on a touch screen, where there is no key to press. */
	selected: "Selected",
	copyAddress: "Copy address",
	copyCode: "Copy code",
	copyCommand: "Copy {app} command",

	// The connect dialog; its title is also `ConnectButton`'s label.
	connectTitle: "Connect your AI app",
	/**
	 * At the top, while AI apps reach the page through the tab-mcp browser
	 * extension (`TabMcp.extension`, DEC-207); `…InFront` when the extension
	 * serves only the tab in front, as it does. `{apps}`: their names, as a
	 * list.
	 */
	viaExtension: {
		one: "{apps} is connected through the tab-mcp browser extension.",
		other: "{apps} are connected through the tab-mcp browser extension.",
	},
	viaExtensionInFront: {
		one: "{apps} is connected through the tab-mcp browser extension, while this tab is in front.",
		other:
			"{apps} are connected through the tab-mcp browser extension, while this tab is in front.",
	},
	connecting: "Connecting…",
	connectAgain: "Connect again",
	reconnecting: "Connection lost. Reconnecting…",
	notConnected: "Not connected.",
	unreachable: "Could not connect. Check your internet connection.",
	rateLimited: "Too many attempts. Wait a minute, then connect again.",
	refused: "The connection was refused.",
	ended: "The session ended.",
	lost: "The connection was lost.",
	closed: "The connection was closed.",
	disconnected: "Disconnected.",
	checkingSignIn: "Checking your sign-in…",
	signInFirst: "Sign in to this page first.",
	signInRefused: "Your sign-in on this page was not accepted.",
	/** `{reason}`: the relay's reason, as it gave it. */
	signInRefusedWhy: "Your sign-in on this page was not accepted ({reason}).",
	readyApp: "{app} is ready for your AI app.",
	readyPage: "This page is ready for your AI app.",
	addressLabel: "Add this address to your AI app:",
	help: "How do I add it?",
	guide: "Step by step, and what to do when it fails",
	codeSentence: "When asked, type the code {code}",
	codeNote: "The code changes every 2 minutes and after each use.",
	codeUsed: "Code used. Waiting for your AI app…",
	signIn:
		"When your AI app asks, sign in with the account you use on this page. No code is needed.",
	/** Under `signIn`: until when the relay pairs a sign-in (`{time}`: hours and minutes). */
	signInUntil: "Your AI app can connect until {time}.",
	/** The status once that time is up; Continue starts it again. */
	signInTimeUp:
		"The time to connect your AI app is up. To connect it now, continue.",
	continuePairing: "Continue",
	disconnectAll: "Disconnect all apps",
	disconnectAllNote:
		"An AI app is connected that should not be? This disconnects every AI app from this page; each one has to connect again.",
	/** `{apps}`: the AI apps it disconnects, as a list. */
	disconnectAllQuestion: {
		one: "This disconnects {apps}. To use this page with it again, connect it again.",
		other:
			"This disconnects {apps}. To use this page with them again, connect them again.",
	},
	/** Repeats the button that asked. */
	disconnectAllConfirm: "Disconnect all apps",
	cancel: "Cancel",
	disconnectingAll: "Disconnecting…",
	disconnectAllDone: "Every AI app is disconnected. Connect yours again.",
	/** `{apps}`: the connected AI apps, as a list. */
	connected: { one: "{apps} is connected", other: "{apps} are connected" },
	connectedNext: {
		one: "You can close this now and ask it to use the tools of this page.",
		other: "You can close this now and ask them to use the tools of this page.",
	},
	connectAnother: "Connect another AI app",
	connectedHeading: "Connected AI apps",
	appConnected: "{app} connected",
	disconnect: "Disconnect",
	disconnectApp: "Disconnect {app}",
	disconnectNote: "To disconnect an AI app, connect this page again first.",
	/** Disconnect failed: the relay could not save it (`store_unavailable`). */
	storeUnavailable: "The relay could not save this. Try again.",
	/** Disconnect failed for another reason. */
	disconnectFailed: "Could not disconnect the AI app. Try again.",
	// Under a connected AI app: a switch per tool that asks, and one for all,
	// headed by the confirmation's own label (`alwaysAllow` or
	// `allowUntilReload`), so that the button and its switches read alike.
	/** After a tool's name: it may delete or overwrite (`destructiveHint`). */
	destructive: "destructive",
	/** A tool's switch, as read out: starts with what it shows (WCAG 2.5.3). */
	allowToolApp: "{tool} runs without asking for {app}",
	allowDestructiveToolApp: "{tool} (destructive) runs without asking for {app}",
	allowEverything: "Always allow everything",
	allowEverythingApp: "Always allow everything for {app}",
	/** Kept until the AI app is disconnected (`alwaysAllow: true`). */
	allowEverythingNote:
		"Every tool of this page runs for {app} without asking, with any arguments: also tools you have not seen yet and ones that delete or overwrite, until you disconnect {app}.",
	/** Kept in memory only (`alwaysAllow: "until-reload"`, `storage: null`). */
	allowEverythingUntilReloadNote:
		"Every tool of this page runs for {app} without asking, with any arguments: also tools you have not seen yet and ones that delete or overwrite, until you reload this page or disconnect {app}.",
	closeNote:
		"Closing this ends the code. To connect an AI app later, open this again from the page.",
	close: "Close",
	done: "Done",

	// The steps under "How do I add it?" (`setupInstructions`).
	setupClaudeApp: "Claude (claude.ai and the desktop app)",
	setupClaude:
		"Settings → Connectors → Add custom connector, then paste the address.",
	setupChatGpt:
		"On chatgpt.com: Plugins, add an MCP server with the address, then Connect. The Mac app needs more steps: see the guide.",
	/** Before a command to run in a terminal. */
	setupRun: "Run:",
	/** Without a command (an address a shell would not read as plain). */
	setupClaudeCode: "Add the address with claude mcp add --transport http.",
	/** `{command}`: `/mcp`, shown as code. */
	setupClaudeCodeNote:
		"Then type {command} in Claude Code and choose Authenticate.",
	/** Without a command; `{feature}`: the Codex feature to turn on. */
	setupCodex:
		"Run codex features enable {feature}, then add the address with codex mcp add --url and sign in with codex mcp login.",
	setupCodexNote:
		"The last line opens the sign-in that asks for the code. Start a new chat in Codex after it connects.",

	// `ConnectButton` of `./react`; otherwise it says `connectTitle`,
	// `connecting` or, after a few failed attempts, `reconnecting`.
	/** While reconnecting, before it says the connection is lost. */
	buttonReconnecting: "Reconnecting…",
	buttonConnected: { one: "AI app connected", other: "{n} AI apps connected" },

	// The notice when another tab or program took over the address.
	replacedSiblingTitle: "Opened in another tab",
	replacedSibling:
		"This page is open in another tab, and your AI apps now use that one. To use them here, connect this page again.",
	replacedTitle: "Another tab or program took over this page",
	replaced:
		"Your AI apps now use that tab or program instead of this page. If you did not open this page in another tab or window of this browser, someone may have copied this page's saved connection. “Disconnect all apps” ends that; then connect your AI apps again.",
	takenOverAgain:
		"It was taken over again before its AI apps were disconnected. Try again.",
	/** `{reason}`: why disconnecting all apps failed, one of the texts above. */
	tryAgainOrClose: "{reason} Try again, or close this.",
};

/**
 * The texts of the library, key by key: each a string, or a
 * {@link PluralText} where it depends on a count. `dir` is the direction of
 * the texts; without it, the dialogs take it from `lang` where the browser
 * knows it (`Intl.Locale`), else left to right: set `dir: "rtl"` for a
 * right-to-left language to be sure.
 *
 * Type a translation as `DialogStrings` and the type check names every key
 * it lacks or misspells, also after an upgrade added one; as
 * `Partial<DialogStrings>` it may leave keys out (they stay English).
 */
export type DialogStrings = {
	[K in keyof typeof english]: (typeof english)[K] extends string
		? string
		: PluralText;
} & { dir?: "ltr" | "rtl" };

/** The English texts, the defaults for every key. */
export const STRINGS: DialogStrings = english;

const isPlural = (value: unknown): value is PluralText =>
	typeof value === "object" &&
	value !== null &&
	typeof (value as { other?: unknown }).other === "string" &&
	Object.values(value).every((form) => typeof form === "string");

/**
 * Every text: `strings` where it has one of the right kind, English for
 * the rest. A missing translation (`undefined`), an unknown key or a plain
 * string where the English text has plural forms keeps the English text:
 * a table from an older version still works, only less translated.
 */
export function withEnglish(
	strings: Partial<DialogStrings> | undefined,
): DialogStrings {
	const s: Record<string, unknown> = { ...STRINGS };
	for (const [key, value] of Object.entries(strings ?? {})) {
		const english = s[key];
		if (
			key === "dir"
				? value === "ltr" || value === "rtl"
				: typeof english === "string"
					? typeof value === "string"
					: english !== undefined && isPlural(value)
		)
			s[key] = value;
	}
	return s as DialogStrings;
}

/** A table of texts, or a module whose default export is one. */
type Loaded = Partial<DialogStrings> | { default: Partial<DialogStrings> };

/**
 * The page's own table for the user's language, loaded only once chosen:
 * `tables` maps language tags (`"de"`, `"pt-BR"`) to functions that load
 * one, such as `() => import("./tab-mcp.de.ts")`. The user's languages
 * (`navigator.languages`, most preferred first) are matched in order, each
 * exactly and then by its language alone (`de-CH` takes `de`, and `de`
 * takes `de-DE`). English is built in: a user who prefers English before
 * any of the tables, or none of them, gets `undefined`, which keeps the
 * English texts. The table comes with `lang` set to the matched tag unless
 * it has its own.
 *
 * ```ts
 * const strings = await pickStrings({ de: () => import("./tab-mcp.de.ts") });
 * const mcp = new TabMcp({ relay, server, ui: { strings } });
 * ```
 */
export async function pickStrings(
	tables: Record<string, () => Promise<Loaded>>,
	languages: readonly string[] = globalThis.navigator?.languages ?? [],
): Promise<Partial<DialogStrings> | undefined> {
	const tags = Object.keys(tables);
	const base = (tag: string) => tag.toLowerCase().split("-")[0];
	for (const wanted of languages) {
		const want = wanted.toLowerCase();
		const tag =
			tags.find((t) => t.toLowerCase() === want) ??
			tags.find((t) => base(t) === base(want));
		if (tag !== undefined) {
			const loaded = await (tables[tag] as () => Promise<Loaded>)();
			const table: Partial<DialogStrings> =
				"default" in loaded ? loaded.default : loaded;
			return { ...table, lang: table.lang ?? tag };
		}
		// English is built in: the user reads it before any later language.
		if (base(want) === "en") return undefined;
	}
	return undefined;
}
