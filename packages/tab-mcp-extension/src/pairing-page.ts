/**
 * The content script of the relay's pairing page (`/authorize`), registered
 * for that page only, once the user gave the extension access to the relay's
 * site (DEC-203). It reads the form's `data-tab-mcp-*` hooks (DEC-199) and
 * nothing else of the page, tells the worker who asks, and waits: only after
 * the user's Allow does the worker send the code, which it writes into the
 * code field before clicking Connect, a real submit of the page's own form.
 * The relay checks the code as it checks a typed one.
 */

import {
	PAIRING_PATH,
	PAIRING_PORT,
	type PairingHello,
	parseFill,
} from "./fill.ts";
import { APP_ID } from "./protocol.ts";

/** The page's pairing form, as far as filling it in needs it. */
export interface PairingForm {
	form: HTMLFormElement;
	field: HTMLInputElement;
	button: HTMLButtonElement;
	app: string;
	clientName: string;
	clientHost: string;
}

/**
 * The pairing form of this extension's app on `doc`, if this is a top-level
 * page at `/authorize` with exactly one such form that has a code field and
 * a Connect button. The worker checks the origin itself; this only spares it
 * the pages that are not one.
 */
export function findPairingForm(
	doc: Document,
	where: { topLevel: boolean; pathname: string },
	app: string = APP_ID,
): PairingForm | undefined {
	if (!where.topLevel || where.pathname !== PAIRING_PATH) return undefined;
	const forms = doc.querySelectorAll<HTMLFormElement>(
		'form[data-tab-mcp-pairing="1"]',
	);
	const [form] = forms;
	if (forms.length !== 1 || form === undefined) return undefined;
	if (form.dataset["app"] !== app) return undefined;
	const field = form.querySelector<HTMLInputElement>(
		'input[data-tab-mcp-field="code"]',
	);
	const button = form.querySelector<HTMLButtonElement>(
		'button[data-tab-mcp-action="connect"]',
	);
	const clientName = form.dataset["clientName"];
	const clientHost = form.dataset["clientHost"];
	if (
		field === null ||
		button === null ||
		clientName === undefined ||
		clientHost === undefined ||
		clientHost === ""
	)
		return undefined;
	return { form, field, button, app, clientName, clientHost };
}

/**
 * Write `code` into the form's field and submit it with its Connect button:
 * the page's own post, as if the user had typed it and clicked.
 */
export function fillIn(found: PairingForm, code: string): void {
	found.field.value = code;
	// The document's own Event (the unit tests' DOM is not the global one).
	const Input = found.field.ownerDocument.defaultView?.Event ?? Event;
	found.field.dispatchEvent(new Input("input", { bubbles: true }));
	found.form.requestSubmit(found.button);
}

/** The hello for `found`, with this page load's nonce. */
export function helloFor(found: PairingForm, nonce: string): PairingHello {
	return {
		type: "pairing-page",
		nonce,
		app: found.app,
		clientName: found.clientName,
		clientHost: found.clientHost,
	};
}

function run(): void {
	// Once per document, also if the script is put in again after the user
	// gave access with the page already open.
	const flag = "__tabMcpPairingPage";
	const scope = globalThis as Record<string, unknown>;
	if (scope[flag] === true) return;
	scope[flag] = true;
	const found = findPairingForm(document, {
		topLevel: window.top === window,
		pathname: location.pathname,
	});
	if (found === undefined) return;
	const nonce = crypto.randomUUID();
	const port = chrome.runtime.connect({ name: PAIRING_PORT });
	let filled = false;
	port.onMessage.addListener((message: unknown) => {
		const fill = parseFill(message, nonce);
		// One fill per page load: the page posts and goes.
		if (fill === undefined || filled) return;
		filled = true;
		fillIn(found, fill.code);
	});
	port.postMessage(helloFor(found, nonce));
}

// Not when the unit tests import the functions above.
if (typeof chrome !== "undefined" && chrome.runtime?.id !== undefined) run();
