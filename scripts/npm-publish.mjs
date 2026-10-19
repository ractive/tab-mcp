/**
 * The release workflow's publishing step (DEC-055). Runs on Node in the job
 * that holds the OIDC token:
 *
 *   node scripts/npm-publish.mjs <dir> --integrity <sha512-…> --version <v> --dist-tag <tag>
 *
 * Takes the one `.tgz` in `<dir>`, checks its bytes against the integrity the
 * packing job checked, asks the registry for this version and for `latest`,
 * then publishes with provenance, skips an identical published version, or
 * fails (other bytes already published, or `latest` would move backwards).
 */

import { execFileSync, spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import {
	findOneTarball,
	integrityOf,
	publishDecision,
	viewValue,
} from "./npm-release-lib.mjs";

const REGISTRY = "https://registry.npmjs.org";

function fail(message) {
	console.error(`::error::${message}`);
	process.exit(1);
}

const { values, positionals } = parseArgs({
	allowPositionals: true,
	options: {
		integrity: { type: "string" },
		version: { type: "string" },
		"dist-tag": { type: "string" },
	},
});
const { integrity, version } = values;
const distTag = values["dist-tag"];
if (positionals.length !== 1 || !integrity || !version || !distTag)
	fail(
		"usage: node scripts/npm-publish.mjs <dir> --integrity <sha512-…> --version <v> --dist-tag <tag>",
	);

let tarball;
try {
	tarball = findOneTarball(positionals[0]);
} catch (error) {
	fail(error.message);
}
const actual = integrityOf(await readFile(tarball));
if (actual !== integrity)
	fail(`${tarball} is ${actual}, not the checked ${integrity}`);
const manifest = JSON.parse(
	execFileSync("tar", ["-xzOf", tarball, "package/package.json"], {
		encoding: "utf8",
	}),
);
if (manifest.version !== version)
	fail(`the tarball holds ${manifest.version}, not ${version}`);
const spec = `${manifest.name}@${version}`;

/** A registry field, or undefined when the package or version does not exist. */
function view(what, field) {
	const r = spawnSync(
		"npm",
		["view", what, field, "--json", "--registry", REGISTRY],
		{ encoding: "utf8" },
	);
	if (r.status === 0) {
		try {
			return viewValue(r.stdout);
		} catch (error) {
			fail(`npm view ${what} ${field}: ${error.message}`);
		}
	}
	if (/E404/.test(r.stderr + r.stdout)) return undefined;
	process.stderr.write(r.stderr);
	fail(`npm view ${what} ${field} failed`);
}

const decision = publishDecision({
	spec,
	version,
	distTag,
	integrity: actual,
	published: view(spec, "dist.integrity"),
	latest: view(manifest.name, "dist-tags.latest"),
});
console.log(decision.message);
if (decision.action === "fail") fail(decision.message);
if (decision.action === "skip") {
	console.log(`::notice::${decision.message}`);
	process.exit(0);
}
const publish = spawnSync(
	"npm",
	[
		"publish",
		tarball,
		"--provenance",
		"--access",
		"public",
		"--tag",
		distTag,
		"--ignore-scripts",
		"--registry",
		REGISTRY,
	],
	{ stdio: "inherit" },
);
if (publish.status !== 0) fail(`npm publish ${spec} failed`);
console.log(`::notice::published ${spec} with dist-tag ${distTag}`);
