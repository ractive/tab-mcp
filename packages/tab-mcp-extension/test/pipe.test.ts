import { expect, test } from "bun:test";
import { type Sink, write } from "./browser.ts";

const epipe = () =>
	Object.assign(new Error("broken pipe"), { code: "EPIPE" }) as Error;

test("a flush that fails after Chrome went away is not unhandled", async () => {
	const unhandled: unknown[] = [];
	const onRejection = (reason: unknown) => unhandled.push(reason);
	process.on("unhandledRejection", onRejection);
	try {
		const sink: Sink = {
			write: () => 0,
			flush: () => Promise.reject(epipe()),
		};
		write(sink, "{}\0");
		await Bun.sleep(20);
		expect(unhandled).toEqual([]);
	} finally {
		process.off("unhandledRejection", onRejection);
	}
});

test("a write that throws at once is dropped", () => {
	const sink: Sink = {
		write: () => {
			throw epipe();
		},
		flush: () => 0,
	};
	expect(() => write(sink, "{}\0")).not.toThrow();
});

test("the message is written and flushed", () => {
	const written: string[] = [];
	let flushed = 0;
	write(
		{
			write: (chunk) => written.push(chunk),
			flush: () => ++flushed,
		},
		"{}\0",
	);
	expect(written).toEqual(["{}\0"]);
	expect(flushed).toBe(1);
});
