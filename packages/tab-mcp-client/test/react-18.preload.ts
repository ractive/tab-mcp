/**
 * Preload for react-18.test.ts: every import of `react` and `react-dom`
 * (also react-dom's own) gets React 18.3 (the dev dependencies `react-18`,
 * `react-dom-18`) instead of 19.
 */
import { mock } from "bun:test";

const modules: [string, string][] = [
	["react", "react-18"],
	["react/jsx-runtime", "react-18/jsx-runtime"],
	["react/jsx-dev-runtime", "react-18/jsx-dev-runtime"],
	["react-dom", "react-dom-18"],
	["react-dom/client", "react-dom-18/client"],
	["react-dom/server", "react-dom-18/server"],
];
for (const [name, replacement] of modules) {
	const real = require(replacement);
	mock.module(name, () => real);
}
