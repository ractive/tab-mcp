/**
 * The Chrome Web Store's promo tiles: small (440×280) and marquee
 * (1400×560), in the look of tab-mcp's card image on ractive.ch
 * (`static/images/tab-mcp-preview.svg` in ractive/ractive.ch, commit 7968c81):
 * its green, its wordmark and its drawing of a browser tab and an AI app
 * joined through the relay as the MCP logo. Drawn as SVG in Chrome for
 * Testing (`CHROME_PATH`, as for the end-to-end tests) and written as 24-bit
 * PNGs without alpha, as the store asks (ImageMagick, `magick` on the PATH).
 * Writes `assets/store/promo-*.png`; look at both before an upload.
 *
 *   bun scripts/promo.ts
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import { Browser, findChromeForTesting } from "../test/browser.ts";

const OUT = join(import.meta.dir, "../assets/store");
const GREEN = "#0c4733";
const CREAM = "#fffae3";
const MINT = "#a0d1bf";
const FONT = `font-family="'Helvetica Neue',Arial,sans-serif"`;

/**
 * The card image's drawing, as it is there (500×300 coordinates, about x 41
 * to 485 and y 113 to 250): the browser, the AI app with its chat bubble,
 * the MCP logo and the lines into it.
 */
const DRAWING = `
  <g transform="translate(41 138)">
    <path d="M4 16 Q9 16 11 10 L12 7 Q14 2 19 2 L42 2 Q47 2 49 7 L50 10 Q52 16 57 16 Z" fill="#fffae3" opacity="0.18"/>
    <path d="M52 16 Q58 16 60 9 L61 6 Q63 0 69 0 L119 0 Q125 0 127 6 L128 9 Q130 16 136 16 Z" fill="#fffae3"/>
    <circle cx="71" cy="8" r="3.5" fill="#ffb03a"/>
    <rect x="79" y="6" width="38" height="4" rx="2" fill="#0c4733" opacity="0.25"/>
    <rect y="14" width="140" height="100" rx="10" fill="#fffae3"/>
    <rect x="56" y="14" width="74" height="6" fill="#fffae3"/>
    <rect x="10" y="24" width="120" height="13" rx="6.5" fill="#0c4733" opacity="0.1"/>
    <rect x="17" y="28" width="6" height="5" rx="1" fill="#0c4733" opacity="0.35"/>
    <path d="M18 28.5 v-1.5 a2 2 0 0 1 4 0 v1.5" fill="none" stroke="#0c4733" stroke-opacity="0.35" stroke-width="1.2"/>
    <g fill="#0c4733" opacity="0.13">
      <rect x="12" y="48" width="66" height="9" rx="4.5"/>
      <rect x="12" y="64" width="116" height="6" rx="3"/>
    </g>
    <rect x="12" y="82" width="62" height="18" rx="9" fill="#0c4733"/>
    <rect x="22" y="89" width="42" height="4" rx="2" fill="#fffae3" opacity="0.8"/>
  </g>
  <g transform="translate(354.9 143)">
    <rect width="104" height="104" rx="25" fill="#ffb03a"/>
    <path d="M52 17 Q56 48 87 52 Q56 56 52 87 Q48 56 17 52 Q48 48 52 17 Z" fill="#fffae3"/>
    <path d="M81 15 Q82.5 24 91 25.5 Q82.5 27 81 36 Q79.5 27 71 25.5 Q79.5 24 81 15 Z" fill="#fffae3"/>
  </g>
  <g transform="translate(424.9 113)">
    <path d="M0 13 Q0 0 13 0 L47 0 Q60 0 60 13 Q60 26 47 26 L22 26 L10 36 L12 25 Q0 23 0 13 Z" fill="#fffae3"/>
    <g fill="#0c4733" opacity="0.35">
      <circle cx="18" cy="13" r="3.5"/>
      <circle cx="30" cy="13" r="3.5"/>
      <circle cx="42" cy="13" r="3.5"/>
    </g>
  </g>
  <g transform="translate(209.3 133.8) scale(0.6)" fill="none" stroke="#a0d1bf" stroke-width="11" stroke-linecap="round" stroke-linejoin="round">
    <path d="M25 97.85L92.88 29.97C102.26 20.6 117.45 20.6 126.82 29.97C136.2 39.34 136.2 54.54 126.82 63.91L75.56 115.18"/>
    <path d="M76.27 114.47L126.82 63.91C136.2 54.54 151.39 54.54 160.77 63.91L161.12 64.27C170.49 73.64 170.49 88.83 161.12 98.21L99.72 159.6C96.6 162.72 96.6 167.79 99.72 170.91L112.33 183.52"/>
    <path d="M109.85 46.94L59.65 97.15C50.28 106.52 50.28 121.71 59.65 131.09C69.02 140.46 84.22 140.46 93.59 131.09L143.79 80.88"/>
  </g>
  <g fill="none" stroke="#a0d1bf" stroke-width="6.6" stroke-linecap="round" stroke-linejoin="round">
    <path d="M175.0 147.0 199.0 147.0 224.3 192.5"/>
    <path d="M276.7 243.9 292.7 243.9 321.6 215.0 349.9 215.0"/>
  </g>
  <circle cx="211.7" cy="169.8" r="4" fill="#ffb03a"/>
  <circle cx="335.8" cy="215" r="4" fill="#ffb03a"/>`;

