/**
 * `step()`: the browser tests' scenarios are made of named steps (iteration
 * 50), in every workspace: the extension's, the client's, the relay's.
 * Tested in scripts/step.test.ts.
 */

/**
 * One step of a test that is one scenario: a failure names the step, then
 * says what failed in it, also for a thrown value that is no `Error`. A
 * step has its own deadline, `deadlineMs` (the timeout of the test it was
 * before; 30 s by default): a step that takes longer fails as "[name] took
 * longer than N s", where the test's own timeout (which no code can catch)
 * would name nothing. A scenario's timeout is the sum of its steps'
 * deadlines and a margin, so a step's deadline always comes first.
 */
export async function step(
	name: string,
	body: () => Promise<void>,
	deadlineMs = 30_000,
): Promise<void> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const late = new Promise<never>((_, reject) => {
		timer = setTimeout(
			() =>
				reject(
					new Error(
						`took longer than ${deadlineMs >= 1000 ? `${Math.round(deadlineMs / 1000)} s` : `${deadlineMs} ms`}`,
					),
				),
			deadlineMs,
		);
	});
	try {
		await Promise.race([body(), late]);
	} catch (error) {
		if (error instanceof Error) {
			error.message = `[${name}] ${error.message}`;
			throw error;
		}
		throw new Error(`[${name}] ${String(error)}`, { cause: error });
	} finally {
		clearTimeout(timer);
	}
}
