/**
 * Shared, side-effect-free checks for the release workflow (DEC-055), plain
 * JavaScript so both Node (the signing and publishing jobs) and Bun (tests,
 * `scripts/npm-pack.ts`) load it.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync } from "node:fs";
import path from "node:path";

/** Where a tarball may be signed or published from. */
export const REPOSITORY = "https://github.com/ractive/tab-mcp";
export const WORKFLOW = ".github/workflows/release.yml";
/** Release tag prefix per published package name. */
export const TAG_PREFIXES = {
	"@ractive-ch/tab-mcp-client": "client-v",
	"@ractive-ch/tab-mcp": "relay-v",
};

export const REGISTRY = "https://registry.npmjs.org";

/**
 * The stdout of `npm view <what> <field> --json` against the public registry
 * (no local cache), or undefined when the package or version does not exist.
 * Throws when npm fails otherwise.
 */
export function npmView(what, field) {
	const r = spawnSync(
		"npm",
		["view", what, field, "--json", "--prefer-online", "--registry", REGISTRY],
		{ encoding: "utf8" },
	);
	if (r.status === 0) return r.stdout;
	if (/E404/.test(r.stderr + r.stdout)) return undefined;
	throw new Error(`npm view ${what} ${field} failed: ${r.stderr.trim()}`);
}

