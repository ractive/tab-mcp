/**
 * The release workflow's image-tag step (DEC-069). Runs after the relay's
 * npm publication succeeded or was skipped as identical:
 *
 *   node scripts/image-tags.mjs --package <name> --version <v> --dist-tag <tag>
 *
 * Asks the registry for `dist-tags.latest` and all versions, and writes
 * `latest`, `minor` and `move_minor` to `$GITHUB_OUTPUT` (stdout without
 * it): the image gets `latest` only when the version is not below npm's
 * `latest`, and `X.Y` only when it is the highest stable `X.Y.*` on npm.
 */

import { appendFileSync } from "node:fs";
import { parseArgs } from "node:util";
import {
	imageTagDecision,
	npmView,
	viewList,
	viewValue,
} from "./npm-release-lib.mjs";

function fail(message) {
	console.error(`::error::${message}`);
	process.exit(1);
}

const { values } = parseArgs({
	options: {
		package: { type: "string" },
		version: { type: "string" },
		"dist-tag": { type: "string" },
	},
});
const name = values.package;
const { version } = values;
const distTag = values["dist-tag"];
if (!name || !version || !distTag)
	fail(
		"usage: node scripts/image-tags.mjs --package <name> --version <v> --dist-tag <tag>",
	);

let decision;
try {
	const latest = npmView(name, "dist-tags.latest");
	const versions = npmView(name, "versions");
	decision = imageTagDecision({
		version,
		distTag,
		latest: latest === undefined ? undefined : viewValue(latest),
		versions: versions === undefined ? [] : viewList(versions),
	});
} catch (error) {
	fail(error.message);
}
console.log(decision.message);
const lines = `latest=${decision.latest}\nminor=${decision.minor}\nmove_minor=${decision.moveMinor}\n`;
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, lines);
else process.stdout.write(lines);
