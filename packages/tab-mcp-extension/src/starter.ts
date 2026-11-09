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

	/** The started value; starts (again, after a failure) if there is none. */
	ready(): Promise<T> {
		if (this.#starting !== undefined) return this.#starting;
		// A start that throws at once counts as one that rejected.
		const starting = new Promise<T>((resolve) => resolve(this.#start())).then(
			(value) => {
				this.#value = value;
				this.#failed = false;
				this.#error = undefined;
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
