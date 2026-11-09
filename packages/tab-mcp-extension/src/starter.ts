/**
 * The connection's start, kept so that a failure is not for ever: a start
 * that rejected is tried again by the next call (the next Chrome event, a
 * panel that connects or says something), and its error is there to show.
 */
export class Starter<T> {
	readonly #start: () => Promise<T>;
	#starting: Promise<T> | undefined;
	#value: T | undefined;
	#error: unknown;
	#failed = false;
	readonly #waiting = new Set<(value: T) => void>();

	constructor(start: () => Promise<T>) {
		this.#start = start;
	}

	/** What started, once it has. */
	get value(): T | undefined {
		return this.#value;
	}

	/** The last start failed and none runs now: the next `ready()` tries again. */
	get failed(): boolean {
		return this.#failed && this.#starting === undefined;
	}

	get error(): unknown {
		return this.#error;
	}

	/**
	 * Call `listener` once a start succeeds, whoever's call started it (at
	 * once if one has). Returns a function that stops waiting.
	 */
	onStarted(listener: (value: T) => void): () => void {
		const value = this.#value;
		if (value !== undefined) {
			listener(value);
			return () => {};
		}
		this.#waiting.add(listener);
		return () => this.#waiting.delete(listener);
	}

	/** The started value; starts (again, after a failure) if there is none. */
	ready(): Promise<T> {
		if (this.#starting !== undefined) return this.#starting;
		// A start that throws at once counts as one that rejected.
		const starting = new Promise<T>((resolve) => resolve(this.#start())).then(
			(value) => {
				this.#value = value;
				this.#failed = false;
				this.#error = undefined;
				const waiting = [...this.#waiting];
				this.#waiting.clear();
				for (const listener of waiting) listener(value);
				return value;
			},
			(error: unknown) => {
				this.#starting = undefined;
				this.#failed = true;
				this.#error = error;
				throw error;
			},
		);
		this.#starting = starting;
		return starting;
	}
}

/** A side panel's port, as far as attaching it needs. */
export interface PanelPortLike<M> {
	postMessage(message: M): void;
	onMessage(listener: (message: unknown) => void): () => void;
	onDisconnect(listener: () => void): void;
}

/** At most this many messages are kept from a panel until the start. */
export const MAX_EARLY_MESSAGES = 64;

/**
 * Attach a side panel's port once the connection has started: at once if it
 * has; else as soon as any start succeeds (this panel's, another event's).
 * What the panel says meanwhile is kept (at most MAX_EARLY_MESSAGES, the
 * newest dropped beyond) and handed over with it; each message also tries a
 * failed start again. A failed start shows the panel `failure(error)`.
 */
export function attachWhenStarted<T, M>(
	starter: Starter<T>,
	port: PanelPortLike<M>,
	attach: (value: T, early: unknown[]) => void,
	failure: (error: unknown) => M,
): void {
	const early: unknown[] = [];
	let gone = false;
	let attached = false;
	let stopWaiting = () => {};
	const done = (value: T) => {
		if (gone || attached) return;
		attached = true;
		stopWaiting();
		stopKeeping();
		attach(value, early.splice(0));
	};
	const tryStart = () => {
		if (gone || attached) return;
		starter.ready().then(done, (error: unknown) => {
			if (gone || attached) return;
			try {
				port.postMessage(failure(error));
			} catch {
				// Closed meanwhile.
			}
		});
	};
	const stopKeeping = port.onMessage((message) => {
		if (attached) return;
		if (early.length < MAX_EARLY_MESSAGES) early.push(message);
		tryStart();
	});
	port.onDisconnect(() => {
		gone = true;
		stopWaiting();
		early.length = 0;
	});
	stopWaiting = starter.onStarted(done);
	tryStart();
}
