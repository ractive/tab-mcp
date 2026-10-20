import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	compareVersions,
	findOneTarball,
	imageTagDecision,
	integrityOf,
	publishDecision,
	signerProblems,
	viewList,
	viewValue,
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

describe("viewValue", () => {
	test("npm 11 prints a string, npm 12 a one-element array; both give the value", () => {
		expect(viewValue('"sha512-AAA"\n')).toBe("sha512-AAA");
		expect(viewValue('[\n  "sha512-AAA"\n]\n')).toBe("sha512-AAA");
	});
	test("empty output and an empty array mean not there", () => {
		expect(viewValue("")).toBeUndefined();
		expect(viewValue("[]")).toBeUndefined();
	});
	test("several values are refused", () => {
		expect(() => viewValue('["1.0.0","1.0.1"]')).toThrow("2 values");
	});
});

test("the relay is signed from main or its own relay-v tag", () => {
	const relay = { name: "@ractive-ch/tab-mcp", version: "0.1.0-alpha.0" };
	expect(signerProblems(statement("refs/heads/main"), relay)).toEqual([]);
	expect(
		signerProblems(statement("refs/tags/relay-v0.1.0-alpha.0"), relay),
	).toEqual([]);
	expect(
		signerProblems(statement("refs/tags/client-v0.1.0-alpha.0"), relay).join(),
	).toContain("refs/tags/relay-v0.1.0-alpha.0");
});

describe("viewList", () => {
	test("one version is a string, several an array, npm 12 may wrap it", () => {
		expect(viewList('"1.0.0"')).toEqual(["1.0.0"]);
		expect(viewList('["1.0.0","1.0.1"]')).toEqual(["1.0.0", "1.0.1"]);
		expect(viewList('[["1.0.0","1.0.1"]]')).toEqual(["1.0.0", "1.0.1"]);
		expect(viewList("")).toEqual([]);
		expect(() => viewList("{}")).toThrow();
	});
});

describe("imageTagDecision", () => {
	const versions = ["1.0.4", "1.0.5", "1.1.0-rc.1", "1.1.0"];
	test("a new highest stable version moves latest and X.Y", () => {
		const d = imageTagDecision({
			version: "1.2.0",
			distTag: "latest",
			latest: "1.2.0",
			versions: [...versions, "1.2.0"],
		});
		expect([d.latest, d.minor, d.moveMinor]).toEqual([true, "1.2", true]);
	});
	test("re-running an old tag after a newer release moves neither", () => {
		// relay-v1.0.5 re-run after 1.1.0: npm skipped it as identical.
		const old = imageTagDecision({
			version: "1.0.5",
			distTag: "latest",
			latest: "1.1.0",
			versions: [...versions, "1.0.6"],
		});
		expect([old.latest, old.moveMinor]).toEqual([false, false]);
		expect(old.message).toContain("npm has 1.0.6");
	});
	test("a patch of an older line moves its X.Y but not latest", () => {
		const d = imageTagDecision({
			version: "1.0.6",
			distTag: "latest",
			latest: "1.1.0",
			versions: [...versions, "1.0.6"],
		});
		expect([d.latest, d.minor, d.moveMinor]).toEqual([false, "1.0", true]);
	});
	test("re-running the current latest keeps both", () => {
		const d = imageTagDecision({
			version: "1.1.0",
			distTag: "latest",
			latest: "1.1.0",
			versions,
		});
		expect([d.latest, d.moveMinor]).toEqual([true, true]);
	});
	test("pre-releases of the same X.Y do not block it; versions may lag", () => {
		const d = imageTagDecision({
			version: "1.3.0",
			distTag: "latest",
			latest: "1.1.0", // a cached packument from before the publication
			versions: [...versions, "1.3.1-rc.0"],
		});
		expect([d.latest, d.moveMinor]).toEqual([true, true]);
	});
	test("a pre-release moves no tag", () => {
		const d = imageTagDecision({
			version: "1.2.0-rc.1",
			distTag: "rc",
			latest: "1.1.0",
			versions,
		});
		expect([d.latest, d.moveMinor]).toEqual([false, false]);
	});
	test("a stable version without npm latest is an error", () => {
		expect(() =>
			imageTagDecision({
				version: "1.0.0",
				distTag: "latest",
				latest: undefined,
				versions: [],
			}),
		).toThrow("no latest");
	});
});
