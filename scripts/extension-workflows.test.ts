/**
 * The extension's publish jobs: extension-release.yml runs them after the
 * release, extension-publish.yml by hand, and both must call the same store
 * items the same way (DEC-190, DEC-194).
 */

import { expect, test } from "bun:test";
import { join } from "node:path";

interface Job {
	if?: string;
	needs?: string;
	uses?: string;
	secrets?: unknown;
	permissions?: Record<string, string>;
	with?: Record<string, string | boolean>;
}

const jobs = async (name: string): Promise<Record<string, Job>> =>
	(
		Bun.YAML.parse(
			await Bun.file(
				join(import.meta.dir, "../.github/workflows", name),
			).text(),
		) as { jobs: Record<string, Job> }
	).jobs;

test("both workflows publish to Edge with the same call and the same notes", async () => {
	const release = (await jobs("extension-release.yml"))["publish-edge"];
	const byHand = (await jobs("extension-publish.yml"))["publish-edge"];
	expect(release?.uses).toMatch(
		/^ractive\/release-workflows\/\.github\/workflows\/edge-extension-publish\.yml@[0-9a-f]{40}$/,
	);
	// Beside the Chrome Web Store job, not after it.
	expect(release?.needs).toBe("release");
	expect(byHand?.if).toBe("inputs.store != 'chrome'");
	for (const job of [release, byHand]) {
		expect(job?.uses).toBe(release?.uses);
		expect(job?.secrets).toBe("inherit");
		expect(job?.permissions).toEqual({
			contents: "read",
			attestations: "read",
		});
		expect(job?.with?.["product-id"]).toBe(
			"a9ff25ac-7200-4573-8eee-69473a630ae7",
		);
		expect(job?.with?.["attest-signer-workflow"]).toBe(
			".github/workflows/extension-release.yml",
		);
		expect(job?.with?.["asset"]).toBe(
			"tab-mcp-browser-extension-{version}-store.zip",
		);
		// The certifiers get the same instructions either way; Edge takes 2000.
		expect(job?.with?.["notes"]).toBe(release?.with?.["notes"]);
		expect(String(job?.with?.["notes"]).length).toBeLessThanOrEqual(2000);
	}
});

test("both workflows publish to the Chrome Web Store with the same call", async () => {
	const release = (await jobs("extension-release.yml"))["publish"];
	const byHand = (await jobs("extension-publish.yml"))["publish"];
	expect(byHand?.if).toBe("inputs.store != 'edge'");
	for (const key of ["extension-id", "signing-key-id", "asset"]) {
		expect(byHand?.with?.[key]).toBe(release?.with?.[key] as string);
	}
	expect(byHand?.uses).toBe(release?.uses);
	expect(byHand?.secrets).toBe("inherit");
});