const BACKGROUND = `<defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${GREEN}"/><stop offset="1" stop-color="#165a42"/></linearGradient></defs>`;

const LINE = "let your AI app use the tab in front";

interface Tile {
	name: string;
	width: number;
	height: number;
	/** The tile in the card's units: its viewBox and what is drawn in it. */
	viewBox: [number, number];
	body: string;
}

const TILES: Tile[] = [
	{
		// The card itself, a little taller (440×280 is 1.57:1, the card 1.67:1).
		name: "promo-small",
		width: 440,
		height: 280,
		viewBox: [500, 318],
		body: `
  <text x="40" y="74" ${FONT} font-weight="800" font-size="50" letter-spacing="-1.4" fill="${CREAM}">tab-mcp<tspan dx="12" font-weight="600" font-size="30" letter-spacing="0" fill="${MINT}">extension</tspan></text>
  <text x="42" y="106" ${FONT} font-weight="600" font-size="21" letter-spacing="0.2" fill="${MINT}">${LINE}</text>
  <g transform="translate(0 16)">${DRAWING}</g>`,
	},
	{
		// The wordmark on the left, the drawing on the right (2.5:1).
		name: "promo-marquee",
		width: 1400,
		height: 560,
		viewBox: [1000, 400],
		body: `
  <text x="64" y="172" ${FONT} font-weight="800" font-size="88" letter-spacing="-2.4" fill="${CREAM}">tab-mcp</text>
  <text x="68" y="226" ${FONT} font-weight="600" font-size="44" fill="${MINT}">browser extension</text>
  <text x="68" y="276" ${FONT} font-weight="600" font-size="21" letter-spacing="0.2" fill="${MINT}">${LINE}</text>
  <g transform="translate(441 9.4) scale(1.05)">${DRAWING}</g>`,
	},
];

function page(tile: Tile): string {
	const [w, h] = tile.viewBox;
	return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><style>html, body { margin: 0; overflow: hidden; } svg { display: block; }</style></head>
<body><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${tile.width}" height="${tile.height}">
  ${BACKGROUND}
  <rect width="${w}" height="${h}" fill="url(#bg)"/>${tile.body}
</svg></body>
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
		await $`magick ${raw} -background ${GREEN} -alpha remove -alpha off -strip PNG24:${out}`.quiet();
		console.log(`wrote assets/store/${tile.name}.png`);
	}
} finally {
	await browser?.close();
	rmSync(dir, { recursive: true, force: true });
}
