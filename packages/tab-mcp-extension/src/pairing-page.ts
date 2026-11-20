/**
 * The content script of the relay's pairing page (`/authorize`), registered
 * for that page only, once the user gave the extension access to the relay's
 * site and turned it on (DEC-203). The library's `runPairingPage` (DEC-206)
 * reads the form's `data-tab-mcp-*` hooks (DEC-199) and its hidden
 * `request_id`, nothing else of the page, tells the worker who asks, and
 * waits: only after the user's Allow does the worker send the code, which it
 * writes into the code field before clicking Connect, a real submit of the
 * page's own form. The relay checks the code as it checks a typed one.
 */

import {
	PAIRING_PORT,
	runPairingPage,
} from "@ractive-ch/tab-mcp-client/extension";
import { APP_ID } from "./protocol.ts";

runPairingPage({
	app: APP_ID,
	connect: () => chrome.runtime.connect({ name: PAIRING_PORT }),
});
