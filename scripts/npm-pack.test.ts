import { expect, test } from "bun:test";
import {
	checkManifest,
	distTag,
	normalizeChunk,
	PACKAGES,
} from "./npm-pack.ts";

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
		dependencies: { "@cfworker/json-schema": "4.1.1" },
	};
	expect(checkManifest(good, spec, "0.1.0-alpha.0")).toEqual([]);
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
