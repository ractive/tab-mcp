/**
 * Renders the extension's icons into `assets/icons/` (committed) from the
 * relay's icon, `packages/tab-mcp/scripts/favicon.svg`, with ImageMagick
 * (`magick` on the PATH), as the relay's own `scripts/favicon.ts` does. Run
 * after changing the SVG:
 *
 *   bun scripts/icons.ts
 */

import { join } from "node:path";
import { $ } from "bun";

export const ICON_SIZES = [16, 32, 48, 128] as const;

const svg = join(import.meta.dir, "../../tab-mcp/scripts/favicon.svg");
const dir = join(import.meta.dir, "../assets/icons");

if (import.meta.main) {
	for (const size of ICON_SIZES)
		await $`magick -background none -density 600 ${svg} -resize ${size}x${size} -strip ${join(dir, `icon-${size}.png`)}`.quiet();
}
