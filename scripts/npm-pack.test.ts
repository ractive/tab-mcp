import { expect, test } from "bun:test";
import { PUBLISHED_EXPORTS } from "../packages/tab-mcp-client/scripts/published-exports.ts";
import {
	checkManifest,
	distTag,
	normalizeChunk,
	PACKAGES,
} from "./npm-pack.ts";

test("the tarball check expects the client's exports its build publishes (review of PR 181)", () => {
	expect(PACKAGES["client"]?.exports).toEqual(PUBLISHED_EXPORTS);
	// Every entry's file and its source map are expected in the tarball too.
	const files = new Set(PACKAGES["client"]?.files);
	for (const target of Object.values(PUBLISHED_EXPORTS)) {
		const js = (typeof target === "string" ? target : target.default).slice(2);
		expect([files.has(js), files.has(`${js}.map`)]).toEqual([true, true]);
	}
});

test("pre-releases never go to latest", () => {
	expect(distTag("0.1.0-alpha.0")).toBe("alpha");
	expect(distTag("1.2.0-beta.3")).toBe("beta");
	expect(distTag("1.2.0-rc.1")).toBe("rc");
	expect(distTag("0.1.0")).toBe("latest");
	expect(() => distTag("0.1.0-next.1")).toThrow();
	expect(() => distTag("v0.1.0")).toThrow();
	expect(() => distTag("0.1")).toThrow();
});

test("chunk hashes are normalised, other names kept", () => {
	expect(normalizeChunk("connection-1gf7vqz2.js")).toBe("connection-[hash].js");
	expect(normalizeChunk("cdn/ui-aac2cw9f.min.js.map")).toBe(
		"cdn/ui-[hash].min.js.map",
	);
	expect(normalizeChunk("cdn/tab-mcp-client.min.js")).toBe(
		"cdn/tab-mcp-client.min.js",
	);
	expect(normalizeChunk("THIRD-PARTY-NOTICES.txt")).toBe(
		"THIRD-PARTY-NOTICES.txt",
	);
});

test("the manifest check names what is wrong", () => {
	const spec = PACKAGES["client"];
	if (spec === undefined) throw new Error("no client spec");
	const good = {
		name: spec.name,
		version: "0.1.0-alpha.0",
		type: "module",
		license: "MIT",
		exports: spec.exports,
		types: spec.types,
		publishConfig: { access: "public" },
		repository: {
			type: "git",
			url: "git+https://github.com/ractive/tab-mcp.git",
			directory: spec.workspace,
		},
		dependencies: { "@cfworker/json-schema": "4.1.4" },
		peerDependencies: { react: ">=18.3.0 <20" },
		peerDependenciesMeta: { react: { optional: true } },
	};
	expect(checkManifest(good, spec, "0.1.0-alpha.0")).toEqual([]);
	// React is an optional peer with the tested range.
	const required = checkManifest(
		{ ...good, peerDependenciesMeta: undefined },
		spec,
		"0.1.0-alpha.0",
	).join("\n");
	expect(required).toContain("peerDependenciesMeta");
	const wider = checkManifest(
		{ ...good, peerDependencies: { react: "*" } },
		spec,
		"0.1.0-alpha.0",
	).join("\n");
	expect(wider).toContain("peerDependencies");
	const bad = {
		...good,
		private: true,
		repository: { url: "https://github.com/ractive/tab-mcp" },
		dependencies: { "@ractive-ch/tab-mcp": "workspace:*" },
		publishConfig: undefined,
	};
	const problems = checkManifest(bad, spec, "0.1.0").join("\n");
	expect(problems).toContain("version");
	expect(problems).toContain("private");
	expect(problems).toContain("repository.url");
	expect(problems).toContain("repository.directory");
	expect(problems).toContain("workspace:*");
	expect(problems).toContain("publishConfig");
});

test("the relay's manifest needs its bin and both exports", () => {
	const spec = PACKAGES["relay"];
	if (spec === undefined) throw new Error("no relay spec");
	const good = {
		name: "@ractive-ch/tab-mcp",
		version: "0.1.0-alpha.0",
		type: "module",
		license: "MIT",
		bin: { "tab-mcp": "./main.js" },
		exports: spec.exports,
		types: "./index.d.ts",
		publishConfig: { access: "public" },
		repository: {
			type: "git",
			url: "git+https://github.com/ractive/tab-mcp.git",
			directory: "packages/tab-mcp",
		},
	};
	expect(checkManifest(good, spec, "0.1.0-alpha.0")).toEqual([]);
	const problems = checkManifest(
		{
			...good,
			bin: { "tab-mcp": "./src/main.ts" },
			exports: { ".": "./index.js" },
		},
		spec,
		"0.1.0-alpha.0",
	).join("\n");
	expect(problems).toContain("bin");
	expect(problems).toContain("exports");
});
