// Subprocess for the crash-logging test: `bun test` intercepts unhandled
// rejections itself, so the real process behaviour is checked here.
import { createLogger, installCrashLogging } from "../../src/log.ts";

installCrashLogging(createLogger("info"));
const mode = process.argv[2];
if (mode === "rejection") {
	void Promise.reject(new TypeError("PRIVATE-DETAIL"));
	await Bun.sleep(50);
	process.stdout.write("still running\n");
} else {
	setTimeout(() => {
		throw new RangeError("PRIVATE-DETAIL");
	}, 0);
	await Bun.sleep(200);
	process.stdout.write("still running\n");
}
