// The service worker. The harness calls `spike.*` here over CDP to try
// chrome.scripting.executeScript in either world: its result comes back
// through the extension API, not through the page.

importScripts("probe.js");

globalThis.spike = {
	async tabId(url) {
		const tabs = await chrome.tabs.query({});
		const tab = tabs.find((t) => t.url?.startsWith(url));
		if (!tab?.id) throw new Error(`no tab at ${url}`);
		return tab.id;
	},
	async execute(url, world, op, arg = {}, allFrames = false) {
		const results = await chrome.scripting.executeScript({
			target: { tabId: await this.tabId(url), allFrames },
			world,
			func: webmcpProbe,
			args: [op, arg],
		});
		return results.map((r) => ({
			frameId: r.frameId,
			documentId: r.documentId,
			result: r.result,
			error: r.error,
		}));
	},
};
