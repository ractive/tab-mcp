/**
 * The CDN build's core entry, by the name its file is published under: the
 * build names entries after their source file (`[name].min.js`), so that
 * `./allowed` can be an entry of the same build, sharing its chunks.
 */
export * from "../../src/index.ts";
