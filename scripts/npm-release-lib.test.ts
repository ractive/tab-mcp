import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	compareVersions,
	findOneTarball,
	integrityOf,
	publishDecision,
	signerProblems,
} from "./npm-release-lib.mjs";

const tmp = mkdtempSync(join(tmpdir(), "npm-release-lib-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

test("semver precedence, pre-releases included", () => {
	const ordered = [
		"0.1.0-alpha.0",
		"0.1.0-alpha.1",
		"0.1.0-alpha.10",
		"0.1.0-alpha.beta",
		"0.1.0-beta.0",
		"0.1.0-rc.1",
		"0.1.0",
		"0.1.1",
		"0.2.0-alpha.0",
		"0.2.0",
		"1.0.0",
		"10.0.0",
	];
	for (let i = 0; i < ordered.length; i++) {
		for (let j = 0; j < ordered.length; j++) {
			expect(compareVersions(ordered[i] as string, ordered[j] as string)).toBe(
				Math.sign(i - j),
			);
		}
	}
	expect(compareVersions("1.0.0-alpha", "1.0.0-alpha.1")).toBe(-1);
	expect(() => compareVersions("1.0", "1.0.0")).toThrow();
});

const base = {
	spec: "@ractive-ch/tab-mcp-client@0.2.0",
	version: "0.2.0",
	distTag: "latest",
	integrity: "sha512-AAA",
	published: undefined,
	latest: undefined,
};

test("publish, skip identical bytes, refuse other bytes", () => {
	expect(publishDecision(base).action).toBe("publish");
	expect(publishDecision({ ...base, published: "sha512-AAA" }).action).toBe(
		"skip",
	);
	const other = publishDecision({ ...base, published: "sha512-BBB" });
	expect(other.action).toBe("fail");
	expect(other.message).toContain("immutable");
});

test("latest never moves backwards", () => {
	expect(publishDecision({ ...base, latest: "0.1.0-alpha.0" }).action).toBe(
		"publish",
	);
	expect(publishDecision({ ...base, latest: "0.1.5" }).action).toBe("publish");
	const back = publishDecision({ ...base, latest: "0.3.0" });
	expect(back.action).toBe("fail");
	expect(back.message).toContain("backwards");
	// Pre-releases go to their own tag; latest is not compared.
	expect(
		publishDecision({
			...base,
			version: "0.1.0-alpha.1",
			distTag: "alpha",
			latest: "0.3.0",
		}).action,
	).toBe("publish");
});

test("exactly one tarball, and its integrity is npm's", () => {
	const empty = join(tmp, "empty");
	mkdirSync(empty);
	expect(() => findOneTarball(empty)).toThrow("found 0");
	const two = join(tmp, "two");
	mkdirSync(two);
	writeFileSync(join(two, "a.tgz"), "a");
	writeFileSync(join(two, "b.tgz"), "b");
	expect(() => findOneTarball(two)).toThrow("found 2: a.tgz, b.tgz");
	const one = join(tmp, "one");
	mkdirSync(one);
	writeFileSync(join(one, "pack.json"), "{}");
	writeFileSync(join(one, "x.tgz"), "hello");
	expect(findOneTarball(one)).toBe(join(one, "x.tgz"));
	// sha512("hello"), as `npm pack` reports integrity
	expect(integrityOf(Buffer.from("hello"))).toBe(
		"sha512-m3HSJL1i83hdltRq0+o9czGb+8KJDKra4t/3JRlnPKcjI8PZm6XBHXx6zG4UuMXaDEZjR1wuXDre9G9zvN7AQw==",
	);
});

const manifest = { name: "@ractive-ch/tab-mcp-client", version: "0.1.0" };
const statement = (
	ref: string,
	repository = "https://github.com/ractive/tab-mcp",
	path = ".github/workflows/release.yml",
) => ({
	predicate: {
		buildDefinition: {
			externalParameters: { workflow: { repository, path, ref } },
		},
	},
});

test("only the release workflow on main or the version's tag may sign", () => {
	expect(signerProblems(statement("refs/heads/main"), manifest)).toEqual([]);
	expect(
		signerProblems(statement("refs/tags/client-v0.1.0"), manifest),
	).toEqual([]);
	expect(
		signerProblems(statement("refs/tags/client-v0.0.9"), manifest).join(),
	).toContain("refs/tags/client-v0.1.0");
	expect(
		signerProblems(statement("refs/heads/iter-5a/x"), manifest),
	).toHaveLength(1);
	expect(
		signerProblems(
			statement("refs/heads/iter-5a/x"),
			manifest,
			"refs/heads/iter-5a/x",
		),
	).toEqual([]);
	expect(
		signerProblems(
			statement("refs/heads/main", "https://github.com/evil/tab-mcp"),
			manifest,
		).join(),
	).toContain("repository");
	expect(
		signerProblems(
			statement("refs/heads/main", undefined, ".github/workflows/other.yml"),
			manifest,
		).join(),
	).toContain("workflow");
	expect(signerProblems({}, manifest)).toHaveLength(3);
});
