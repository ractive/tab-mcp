/**
 * For scripts/sweep.browser.test.ts: start a Chrome through the CDP harness,
 * print this process's run folder, and wait to be killed. The test kills it
 * with SIGKILL, so the harness's reap never runs and the Chrome stays.
 *
 * Run: `bun scripts/hold-chrome.ts <chrome binary>`.
 */
import { Browser } from "../packages/tab-mcp-client/test/cdp.ts";
import { runDir } from "../test/browser-dirs.ts";

const [binary] = process.argv.slice(2);
if (binary === undefined)
	throw new Error("usage: bun scripts/hold-chrome.ts <chrome>");
await Browser.launch(binary);
console.log(runDir());
await Bun.sleep(120_000);
