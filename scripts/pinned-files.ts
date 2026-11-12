/**
 * Docs and plugin manifests that pin a package version, paths from the
 * repository root. The test "docs and plugin manifests name only the current
 * package versions" (packages/tab-mcp-client/test/build.test.ts) checks them,
 * and `scripts/bump-version.ts` rewrites them.
 */
export const PINNED_FILES: readonly string[] = [
	"README.md",
	"SECURITY.md",
	"packages/tab-mcp/README.md",
	"packages/tab-mcp-client/README.md",
	"test/e2e/README.md",
	"docs/protocol.md",
	"docs/self-hosting.md",
	"docs/threat-model.md",
	"docs/token-store.md",
	"plugins/tab-mcp/README.md",
	"plugins/tab-mcp/skills/tab-mcp/SKILL.md",
	"plugins/tab-mcp/.claude-plugin/plugin.json",
	"plugins/tab-mcp/.codex-plugin/plugin.json",
	".claude-plugin/marketplace.json",
];

/** The plugin manifests, whose version follows the client's. */
export const PLUGIN_MANIFESTS: readonly string[] = PINNED_FILES.filter((f) =>
	f.endsWith(".json"),
);
