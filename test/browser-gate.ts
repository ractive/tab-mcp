/**
 * The gate of the browser tests. A test file that launches a browser is
 * named `*.browser.test.ts`, imports this, and looks for its browser only
 * when it is true: plain `bun test` (so `bun run verify`) loads such a file
 * and starts nothing, no browser, no build of the extension, no relay.
 * `bun run test:browser` sets `TAB_MCP_BROWSER=1` (scripts/test-browser.ts);
 * scripts/test-browser.test.ts fails for a browser file that is not named so
 * or does not import this.
 *
 * When it is true, loading this takes the machine-wide lock first
 * (test/browser-lock.ts): a browser file run on its own (`TAB_MCP_BROWSER=1
 * bun test <file>`) waits for another run as `test:browser` does, and sweeps
 * what killed runs left (test/browser-sweep.ts). Under `test:browser`, which
 * took the lock and swept, this holds it already.
 */
import { holdBrowserLock } from "./browser-lock.ts";
import { sweep } from "./browser-sweep.ts";

export const browserTests = process.env["TAB_MCP_BROWSER"] === "1";

if (
	browserTests &&
	(await holdBrowserLock({ filter: process.argv.slice(2).join(" ") })) ===
		"taken"
)
	sweep();
