/**
 * Renders the extension's icons into `assets/icons/` (committed) from the
 * relay's icon, `packages/tab-mcp/scripts/favicon.svg`, with ImageMagick
 * (`magick` on the PATH), as the relay's own `scripts/favicon.ts` does, and
 * the Chrome Web Store's icon into `assets/store/icon-128.png`: 128×128 with
 * the icon at 96×96 and 16 px transparent on each side, as the store's image
 * guidelines ask (the toolbar's icons fill their square). Run after changing
 * the SVG:
 *
 *   bun scripts/icons.ts
 */

import { join } from "node:path";
import { $ } from "bun";

export const ICON_SIZES = [16, 32, 48, 128] as const;

const svg = join(import.meta.dir, "../../tab-mcp/scripts/favicon.svg");
const dir = join(import.meta.dir, "../assets/icons");
const storeIcon = join(import.meta.dir, "../assets/store/icon-128.png");

if (import.meta.main) {
	for (const size of ICON_SIZES)
		await $`magick -background none -density 600 ${svg} -resize ${size}x${size} -strip ${join(dir, `icon-${size}.png`)}`.quiet();
	await $`magick -background none -density 600 ${svg} -resize 96x96 -gravity center -extent 128x128 -strip ${storeIcon}`.quiet();
}
