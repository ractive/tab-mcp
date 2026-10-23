/**
 * A four-function calculator with immediate execution, like a pocket
 * calculator: `2+3*4=` is 20, each operator applies to the running result.
 * No DOM here, so it is tested without a browser.
 */

/** The keys of the keypad (and of the `press_keys` tool). */
export const KEYS = [
	"0",
	"1",
	"2",
	"3",
	"4",
	"5",
	"6",
	"7",
	"8",
	"9",
	".",
	"+",
	"-",
	"*",
	"/",
	"=",
	"C",
] as const;

export type Key = (typeof KEYS)[number];

type Operator = "+" | "-" | "*" | "/";

/** Digits shown at most; longer results are rounded or shown in exponent form. */
export const MAX_DIGITS = 12;

const ERROR = "Error";

export function isKey(value: string): value is Key {
	return (KEYS as readonly string[]).includes(value);
}

/** A number as the display shows it: at most 12 significant digits. */
export function formatNumber(n: number): string {
	if (!Number.isFinite(n)) return ERROR;
	const rounded = Number(n.toPrecision(MAX_DIGITS));
	if (Object.is(rounded, -0)) return "0";
	// More integer digits than the display has: exponent form.
	return Math.abs(rounded) >= 10 ** MAX_DIGITS
		? rounded.toExponential()
		: String(rounded);
}

function apply(a: number, op: Operator, b: number): number {
	switch (op) {
		case "+":
			return a + b;
		case "-":
			return a - b;
		case "*":
			return a * b;
		case "/":
			return b === 0 ? Number.NaN : a / b;
	}
}

export class Calculator {
	/** What the display shows. */
	#display = "0";
	/** The running result waiting for the next operand. */
	#accumulator: number | undefined;
	#operator: Operator | undefined;
	/** The next digit starts a new number. */
	#fresh = true;
	/** The last key was an operator, so another one only replaces it. */
	#afterOperator = false;
	#memory = 0;

	get display(): string {
		return this.#display;
	}

	get memory(): number {
		return this.#memory;
	}

	/** True after a division by zero or an overflow, until C. */
	get error(): boolean {
		return this.#display === ERROR;
	}

	/** Press one key. Keys other than C are ignored while the display shows Error. */
	press(key: Key): void {
		if (key === "C") {
			this.clear();
			return;
		}
		if (this.error) return;
		if (key === "=") this.#equals();
		else if (key === "+" || key === "-" || key === "*" || key === "/")
			this.#operate(key);
		else this.#digit(key);
	}

	/** Press several keys, e.g. `"12+30="`; spaces are skipped. */
	pressAll(keys: string): void {
		for (const key of keys) {
			if (key === " ") continue;
			if (!isKey(key)) throw new RangeError(`Not a calculator key: ${key}`);
			this.press(key);
		}
	}

	/** C: clears the display and the pending operation, not the memory. */
	clear(): void {
		this.#display = "0";
		this.#accumulator = undefined;
		this.#operator = undefined;
		this.#fresh = true;
		this.#afterOperator = false;
	}

	/** M+: adds the displayed number to the memory; an overflow shows Error and keeps the memory. */
	memoryAdd(): void {
		if (this.error) return;
		const sum = this.#memory + this.#value();
		if (!Number.isFinite(sum)) {
			this.#display = ERROR;
			return;
		}
		this.#memory = Number(formatNumber(sum));
		this.#fresh = true;
		this.#afterOperator = false;
	}

	/** MR: shows the memory as the current number. */
	memoryRecall(): void {
		if (this.error) return;
		this.#display = formatNumber(this.#memory);
		this.#fresh = true;
		this.#afterOperator = false;
	}

	/** MC: sets the memory to 0. */
	memoryClear(): void {
		this.#memory = 0;
	}

	#value(): number {
		return Number(this.#display);
	}

	#digit(key: Key): void {
		this.#afterOperator = false;
		if (this.#fresh) {
			this.#display = key === "." ? "0." : key;
			this.#fresh = false;
			return;
		}
		if (key === "." && this.#display.includes(".")) return;
		if (this.#display.replace(/[-.]/g, "").length >= MAX_DIGITS) return;
		this.#display =
			this.#display === "0" && key !== "." ? key : this.#display + key;
	}

	#operate(op: Operator): void {
		// A second operator in a row only replaces the first.
		if (!this.#afterOperator) this.#evaluate();
		this.#accumulator = this.#value();
		this.#operator = op;
		this.#fresh = true;
		this.#afterOperator = true;
	}

	#equals(): void {
		this.#evaluate();
		this.#accumulator = undefined;
		this.#operator = undefined;
		this.#fresh = true;
		this.#afterOperator = false;
	}

	#evaluate(): void {
		if (this.#accumulator === undefined || this.#operator === undefined) return;
		this.#display = formatNumber(
			apply(this.#accumulator, this.#operator, this.#value()),
		);
	}
}
