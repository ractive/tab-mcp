/**
 * A check by hand against the hosted relay, not part of `bun test`: the
 * development build (the owner's key, so the id the relay allows) connects
 * from its side panel to https://tab-mcp.ractive.ch and shows the address and
 * a pairing code. Needs ~/.config/tab-mcp/extension-key.txt and Chrome for
 * Testing (CHROME_PATH).
 *
 *   bun packages/tab-mcp-extension/test/hosted.ts
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "../scripts/build.ts";
import { Browser, findChromeForTesting } from "./browser.ts";

const binary = findChromeForTesting();
if (binary === undefined) throw new Error("no Chrome for Testing");
const outdir = join(mkdtempSync(join(tmpdir(), "tab-mcp-ext-")), "dist");
const built = await build({ outdir, minify: false });
if (built.id === undefined)
	throw new Error("no key: the hosted relay would refuse this build");
const browser = await Browser.launch(binary, { extension: outdir });
try {
	if (browser.extensionId !== built.id)
		throw new Error(`loaded as ${browser.extensionId}, expected ${built.id}`);
	const panel = await browser.newPage(
		`chrome-extension://${built.id}/sidepanel/index.html`,
		{ window: true },
	);
	await panel.waitFor(`document.getElementById("relay").value`);
	console.log(
		"relay:",
		await panel.eval(`document.getElementById("relay").value`),
	);
	await panel.click("#connect");
	const address = await panel.waitFor<string>(
		`document.getElementById("address").textContent`,
		20_000,
	);
	console.log(
		"state:",
		await panel.eval(`document.getElementById("state").textContent`),
	);
	console.log("address:", address);
	const code = await panel.waitFor<string>(
		`(document.body.innerText.match(/\\b\\d{3}\\s?\\d{3}\\b/) || [])[0]`,
		10_000,
	);
	console.log("pairing code shown:", Boolean(code));
} finally {
	await browser.close();
	rmSync(join(outdir, ".."), { recursive: true, force: true });
}
