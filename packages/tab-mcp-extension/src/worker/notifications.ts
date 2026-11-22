/**
 * The notification API the worker uses: the browser's `chrome.notifications`,
 * looked up at each call (a test that wraps one of its functions sees its
 * calls). The Firefox test build alone puts a recorder in its place
 * (background.ts, DEC-220): its notifications neither reach the desktop nor,
 * as Firefox's own alert windows would, take the focus from the panel.
 */
export interface NotificationApi {
	create(
		id: string,
		options: chrome.notifications.NotificationCreateOptions,
	): Promise<string>;
	clear(id: string): Promise<boolean>;
	getAll(): Promise<Record<string, unknown>>;
}

let replaced: NotificationApi | undefined;

export function notificationApi(): NotificationApi {
	return replaced ?? (chrome.notifications as unknown as NotificationApi);
}

/** The test build only: notifications go to `api` from now on. */
export function useNotificationApi(api: NotificationApi): void {
	replaced = api;
}

/** A recorder of notifications: what is shown, by id, until cleared. */
export function notificationRecorder(): NotificationApi & {
	shown: Map<string, chrome.notifications.NotificationCreateOptions>;
} {
	const shown = new Map<
		string,
		chrome.notifications.NotificationCreateOptions
	>();
	return {
		shown,
		create: async (id, options) => {
			shown.set(id, options);
			return id;
		},
		clear: async (id) => shown.delete(id),
		getAll: async () =>
			Object.fromEntries([...shown.keys()].map((id) => [id, true])),
	};
}
