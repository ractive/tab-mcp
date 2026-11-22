/**
 * The source archive addons.mozilla.org's reviewers build the Firefox zip
 * from (DEC-195), and the proof that it builds the same bytes:
 *
 *   bun scripts/source-archive.ts [--commit <sha>] [--built]
 *
 * Packs `tab-mcp-<version>-source.zip` next to `package.json`: `git archive`
 * of the commit (default HEAD) under `tab-mcp-<version>/`, plus a file
 * `SOURCE_DATE_EPOCH` with the commit's time, which the zip's entries carry
 * (the archive has no Git history for `sourceDate` in build.ts). Then it
 * follows the reviewers' notes in an empty directory (unzip,
 * `bun install --frozen-lockfile`, the Firefox store build with that epoch)
 * and fails unless that zip is byte for byte this checkout's
 * `tab-mcp-browser-extension-firefox-<version>-store.zip`: the one a step
 * before built (`--built`, the release's build job), else one it builds here
 * first, from a clean checkout of that commit.
 *
 * extension-release.yml runs it on the tag's commit, ci.yml on every pull
 * request, so a release is never the check's first run.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { $ } from "bun";

const EXTENSION = join(import.meta.dir, "..");
const REPOSITORY = join(EXTENSION, "../..");

/** The file names of a version's source archive and Firefox store zip. */
export function sourceArchiveNames(version: string): {
	archive: string;
	prefix: string;
	firefoxZip: string;
} {
	return {
		archive: `tab-mcp-${version}-source.zip`,
		prefix: `tab-mcp-${version}/`,
		firefoxZip: `tab-mcp-browser-extension-firefox-${version}-store.zip`,
	};
}

const sha256 = (bytes: Uint8Array) =>
	new Bun.CryptoHasher("sha256").update(bytes).digest("hex");

function fail(message: string): never {
	console.error(
		process.env["GITHUB_ACTIONS"] ? `::error::${message}` : message,
	);
	process.exit(1);
}

if (import.meta.main) {
	const { values } = parseArgs({
		options: {
			commit: { type: "string", default: "HEAD" },
			built: { type: "boolean", default: false },
		},
	});
	$.cwd(REPOSITORY);
	const commit = (
		await $`git rev-parse --verify ${`${values.commit}^{commit}`}`.text()
	).trim();
	const epoch = (await $`git log -1 --format=%ct ${commit}`.text()).trim();
	const version: string = JSON.parse(
		await $`git show ${`${commit}:packages/tab-mcp-extension/package.json`}`.text(),
	).version;
	const { archive, prefix, firefoxZip } = sourceArchiveNames(version);
	console.log(
		`commit ${commit}, version ${version}, SOURCE_DATE_EPOCH ${epoch}`,
	);

	if (!values.built) {
		// The checkout's build stands for the release's: it must be that commit,
		// unchanged, and it takes its time from Git as the release's does.
		const head = (await $`git rev-parse HEAD`.text()).trim();
		if (head !== commit)
			fail(
				`the checkout is at ${head}, not ${commit}: check it out, or pass --built`,
			);
		const changed = (
			await $`git status --porcelain --untracked-files=no`.text()
		).trim();
		if (changed !== "")
			fail(`the checkout has changes; commit or stash them first:\n${changed}`);
		const env: Record<string, string | undefined> = { ...process.env };
		delete env["SOURCE_DATE_EPOCH"];
		await $`${process.execPath} scripts/build.ts --firefox --store --zip`
			.cwd(EXTENSION)
			.env(env);
	}
	const built = Bun.file(join(EXTENSION, firefoxZip));
	if (!(await built.exists()))
		fail(`no ${firefoxZip} in packages/tab-mcp-extension`);

	const target = join(EXTENSION, archive);
	await $`git archive --format=zip ${`--prefix=${prefix}`} ${`--add-virtual-file=${prefix}SOURCE_DATE_EPOCH:${epoch}`} -o ${target} ${commit}`;
	console.log(`${sha256(await Bun.file(target).bytes())}  ${archive}`);

	// The steps the reviewers' notes give, in an empty directory.
	const dir = await mkdtemp(
		join(process.env["RUNNER_TEMP"] ?? tmpdir(), "tab-mcp-source-"),
	);
	await $`unzip -q ${target} -d ${dir}`;
	const unpacked = join(dir, prefix);
	await $`${process.execPath} install --frozen-lockfile`.cwd(unpacked);
	const fromSource = join(unpacked, "packages/tab-mcp-extension");
	const archiveEpoch = (
		await Bun.file(join(unpacked, "SOURCE_DATE_EPOCH")).text()
	).trim();
	await $`${process.execPath} scripts/build.ts --firefox --store --zip`
		.cwd(fromSource)
		.env({ ...process.env, SOURCE_DATE_EPOCH: archiveEpoch });

	const ours = await built.bytes();
	const theirs = await Bun.file(join(fromSource, firefoxZip)).bytes();
	console.log(`${sha256(ours)}  ${firefoxZip} (this checkout)`);
	console.log(`${sha256(theirs)}  ${firefoxZip} (built from ${archive})`);
	if (!Buffer.from(ours).equals(theirs))
		fail(
			`the source archive builds another ${firefoxZip} (kept in ${fromSource})`,
		);
	await rm(dir, { recursive: true, force: true });
	console.log(`${archive} builds ${firefoxZip} byte for byte`);
}
