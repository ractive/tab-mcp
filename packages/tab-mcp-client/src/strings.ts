/**
 * Every text of the library's dialogs, in one table (CU 5). A page passes
 * its own for some or all keys (`ui: { strings }`); the dialogs use these for
 * the rest. `{name}` is a placeholder the dialog fills in: names of tools
 * and AI apps (isolated, so that they cannot reorder the sentence), the
 * code, counts. Where English needs two forms, there are two keys
 * (`…One` for one, `…Many` for more). `lang` and `dir` are the language and
 * direction of the texts, set on every dialog.
 */
export const STRINGS = {
	lang: "en",
	dir: "ltr",
	/** Between the last two items of a list ("A, B and C"). */
	and: "and",

	// The confirmation of a consequential tool call.
	confirmTitle: "Allow {tool}?",
	confirmWho: "{client} wants to run {tool}.",
	deny: "Don't allow",
	allow: "Allow",
	/** `alwaysAllow: true`: kept until the app is disconnected. */
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
	waitingOne: "1 more call is waiting after this one.",
	waitingMany: "{n} more calls are waiting after this one.",
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

	// The connect dialog.
	connectTitle: "Connect your AI app",
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
	codeSentence: "When asked, enter the code {code}",
	codeNote: "A new code appears every 2 minutes and after each use.",
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
		"An AI app is connected that should not be? This disconnects every AI app from this page; each one has to connect again with a new code.",
	disconnectAllQuestionOne:
		"This disconnects {apps}. To use this page with it again, connect it again and enter a new code.",
	disconnectAllQuestionMany:
		"This disconnects {apps}. To use this page with them again, connect them again and enter a new code.",
	disconnectAllConfirm: "Disconnect all",
	cancel: "Cancel",
	disconnectingAll: "Disconnecting…",
	disconnectAllDone: "Every AI app is disconnected. Connect yours again.",
	connectedOne: "{apps} is connected",
	connectedMany: "{apps} are connected",
	connectedNextOne:
		"You can close this now and ask it to use the tools of this page.",
	connectedNextMany:
		"You can close this now and ask them to use the tools of this page.",
	connectAnother: "Connect another app",
	connectedHeading: "Connected",
	appConnected: "{app} connected",
	disconnect: "Disconnect",
	disconnectApp: "Disconnect {app}",
	disconnectNote: "To disconnect an app, connect this page again first.",
	/** Disconnect failed: the relay could not save it (`store_unavailable`). */
	storeUnavailable: "The relay could not save this. Try again.",
	/** Disconnect failed for another reason. */
	disconnectFailed: "Could not disconnect the app. Try again.",
	// Under a connected app: a switch per tool that asks, and one for all.
	runsWithoutAsking: "Runs without asking",
	/** After a tool's name: it may delete or overwrite (`destructiveHint`). */
	destructive: "destructive",
	/** A tool's switch, as read out: starts with what it shows (WCAG 2.5.3). */
	allowToolApp: "{tool} runs without asking for {app}",
	allowDestructiveToolApp: "{tool} (destructive) runs without asking for {app}",
	allowEverything: "Allow everything, no questions asked",
	allowEverythingApp: "Allow everything, no questions asked, for {app}",
	allowEverythingNote:
		"Every tool of this page runs for {app} without asking, with any arguments: also tools you have not seen yet and ones that delete or overwrite.",
	closeNote:
		"Closing this stops the code. To connect later, open this again from the page.",
	close: "Close",
	done: "Done",

	// The notice when another tab or program took over the address.
	replacedSiblingTitle: "Opened in another tab",
	replacedSibling:
		"This page is open in another tab, and your AI apps now use that one. To use them here, connect this page again.",
	replacedTitle: "Another tab or program took over this page",
	replaced:
		"Your AI apps now reach that tab or program instead of this page. If you did not open this page in another tab or window of this browser, someone may have copied what this page keeps to connect. “Disconnect all apps” ends that; then connect your AI apps again with a new code.",
	takenOverAgain:
		"It was taken over again before its AI apps were disconnected. Try again.",
	/** `{reason}`: why disconnecting all apps failed, one of the texts above. */
	tryAgainOrClose: "{reason} Try again, or close this.",
};

/** The texts of the dialogs: the keys of {@link STRINGS}, each a string. */
export type DialogStrings = { [K in keyof typeof STRINGS]: string };
