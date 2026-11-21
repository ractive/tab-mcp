/**
 * The `exports` of the published package (`dist/package.json`), in one
 * place: `scripts/build.ts` writes them, and the release's tarball check
 * (`scripts/npm-pack.ts` at the root) is tested against them, so that a
 * new entry cannot be missing from one of the two (review of PR 181).
 */
export const PUBLISHED_EXPORTS = {
	".": { types: "./index.d.ts", default: "./index.js" },
	"./allowed": { types: "./allowed.d.ts", default: "./allowed.js" },
	"./extension": { types: "./extension.d.ts", default: "./extension.js" },
	"./react": { types: "./react.d.ts", default: "./react.js" },
	"./setup": { types: "./setup.d.ts", default: "./setup.js" },
	"./strings": { types: "./strings.d.ts", default: "./strings.js" },
	"./tunnel": { types: "./tunnel.d.ts", default: "./tunnel.js" },
	"./visible": { types: "./visible.d.ts", default: "./visible.js" },
	"./cdn": "./cdn/tab-mcp-client.min.js",
	"./cdn/allowed": "./cdn/allowed.min.js",
	"./cdn/strings": "./cdn/strings.min.js",
} as const;
