/**
 * The gate of the browser tests. A test file that launches a browser is
 * named `*.browser.test.ts`, imports this, and looks for its browser only
 * when it is true: plain `bun test` (so `bun run verify`) loads such a file
 * and starts nothing, no browser, no build of the extension, no relay.
 * `bun run test:browser` sets `TAB_MCP_BROWSER=1` (scripts/test-browser.ts);
 * scripts/test-browser.test.ts fails for a browser file that is not named so
 * or does not import this.
 */
export const browserTests = process.env["TAB_MCP_BROWSER"] === "1";
