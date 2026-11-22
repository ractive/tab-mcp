/**
 * The extension's publish jobs: extension-release.yml runs them after the
 * release, extension-publish.yml by hand, and both must call the same store
 * items the same way (DEC-190, DEC-194, DEC-195).
 */

import { expect, test } from "bun:test";
import { join } from "node:path";
import { sourceArchiveNames } from "../packages/tab-mcp-extension/scripts/source-archive.ts";

interface Job {
	if?: string;
	needs?: string;
	uses?: string;
	secrets?: unknown;
	permissions?: Record<string, string>;
	with?: Record<string, string | boolean>;
}

interface Workflow {
	on: { workflow_dispatch?: { inputs: Record<string, unknown> } };
	jobs: Record<string, Job>;
}

const workflow = async (name: string): Promise<Workflow> =>
	Bun.YAML.parse(
		await Bun.file(join(import.meta.dir, "../.github/workflows", name)).text(),
	) as Workflow;

/** The job of that name in the release workflow and in the by-hand one. */
const both = async (
	name: string,
): Promise<[Job | undefined, Job | undefined]> => [
	(await workflow("extension-release.yml")).jobs[name],
	(await workflow("extension-publish.yml")).jobs[name],
];

const shared = (file: string) =>
	new RegExp(
		`^ractive/release-workflows/\\.github/workflows/${file.replace(".", "\\.")}@[0-9a-f]{40}$`,
	);

/** What every publish job has: the release's tag, its attestation, the environment's secrets. */
function expectPublishJob(job: Job | undefined, uses: string | undefined) {
	expect(job?.uses).toBe(uses);
	expect(job?.secrets).toBe("inherit");
	expect(job?.permissions).toEqual({ contents: "read", attestations: "read" });
	// biome-ignore lint/suspicious/noTemplateCurlyInString: a GitHub Actions expression, not a template
	expect(job?.with?.["tag"]).toBe("${{ github.ref_name }}");
	expect(job?.with?.["tag-prefix"]).toBe("extension-v");
	expect(job?.with?.["attest-signer-workflow"]).toBe(
		".github/workflows/extension-release.yml",
	);
}

test("the by-hand workflow publishes to the store picked, or to all", async () => {
	const w = await workflow("extension-publish.yml");
	expect(w.on.workflow_dispatch?.inputs["store"]).toMatchObject({
		type: "choice",
		options: ["chrome", "edge", "firefox", "all"],
		default: "chrome",
	});
	expect(w.jobs["publish"]?.if).toBe(
		"inputs.store == 'chrome' || inputs.store == 'all'",
	);
	expect(w.jobs["publish-edge"]?.if).toBe(
		"inputs.store == 'edge' || inputs.store == 'all'",
	);
	expect(w.jobs["publish-firefox"]?.if).toBe(
		"inputs.store == 'firefox' || inputs.store == 'all'",
	);
});

test("both workflows publish to the Chrome Web Store with the same call", async () => {
	const [release, byHand] = await both("publish");
	expect(release?.uses).toMatch(shared("chrome-extension-publish.yml"));
	expect(release?.needs).toBe("release");
	for (const job of [release, byHand]) {
		expectPublishJob(job, release?.uses);
		expect(job?.with?.["extension-id"]).toBe(
			"jjhddplkjikmbpcobcnfebnglgjomfgh",
		);
		expect(job?.with?.["signing-key-id"]).toBe(
			"jbpcbkngalkckpjgonfkhhcipjmnnofh",
		);
		expect(job?.with?.["asset"]).toBe(
			"tab-mcp-browser-extension-{version}-store.zip",
		);
	}
});

test("both workflows publish to Edge with the same call and the same notes", async () => {
	const [release, byHand] = await both("publish-edge");
	expect(release?.uses).toMatch(shared("edge-extension-publish.yml"));
	// Beside the Chrome Web Store job, not after it.
	expect(release?.needs).toBe("release");
	for (const job of [release, byHand]) {
		expectPublishJob(job, release?.uses);
		expect(job?.with?.["product-id"]).toBe(
			"a9ff25ac-7200-4573-8eee-69473a630ae7",
		);
		expect(job?.with?.["asset"]).toBe(
			"tab-mcp-browser-extension-{version}-store.zip",
		);
		// The certifiers get the same instructions either way; Edge takes 2000.
		expect(job?.with?.["notes"]).toBe(release?.with?.["notes"]);
		expect(String(job?.with?.["notes"]).length).toBeLessThanOrEqual(2000);
	}
});