/** npm's `integrity` of a tarball's bytes: `sha512-<base64>`. */
export function integrityOf(bytes) {
	return `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
}

/**
 * The one `.tgz` in a directory; throws when there is none or more than
 * one (an empty or mixed artifact).
 */
export function findOneTarball(dir) {
	const tarballs = readdirSync(dir)
		.filter((f) => f.endsWith(".tgz"))
		.sort();
	if (tarballs.length !== 1) {
		throw new Error(
			`expected exactly one .tgz in ${dir}, found ${tarballs.length}${tarballs.length ? `: ${tarballs.join(", ")}` : ""}`,
		);
	}
	return path.join(dir, tarballs[0]);
}

const SEMVER =
	/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?$/;

/** Semver precedence: negative, zero or positive like a sort comparator. */
/**
 * The value of one field from `npm view <spec> <field> --json`: npm 11 prints
 * a JSON string, npm 12 a one-element array. Empty output means "not there".
 * More than one value is an error: the spec named several versions.
 */
export function viewValue(stdout) {
	const out = stdout.trim();
	if (out === "") return undefined;
	const value = JSON.parse(out);
	if (!Array.isArray(value)) return value;
	if (value.length === 0) return undefined;
	if (value.length === 1) return value[0];
	throw new Error(`npm view returned ${value.length} values, expected one`);
}

export function compareVersions(a, b) {
	const pa = SEMVER.exec(a);
	const pb = SEMVER.exec(b);
	if (!pa || !pb) throw new Error(`not a semver version: ${pa ? b : a}`);
	for (let i = 1; i <= 3; i++) {
		const d = Number(pa[i]) - Number(pb[i]);
		if (d !== 0) return Math.sign(d);
	}
	const ra = pa[4];
	const rb = pb[4];
	if (ra === undefined || rb === undefined) {
		// A version without a pre-release ranks above one with it.
		return ra === rb ? 0 : ra === undefined ? 1 : -1;
	}
	const ia = ra.split(".");
	const ib = rb.split(".");
	for (let i = 0; i < Math.max(ia.length, ib.length); i++) {
		const x = ia[i];
		const y = ib[i];
		if (x === undefined) return -1;
		if (y === undefined) return 1;
		const nx = /^\d+$/.test(x);
		const ny = /^\d+$/.test(y);
		if (nx && ny) {
			const d = Number(x) - Number(y);
			if (d !== 0) return Math.sign(d);
		} else if (nx !== ny) {
			return nx ? -1 : 1; // numeric identifiers rank lower
		} else if (x !== y) {
			return x < y ? -1 : 1;
		}
	}
	return 0;
}

/**
 * What the publishing job does with a checked tarball.
 *
 * - `published`: the registry's integrity of this version, or undefined;
 * - `latest`: the registry's current `latest` dist-tag, or undefined.
 *
 * Returns `{ action: "publish" | "skip" | "fail", message }`.
 */
export function publishDecision({
	spec,
	version,
	distTag,
	integrity,
	published,
	latest,
}) {
	if (published !== undefined) {
		if (published === integrity) {
			return {
				action: "skip",
				message: `${spec} is already published with the same bytes; skipped`,
			};
		}
		return {
			action: "fail",
			message: `${spec} is already published with other bytes (${published}); versions are immutable, release a new version`,
		};
	}
	if (
		distTag === "latest" &&
		latest !== undefined &&
		compareVersions(version, latest) < 0
	) {
		return {
			action: "fail",
			message: `${version} is lower than latest ${latest}; publishing it would move latest backwards`,
		};
	}
	return {
		action: "publish",
		message: `publish ${spec} with dist-tag ${distTag}`,
	};
}

/**
 * The list from `npm view <package> versions --json`: a JSON string for a
 * package with one version, an array otherwise (npm 12 may wrap it in a
 * one-element array). Empty output means no versions.
 */
export function viewList(stdout) {
	const out = stdout.trim();
	if (out === "") return [];
	let value = JSON.parse(out);
	if (Array.isArray(value) && value.length === 1 && Array.isArray(value[0]))
		value = value[0];
	if (typeof value === "string") return [value];
	if (!Array.isArray(value) || !value.every((v) => typeof v === "string"))
		throw new Error("npm view returned no list of versions");
	return value;
}

/**
 * Which moving tags the image of a published relay version gets, from npm's
 * state after the publication (or after it was skipped as identical):
 *
 * - `latest` only when the version is stable and not below npm's current
 *   `dist-tags.latest`;
 * - `X.Y` only when the version is stable and the highest stable version of
 *   that `X.Y` on npm.
 *
 * So re-running the publication of an old tag (relay-v1.0.5 after 1.1.0)
 * pushes `1.0.5` but moves neither tag backwards. `versions` may lag behind
 * the publication (registry caches); this version counts as published.
 *
 * Returns `{ latest: boolean, minor: string, moveMinor: boolean, message }`.
 */
export function imageTagDecision({ version, distTag, latest, versions }) {
	const parsed = SEMVER.exec(version);
	if (!parsed) throw new Error(`not a semver version: ${version}`);
	const minor = `${parsed[1]}.${parsed[2]}`;
	if (distTag !== "latest" || parsed[4] !== undefined) {
		return {
			latest: false,
			minor,
			moveMinor: false,
			message: `${version} is a pre-release: only its own tag`,
		};
	}
	if (latest === undefined)
		throw new Error(
			"npm has no latest dist-tag for a published stable version",
		);
	const moveLatest = compareVersions(version, latest) >= 0;
	const higher = versions.filter((v) => {
		const p = SEMVER.exec(v);
		return (
			p !== null &&
			p[4] === undefined &&
			`${p[1]}.${p[2]}` === minor &&
			compareVersions(v, version) > 0
		);
	});
	const moveMinor = higher.length === 0;
	const notes = [
		moveLatest
			? `latest (npm latest is ${latest})`
			: `not latest: npm latest is ${latest}`,
		moveMinor
			? `${minor} (highest ${minor}.x)`
			: `not ${minor}: npm has ${higher.sort(compareVersions).at(-1)}`,
	];
	return {
		latest: moveLatest,
		minor,
		moveMinor,
		message: `${version}: ${notes.join("; ")}`,
	};
}

/**
 * Problems with the build a provenance statement names: it must come from
 * this repository's release workflow on `main` or on the release tag of this
 * very version (`refs/tags/client-v0.1.0`). `allowRef` accepts one other ref
 * explicitly.
 */
export function signerProblems(statement, manifest, allowRef) {
	const build = statement?.predicate?.buildDefinition;
	const workflow = build?.externalParameters?.workflow;
	const problems = [];
	if (workflow?.repository !== REPOSITORY)
		problems.push(
			`repository is ${workflow?.repository}, expected ${REPOSITORY}`,
		);
	if (workflow?.path !== WORKFLOW)
		problems.push(`workflow is ${workflow?.path}, expected ${WORKFLOW}`);
	const ref = workflow?.ref;
	const prefix = TAG_PREFIXES[manifest.name];
	const tagRef =
		prefix === undefined ? undefined : `refs/tags/${prefix}${manifest.version}`;
	const allowed =
		ref === "refs/heads/main" ||
		(tagRef !== undefined && ref === tagRef) ||
		(allowRef !== undefined && ref === allowRef);
	if (!allowed)
		problems.push(
			`ref is ${ref}, expected refs/heads/main or ${tagRef ?? "a release tag"}`,
		);
	return problems;
}
