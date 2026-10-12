import { describe, expect, test } from "bun:test";
import { diffLineClass, inlineSpans, isNearBottom, markdownBlocks, relativeTime, subagentTone, toolDuration, toolStatusLabel } from "./format";

const now = Date.parse("2026-10-12T12:00:00Z");

describe("relativeTime", () => {
	test("buckets", () => {
		expect(relativeTime("2026-10-12T11:59:40Z", now)).toBe("just now");
		expect(relativeTime("2026-10-12T11:55:00Z", now)).toBe("5m ago");
		expect(relativeTime("2026-10-12T09:00:00Z", now)).toBe("3h ago");
		expect(relativeTime("2026-10-10T12:00:00Z", now)).toBe("2d ago");
	});
	test("future and garbage", () => {
		expect(relativeTime("2026-10-12T12:00:30Z", now)).toBe("just now");
		expect(relativeTime("nope", now)).toBe("");
	});
});

describe("diffLineClass", () => {
	test("classifies unified lines", () => {
		expect(diffLineClass("+added")).toBe("diff-add");
		expect(diffLineClass("-gone")).toBe("diff-del");
		expect(diffLineClass("@@ -1,2 +1,3 @@")).toBe("diff-hunk");
		expect(diffLineClass(" context")).toBe("diff-ctx");
		expect(diffLineClass("--- a comment")).toBe("diff-del");
	});
});

describe("isNearBottom", () => {
	test("sticks only within threshold", () => {
		expect(isNearBottom({ scrollHeight: 1000, scrollTop: 560, clientHeight: 400 })).toBe(true);
		expect(isNearBottom({ scrollHeight: 1000, scrollTop: 300, clientHeight: 400 })).toBe(false);
	});
});

describe("toolStatusLabel", () => {
	test("labels", () => {
		expect(toolStatusLabel("running")).toBe("running");
		expect(toolStatusLabel("done")).toBe("done");
		expect(toolStatusLabel("error")).toBe("failed");
	});
});

describe("toolDuration", () => {
	test("formats like omp", () => {
		expect(toolDuration(undefined)).toBe("");
		expect(toolDuration(420)).toBe("420ms");
		expect(toolDuration(1234)).toBe("1.2s");
		expect(toolDuration(125_000)).toBe("2m05s");
	});
});

describe("subagentTone", () => {
	test("maps free status strings", () => {
		expect(subagentTone("running")).toBe("running");
		expect(subagentTone("completed")).toBe("done");
		expect(subagentTone("failed")).toBe("error");
		expect(subagentTone("aborted")).toBe("error");
		expect(subagentTone("queued?")).toBe("other");
	});
});

describe("markdownBlocks", () => {
	test("splits headings, items, quotes, rules and paragraphs", () => {
		const blocks = markdownBlocks("# Title\nline one\nline two\n\n- a\n  2. b\n> q1\n> q2\n---\ntail");
		expect(blocks).toEqual([
			{ kind: "heading", level: 1, text: "Title" },
			{ kind: "para", text: "line one\nline two" },
			{ kind: "item", marker: "•", indent: 0, text: "a" },
			{ kind: "item", marker: "2.", indent: 1, text: "b" },
			{ kind: "quote", text: "q1\nq2" },
			{ kind: "hr" },
			{ kind: "para", text: "tail" },
		]);
	});
	test("fences keep their body verbatim, unclosed runs to the end", () => {
		expect(markdownBlocks("```ts\n# not a heading\n```\nafter")).toEqual([
			{ kind: "code", lang: "ts", text: "# not a heading" },
			{ kind: "para", text: "after" },
		]);
		expect(markdownBlocks("```\nstreaming")).toEqual([{ kind: "code", lang: "", text: "streaming" }]);
	});
});

describe("inlineSpans", () => {
	test("code and bold spans, everything else text", () => {
		expect(inlineSpans("run `bun test` **now** ok")).toEqual([
			{ kind: "text", text: "run " },
			{ kind: "code", text: "bun test" },
			{ kind: "text", text: " " },
			{ kind: "bold", text: "now" },
			{ kind: "text", text: " ok" },
		]);
		expect(inlineSpans("<b>plain</b>")).toEqual([{ kind: "text", text: "<b>plain</b>" }]);
	});
});
