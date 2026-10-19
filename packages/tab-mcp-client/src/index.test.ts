import { expect, test } from "bun:test";
import { VERSION } from "./index.ts";

test("the placeholder exports a version", () => {
	expect(VERSION).toBe("0.0.0");
});
