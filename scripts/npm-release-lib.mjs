/**
 * Shared, side-effect-free checks for the release workflow (DEC-055), plain
 * JavaScript so both Node (the signing and publishing jobs) and Bun (tests,
 * `scripts/npm-pack.ts`) load it.
 */

import { createHash } from "node:crypto";
import { readdirSync } from "node:fs";
import path from "node:path";

/** Where a tarball may be signed or published from. */
export const REPOSITORY = "https://github.com/ractive/tab-mcp";
export const WORKFLOW = ".github/workflows/release.yml";
/** Release tag prefix per published package name. */
export const TAG_PREFIXES = {
	"@ractive-ch/tab-mcp-client": "client-v",
};

/** npm's `integrity` of a tarball's bytes: `sha512-<base64>`. */
export function integrityOf(bytes) {
	return `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
}

/**
 * The one `.tgz` in a directory; throws when there is none or more than
 * one (an empty or mixed artifact).
 */
export function findOneTarball(dir) {
	const tarballs = readdirSync(dir).filter((f) => f.endsWith(".tgz"));
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
