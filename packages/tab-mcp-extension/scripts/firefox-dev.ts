/**
 * tab-mcp for Firefox while developing it: builds the Firefox build with host
 * access granted at install (`--all-sites`) into `dist-firefox-dev/` and
 * starts Firefox through ff-rdp (https://github.com/ractive/ff-rdp) with one
 * profile that is kept, with the build as a temporary add-on.
 *
 *   bun scripts/firefox-dev.ts [URL] [--headless] [--port N]
 *
 * A temporary add-on is gone when Firefox quits, and Firefox gives the next
 * one a new UUID and empty storage: a new address for the AI app to pair
 * with. The profile sets `extensions.webextensions.keepUuidOnUninstall` and
 * `keepStorageOnUninstall`, so every launch has the same UUID, relay address
 * and settings; running the script again rebuilds and replaces the running
 * Firefox (ff-rdp's `--replace`). The profile: `TAB_MCP_FIREFOX_PROFILE`, or
 * `~/.cache/tab-mcp/firefox-dev-profile`. ff-rdp's commands reach this
 * Firefox with `--port N` (6000 unless given).
 */

import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { build } from "./build.ts";

/** What the profile needs: the add-on's UUID and storage outlast its removal. */
export const DEV_PREFS: Readonly<Record<string, boolean>> = {
	"extensions.webextensions.keepUuidOnUninstall": true,
	"extensions.webextensions.keepStorageOnUninstall": true,
};

/** `user.js` with `DEV_PREFS` added, keeping whatever it set already. */
export function withDevPrefs(userJs: string): string {
	const lines = userJs === "" ? [] : userJs.replace(/\n$/, "").split("\n");
	for (const [name, value] of Object.entries(DEV_PREFS))
		if (!userJs.includes(JSON.stringify(name)))
			lines.push(`user_pref(${JSON.stringify(name)}, ${value});`);
	return `${lines.join("\n")}\n`;
}

if (import.meta.main) {
	const { values, positionals } = parseArgs({
		allowPositionals: true,
		options: {
			headless: { type: "boolean" },
			port: { type: "string", default: "6000" },
		},
	});
	if (Bun.which("ff-rdp") === null) {
		console.error(
			"ff-rdp is not on the PATH: https://github.com/ractive/ff-rdp",
		);
		process.exit(2);
	}
	const profile = resolve(
		process.env["TAB_MCP_FIREFOX_PROFILE"] ??
			join(homedir(), ".cache/tab-mcp/firefox-dev-profile"),
	);
	await mkdir(profile, { recursive: true });
	const userJs = Bun.file(join(profile, "user.js"));
	const before = (await userJs.exists()) ? await userJs.text() : "";
	const after = withDevPrefs(before);
	if (after !== before) await Bun.write(userJs, after);
	const { outdir } = await build({
		firefox: true,
		allSites: true,
		outdir: join(import.meta.dir, "..", "dist-firefox-dev"),
	});
	console.error(`built ${outdir}\nprofile ${profile}`);
	const launch = Bun.spawn(
		[
			"ff-rdp",
			"launch",
			"--profile",
			profile,
			"--debug-port",
			String(values.port),
			"--replace",
			"--temporary-addon",
			outdir,
			...(values.headless ? ["--headless"] : []),
			...positionals.slice(0, 1),
		],
		{ stdout: "inherit", stderr: "inherit" },
	);
	process.exit(await launch.exited);
}
