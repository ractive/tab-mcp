/**
 * The server's name and the address as words for the setup commands
 * (`setup.ts`), plain in every shell. Internal: not part of an entry.
 */

/**
 * The server's name as a label that every shell (POSIX shells, PowerShell,
 * cmd.exe) reads as one plain word, so it needs no quoting: letters without
 * their marks ("Bücher" → "bucher"), lower case, each run of anything but
 * a-z, 0-9, _ and - as one "-", no "-" at either end (no option), at most 40
 * characters; "tools" when nothing is left. The page names its server, but
 * the command runs in the user's shell: nothing of the name may be quoted
 * text (review of PR 34).
 */
export function commandName(name: string): string {
	const label = name
		.normalize("NFKD")
		.replace(/\p{M}/gu, "")
		.toLowerCase()
		.replace(/[^a-z0-9_-]+/g, "-")
		.replace(/-{2,}/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 40)
		.replace(/-+$/, "");
	return label === "" ? "tools" : label;
}

/**
 * The address for a command, only when all of it is plain in every shell
 * (http or https, letters, digits and . : [ ] / _ ~ -); else `undefined`, and
 * the help shows the steps without commands. The relay's addresses are.
 */
export function commandAddress(address: string): string | undefined {
	try {
		const href = new URL(address).href;
		return /^https?:\/\/[A-Za-z0-9.:[\]/_~-]+$/.test(href) ? href : undefined;
	} catch {
		return undefined;
	}
}
