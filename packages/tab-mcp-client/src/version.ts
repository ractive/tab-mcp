/** The library's name and version, sent in `hello`; the version is package.json's. */
import { version } from "../package.json" with { type: "json" };

export const LIBRARY_NAME = "@ractive-ch/tab-mcp-client";
export const VERSION: string = version;
