import { describe, expect, test } from "bun:test";
import { Calculator, formatNumber } from "../src/calculator.ts";

function run(keys: string): string {
	const c = new Calculator();
	c.pressAll(keys);
	return c.display;
}

describe("Calculator", () => {
	test.each([
		["12+30=", "42"],
		["12*12=", "144"],
		["7-10=", "-3"],
		["1/4=", "0.25"],
		["2+3*4=", "20"], // immediate execution, like a pocket calculator
		["10-2-3=", "5"],
		["5+*2=", "10"], // a second operator replaces the first
		["0.1+0.2=", "0.3"],
		["1/3=", "0.333333333333"],
		["..5+1=", "1.5"],
		["007=", "7"],
		["12+30", "30"],
		["12+30=C", "0"],
		["9 * 9 =", "81"],
		["5+=", "10"],
	])("%s shows %s", (keys, display) => {
		expect(run(keys)).toBe(display);
	});

	test("division by zero shows Error until C", () => {
		const c = new Calculator();
		c.pressAll("1/0=");
		expect(c.display).toBe("Error");
		expect(c.error).toBe(true);
		c.pressAll("5+5=");
		expect(c.display).toBe("Error");
		c.pressAll("C2+2=");
		expect(c.display).toBe("4");
	});

	test("an entry stops at 12 digits", () => {
		expect(run("1234567890123456")).toBe("123456789012");
	});

	test("refuses keys that are not on the keypad", () => {
		expect(() => new Calculator().pressAll("2^3")).toThrow(RangeError);
	});

	test("memory: M+, MR, MC; C keeps the memory", () => {
		const c = new Calculator();
		c.pressAll("6*7=");
		c.memoryAdd();
		c.memoryAdd();
		expect(c.memory).toBe(84);
		c.pressAll("C");
		expect(c.memory).toBe(84);
		c.memoryRecall();
		expect(c.display).toBe("84");
		c.pressAll("+1=");
		expect(c.display).toBe("85");
		c.memoryClear();
		expect(c.memory).toBe(0);
	});

	test("a digit after MR starts a new number", () => {
		const c = new Calculator();
		c.pressAll("5");
		c.memoryAdd();
		c.pressAll("C");
		c.memoryRecall();
		c.pressAll("3");
		expect(c.display).toBe("3");
	});

	test("M+ that overflows shows Error and keeps the memory", () => {
		const c = new Calculator();
		c.pressAll(`999999999999${"*999999999999".repeat(24)}*99999999=`);
		c.memoryAdd();
		const memory = c.memory;
		expect(Number.isFinite(memory)).toBe(true);
		c.memoryAdd();
		expect(c.display).toBe("Error");
		expect(c.memory).toBe(memory);
		c.press("C");
		c.memoryRecall();
		expect(c.display).toBe(formatNumber(memory));
	});

	test("an operator after MR or M+ applies the pending operation", () => {
		const c = new Calculator();
		c.pressAll("5");
		c.memoryAdd();
		c.pressAll("C2+");
		c.memoryRecall();
		c.pressAll("+1=");
		expect(c.display).toBe("8");
		c.pressAll("C2+3");
		c.memoryAdd();
		c.pressAll("+1=");
		expect(c.display).toBe("6");
	});
});

test("formatNumber rounds to 12 significant digits", () => {
	expect(formatNumber(2 / 3)).toBe("0.666666666667");
	expect(formatNumber(-0)).toBe("0");
	expect(formatNumber(1e21)).toBe("1e+21");
	expect(formatNumber(999999999999)).toBe("999999999999");
	expect(formatNumber(1e12)).toBe("1e+12");
	expect(formatNumber(999999 ** 3)).toBe("9.99997000003e+17");
	expect(formatNumber(-(999999 ** 3))).toBe("-9.99997000003e+17");
	expect(formatNumber(Number.POSITIVE_INFINITY)).toBe("Error");
});
