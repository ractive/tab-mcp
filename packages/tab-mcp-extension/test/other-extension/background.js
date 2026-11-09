// A side panel for the clicked tab only, as Claude in Chrome opens its own.
chrome.action.onClicked.addListener((tab) => {
	chrome.sidePanel.setOptions({
		tabId: tab.id,
		path: "panel.html",
		enabled: true,
	});
	chrome.sidePanel.open({ tabId: tab.id });
});
