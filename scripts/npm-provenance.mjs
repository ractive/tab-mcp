/**
 * Sign or verify npm provenance for a packed tarball with npm's own code
 * (libnpmpublish inside the installed npm), for the bootstrap publication
 * (DEC-055, kb/operations/npm-publishing.md). Runs on Node, not Bun.
 *
 *   node scripts/npm-provenance.mjs sign <tarball>            # GitHub Actions only
 *   node scripts/npm-provenance.mjs verify <tarball> <bundle>
 *
 * `sign` needs `permissions: id-token: write`; it writes
 * `<tarball without .tgz>.sigstore.json` next to the tarball and verifies it.
 * `verify` runs the check `npm publish <tarball> --provenance-file <bundle>`
 * runs (subject name and digest, Sigstore signature and transparency log)
 * and prints where the bundle says the tarball was built.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

const [command, tarball, bundleArg] = process.argv.slice(2);
if (
	!tarball?.endsWith(".tgz") ||
	!(
		(command === "sign" && bundleArg === undefined) ||
		(command === "verify" && bundleArg !== undefined)
	)
) {
	console.error(
		"usage: node scripts/npm-provenance.mjs sign <tarball> | verify <tarball> <bundle>",
	);
	process.exit(2);
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
const digest = createHash("sha512")
	.update(await readFile(tarball))
	.digest();
const subject = {
	name: npa.toPurl(npa.resolve(manifest.name, manifest.version)),
	digest: { sha512: digest.toString("hex") },
};
console.log(`npm ${npmVersion}`);
console.log(`package ${manifest.name}@${manifest.version}`);
console.log(`integrity sha512-${digest.toString("base64")}`);

let bundlePath = bundleArg;
if (command === "sign") {
	if (process.env.GITHUB_ACTIONS !== "true") {
		console.error("sign runs on GitHub Actions only (it needs the OIDC token)");
		process.exit(2);
	}
	const bundle = await generateProvenance([subject], {});
	bundlePath = tarball.replace(/\.tgz$/, ".sigstore.json");
	await writeFile(bundlePath, `${JSON.stringify(bundle)}\n`, { flag: "wx" });
	console.log(`signed ${path.basename(bundlePath)}`);
}

const verified = await verifyProvenance(subject, bundlePath);
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
