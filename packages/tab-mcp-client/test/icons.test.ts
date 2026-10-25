import { expect, test } from "bun:test";
import { Window } from "happy-dom";
import { cleanIcons, pageIcons } from "../src/icons.ts";

function page(head: string): Document {
	const window = new Window({ url: "https://example.test/app/" });
	window.document.head.innerHTML = head;
	return window.document as unknown as Document;
}

test("the page's icon links become serverInfo icons", () => {
	const doc = page(`
		<link rel="icon" href="/favicon.svg" type="image/svg+xml" sizes="any">
		<link rel="ICON" href="dark.png" sizes="32x32 48X48" media="(prefers-color-scheme: dark)">
		<link rel="apple-touch-icon" href="https://cdn.example/touch.png">
		<link rel="stylesheet" href="/style.css">
		<link rel="icon" href="javascript:alert(1)">
		<link rel="icon" href="">
	`);
	expect(pageIcons(doc)).toEqual([
		{
			src: "https://example.test/favicon.svg",
			mimeType: "image/svg+xml",
			sizes: ["any"],
		},
		{
			src: "https://example.test/app/dark.png",
			sizes: ["32x32", "48x48"],
			theme: "dark",
		},
		{ src: "https://cdn.example/touch.png" },
	]);
	expect(pageIcons(page(""))).toEqual([]);
	expect(pageIcons({} as Document)).toEqual([]);
});

test("given icons are cleaned: http(s) or data:image only, valid fields, at most 8", () => {
	expect(
		cleanIcons([
			{
				src: "https://a.example/i.png",
				mimeType: "image/PNG",
				sizes: ["16x16", "huge"],
				theme: "light",
			},
			{ src: "data:image/png;base64,AAAA" },
			{ src: "data:text/html,<script>" },
			{ src: "data:image/svg+xml,<svg onload='x()'/>" },
			{ src: `data:image/png;base64,${"A".repeat(20_000)}` },
			{ src: "file:///etc/passwd" },
			{
				src: "https://a.example/x",
				mimeType: "text/html",
				theme: "blue" as "dark",
			},
			{ src: `https://a.example/${"x".repeat(3000)}` },
		]),
	).toEqual([
		{
			src: "https://a.example/i.png",
			mimeType: "image/png",
			sizes: ["16x16"],
			theme: "light",
		},
		{ src: "data:image/png;base64,AAAA" },
		{ src: "https://a.example/x" },
	]);
	const many = Array.from({ length: 12 }, (_, i) => ({
		src: `https://a.example/${i}.png`,
	}));
	expect(cleanIcons(many)).toHaveLength(8);
});
