/**
 * The Chrome Web Store's promo tiles: small (440×280) and marquee
 * (1400×560), drawn as HTML in Chrome for Testing (`CHROME_PATH`, as for the
 * end-to-end tests) and written as 24-bit PNGs without alpha, as the store
 * asks (ImageMagick, `magick` on the PATH). The icon's blue, the icon with
 * its colours swapped, the name and one line: the image guidelines ask for
 * little text and no screenshots. Writes `assets/store/promo-*.png`; look at
 * both before an upload.
 *
 *   bun scripts/promo.ts
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import { Browser, findChromeForTesting } from "../test/browser.ts";

const OUT = join(import.meta.dir, "../assets/store");
const BLUE = "#1d4ed8";

/** The relay's icon (`favicon.svg`) with its colours swapped: blue on white. */
const ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#fff"/><path d="M32 22l3.4-7A3.5 3.5 0 0 1 38.6 13h9.8a3.5 3.5 0 0 1 3.2 2l3.4 7z" fill="${BLUE}" fill-opacity=".45"/><path d="M9 49V26a5 5 0 0 1 5-5h.5l3.7-7.4A3.5 3.5 0 0 1 21.3 12h9.4a3.5 3.5 0 0 1 3.1 1.6L37.5 21H50a5 5 0 0 1 5 5v23a5 5 0 0 1-5 5H14a5 5 0 0 1-5-5z" fill="${BLUE}"/><rect x="22" y="35.5" width="20" height="5" fill="#fff"/><circle cx="21" cy="38" r="6" fill="#fff"/><circle cx="43" cy="38" r="6" fill="#fff"/></svg>`;

const LINE = "Let your AI app use the tab in front";

interface Tile {
	name: string;
	width: number;
	height: number;
	/** The icon's side, the name's and the line's font size, in px. */
	icon: number;
	title: number;
	line: number;
	/** The steps under the line (marquee only). */
	steps?: string[];
}

const TILES: Tile[] = [
	{
		name: "promo-small",
		width: 440,
		height: 280,
		icon: 76,
		title: 34,
		line: 17,
	},
	{
		name: "promo-marquee",
		width: 1400,
		height: 560,
		icon: 168,
		title: 76,
		line: 34,
		steps: ["AI app", "tab-mcp relay", "Page tools"],
	},
];

function page(tile: Tile): string {
	const steps = tile.steps
		?.map((s) => `<span class="step">${s}</span>`)
		.join('<span class="arrow">→</span>');
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<style>
	html, body { margin: 0; width: ${tile.width}px; height: ${tile.height}px; overflow: hidden; }
	body {
		display: flex; align-items: center; justify-content: center; gap: ${tile.icon * 0.32}px;
		background: radial-gradient(circle at 18% 20%, #3b6cf0 0%, ${BLUE} 45%, #1e3a8a 100%);
		color: #fff; font-family: -apple-system, BlinkMacSystemFont, "Helvetica Neue", sans-serif;
	}
	.icon { width: ${tile.icon}px; height: ${tile.icon}px; flex: none; filter: drop-shadow(0 ${tile.icon * 0.06}px ${tile.icon * 0.12}px rgb(15 23 42 / 0.35)); }
	h1 { margin: 0; font-size: ${tile.title}px; font-weight: 700; letter-spacing: -0.02em; line-height: 1.05; }
	p { margin: ${tile.line * 0.45}px 0 0; font-size: ${tile.line}px; font-weight: 500; opacity: 0.92; }
	.steps { margin-top: ${tile.line * 1.1}px; display: flex; align-items: center; gap: ${tile.line * 0.5}px; font-size: ${tile.line * 0.72}px; font-weight: 600; }
	.step { padding: ${tile.line * 0.28}px ${tile.line * 0.6}px; border-radius: 999px; background: rgb(255 255 255 / 0.16); border: 1px solid rgb(255 255 255 / 0.35); }
	.arrow { opacity: 0.8; }
</style>
</head>
<body>
	<div class="icon">${ICON}</div>
	<div>
		<h1>tab-mcp<br>for Chrome</h1>
		<p>${LINE}</p>
		${steps === undefined ? "" : `<div class="steps">${steps}</div>`}
	</div>
</body>
</html>`;
}

const chrome = findChromeForTesting();
if (chrome === undefined)
	throw new Error("Chrome for Testing is needed: set CHROME_PATH");

const dir = mkdtempSync(join(tmpdir(), "tab-mcp-promo-"));
let browser: Browser | undefined;
try {
	browser = await Browser.launch(chrome, {
		serve: (url) => {
			const tile = TILES.find((t) => url === `https://promo.test/${t.name}`);
			return tile === undefined
				? { status: 404, body: "not found" }
				: {
						status: 200,
						headers: { "content-type": "text/html; charset=utf-8" },
						body: page(tile),
					};
		},
	});
	for (const tile of TILES) {
		const tab = await browser.newPage(`https://promo.test/${tile.name}`, {
			window: true,
		});
		await tab.send("Emulation.setDeviceMetricsOverride", {
			width: tile.width,
			height: tile.height,
			deviceScaleFactor: 1,
			mobile: false,
		});
		await tab.send("Emulation.setScrollbarsHidden", { hidden: true });
		await Bun.sleep(300);
		const { data } = (await tab.send("Page.captureScreenshot", {
			format: "png",
		})) as { data: string };
		const raw = join(dir, `${tile.name}.png`);
		await Bun.write(raw, Buffer.from(data, "base64"));
		// 24-bit, no alpha channel.
		const out = join(OUT, `${tile.name}.png`);
		await $`magick ${raw} -background ${BLUE} -alpha remove -alpha off -strip PNG24:${out}`.quiet();
		console.log(`wrote assets/store/${tile.name}.png`);
	}
} finally {
	await browser?.close();
	rmSync(dir, { recursive: true, force: true });
}