test("both workflows publish to addons.mozilla.org with the source and the same notes", async () => {
	const [release, byHand] = await both("publish-firefox");
	expect(release?.uses).toMatch(shared("firefox-extension-publish.yml"));
	// Beside the other two, not after them.
	expect(release?.needs).toBe("release");
	for (const job of [release, byHand]) {
		expectPublishJob(job, release?.uses);
		expect(job?.with?.["addon-id"]).toBe("tab-mcp@ractive.ch");
		expect(job?.with?.["asset"]).toBe(
			"tab-mcp-browser-extension-firefox-{version}-store.zip",
		);
		expect(job?.with?.["source-asset"]).toBe("tab-mcp-{version}-source.zip");
		// The reviewers get the same instructions either way; AMO takes 3000.
		expect(job?.with?.["notes"]).toBe(release?.with?.["notes"]);
		expect(String(job?.with?.["notes"]).length).toBeLessThanOrEqual(3000);
	}
});

test("AMO's reviewers are told the Bun version the release builds with", async () => {
	const w = (await workflow("extension-release.yml")) as unknown as {
		jobs: Record<
			string,
			{
				steps?: { uses?: string; with?: Record<string, unknown> }[];
				with?: Record<string, unknown>;
			}
		>;
	};
	const bun = w.jobs["build"]?.steps?.find((s) =>
		s.uses?.startsWith("oven-sh/setup-bun@"),
	)?.with?.["bun-version"];
	expect(String(bun)).toMatch(/^\d+\.\d+\.\d+$/);
	// A newer Bun may bundle differently, and the reviewers' build would not
	// give the uploaded bytes.
	expect(String(w.jobs["publish-firefox"]?.with?.["notes"])).toContain(
		`install Bun ${bun} (`,
	);
});

test("the release and every pull request check the source archive with the same script", async () => {
	type Step = {
		run?: string;
		"working-directory"?: string;
		if?: string;
	};
	const steps = async (file: string, job: string) =>
		(
			(await workflow(file)) as unknown as {
				jobs: Record<string, { steps?: Step[] }>;
			}
		).jobs[job]?.steps ?? [];
	const script = (s: Step) =>
		s.run?.startsWith("bun scripts/source-archive.ts") === true;

	const release = await steps("extension-release.yml", "build");
	const inRelease = release.filter(script);
	expect(inRelease).toHaveLength(1);
	// The tag's commit, against the Firefox zip the job built before it.
	expect(inRelease[0]?.run).toBe(
		'bun scripts/source-archive.ts --commit "$BUILT" --built',
	);
	const runs = release.map((s) => s.run ?? "");
	expect(runs.indexOf(inRelease[0]?.run ?? "")).toBeGreaterThan(
		runs.indexOf("bun scripts/build.ts --firefox --store --zip"),
	);
	// The script is the one place that packs the archive.
	expect(runs.some((run) => run.includes("git archive"))).toBe(false);

	const ci = await steps("ci.yml", "fast");
	const inCi = ci.filter(script);
	expect(inCi).toHaveLength(1);
	// The pull request's checkout as it is (HEAD), built by the script itself.
	expect(inCi[0]?.run).toBe("bun scripts/source-archive.ts");
	expect(inCi[0]?.if).toBe("steps.changes.outputs.code == 'true'");
	for (const step of [...inRelease, ...inCi])
		expect(step["working-directory"]).toBe("packages/tab-mcp-extension");
});

test("the release attaches what the publish jobs download", async () => {
	const text = await Bun.file(
		join(import.meta.dir, "../.github/workflows/extension-release.yml"),
	).text();
	// The names the release job expects in its artifact, which the jobs
	// above download from the release by their {version} patterns.
	for (const name of [
		'"tab-mcp-$VERSION-source.zip"',
		'"tab-mcp-browser-extension-$VERSION-store.zip"',
		'"tab-mcp-browser-extension-firefox-$VERSION-store.zip"',
	])
		expect(text).toContain(name);
	// The script packs the archive under that name, beside the Firefox zip
	// the publish job asks for.
	expect(sourceArchiveNames("1.2.3")).toEqual({
		archive: "tab-mcp-1.2.3-source.zip",
		prefix: "tab-mcp-1.2.3/",
		firefoxZip: "tab-mcp-browser-extension-firefox-1.2.3-store.zip",
	});
});
