/**
 * One spelling of a page tool's definition, for comparing two of them
 * (DEC-217): the worker's key of an offered tool, and the content script's
 * check right before a call that the tool is still the one offered.
 */

/**
 * `value` as JSON (what `JSON.stringify` gives, `undefined` and functions
 * left out alike) with every object's keys sorted, at every depth: the same
 * tool registered again with its fields in another order spells the same.
 */
export function canonicalJson(value: unknown): string {
	return (
		JSON.stringify(value, (_key, v: unknown) =>
			typeof v === "object" && v !== null && !Array.isArray(v)
				? Object.fromEntries(
						Object.keys(v)
							.sort()
							.map((k) => [k, (v as Record<string, unknown>)[k]]),
					)
				: v,
		) ?? ""
	);
}
