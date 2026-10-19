/**
 * Sign or verify npm provenance for a packed tarball with npm's own code
 * (libnpmpublish inside the installed npm), for the bootstrap publication
 * (DEC-055, kb/operations/npm-publishing.md). Runs on Node, not Bun.
 *
 *   node scripts/npm-provenance.mjs sign <dir> --integrity <sha512-…>   # GitHub Actions only
 *   node scripts/npm-provenance.mjs verify <tarball> <bundle> [--allow-ref <ref>]
 *
 * `sign` needs `permissions: id-token: write`; it takes the one `.tgz` in
 * `<dir>`, checks its bytes against `--integrity`, writes
 * `<tarball without .tgz>.sigstore.json` next to it and verifies that.
 * `verify` runs the check `npm publish <tarball> --provenance-file <bundle>`
 * runs (subject name and digest, Sigstore signature and transparency log)
 * and then requires the signer to be this repository's release workflow on
 * `main` or on the version's release tag; `--allow-ref` accepts one other ref.
 */

import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { parseArgs } from "node:util";
import {
	findOneTarball,
	integrityOf,
	signerProblems,
} from "./npm-release-lib.mjs";

const usage =
	"usage: node scripts/npm-provenance.mjs sign <dir> --integrity <sha512-…> | verify <tarball> <bundle> [--allow-ref <ref>]";
function fail(message, code = 1) {
	console.error(`npm-provenance: ${message}`);
	process.exit(code);
}

const { values, positionals } = parseArgs({
	allowPositionals: true,
	options: {
		integrity: { type: "string" },
		"allow-ref": { type: "string" },
	},
});
const [command, ...rest] = positionals;
let tarball;
let bundlePath;
if (command === "sign" && rest.length === 1 && values.integrity) {
	try {
		tarball = findOneTarball(rest[0]);
	} catch (error) {
		fail(error.message);
	}
} else if (command === "verify" && rest.length === 2 && !values.integrity) {
	[tarball, bundlePath] = rest;
} else {
	fail(usage, 2);
}

const npmDir =
	process.env.NPM_PACKAGE_DIR ??
	path.join(
		execFileSync("npm", ["root", "--global"], { encoding: "utf8" }).trim(),
		"npm",
	);
const requireFromNpm = createRequire(path.join(npmDir, "package.json"));
const npmVersion = requireFromNpm("./package.json").version;
const npa = requireFromNpm("npm-package-arg");
const { generateProvenance, verifyProvenance } = requireFromNpm(
	"libnpmpublish/lib/provenance.js",
);

const manifest = JSON.parse(
	execFileSync("tar", ["-xzOf", tarball, "package/package.json"], {
		encoding: "utf8",
	}),
);
const integrity = integrityOf(await readFile(tarball));
const subject = {
	name: npa.toPurl(npa.resolve(manifest.name, manifest.version)),
	digest: {
		sha512: Buffer.from(integrity.slice("sha512-".length), "base64").toString(
			"hex",
		),
	},
};
console.log(`npm ${npmVersion}`);
console.log(`package ${manifest.name}@${manifest.version}`);
console.log(`integrity ${integrity}`);

if (command === "sign") {
	if (process.env.GITHUB_ACTIONS !== "true")
		fail("sign runs on GitHub Actions only (it needs the OIDC token)", 2);
	if (integrity !== values.integrity)
		fail(`the tarball's integrity is not the checked ${values.integrity}`);
	const bundle = await generateProvenance([subject], {});
	bundlePath = tarball.replace(/\.tgz$/, ".sigstore.json");
	await writeFile(bundlePath, `${JSON.stringify(bundle)}\n`, { flag: "wx" });
	console.log(`signed ${path.basename(bundlePath)}`);
}

let verified;
try {
	verified = await verifyProvenance(subject, bundlePath);
} catch (error) {
	fail(`provenance does not verify: ${error.message}`);
}
const statement = JSON.parse(
	Buffer.from(verified.dsseEnvelope.payload, "base64").toString("utf8"),
);
const build = statement.predicate?.buildDefinition;
const workflow = build?.externalParameters?.workflow;
const source = build?.resolvedDependencies?.[0];
console.log("provenance verified:");
console.log(`  repository ${workflow?.repository}`);
console.log(`  workflow   ${workflow?.path} @ ${workflow?.ref}`);
console.log(`  commit     ${source?.digest?.gitCommit}`);
console.log(
	`  run        ${statement.predicate?.runDetails?.metadata?.invocationId}`,
);
const tlog = verified.verificationMaterial?.tlogEntries?.[0];
if (tlog) {
	console.log(
		`  rekor      https://search.sigstore.dev/?logIndex=${tlog.logIndex}`,
	);
}
const problems = signerProblems(statement, manifest, values["allow-ref"]);
if (problems.length > 0) fail(`wrong signer: ${problems.join("; ")}`);
console.log("signer accepted");
