// The picker sheet is presentation only: the rows it draws, the order of the
// group headers and the match rule all come from this module, which is where
// they are pinned. The sheet itself is only wired to these two functions.

import { describe, expect, test } from "bun:test";
import { type PickerItem, filterPickerItems, groupPickerItems } from "./picker";

const items: PickerItem[] = [
	{ id: "openai-gpt", label: "gpt-5", detail: "openai", group: "OpenAI" },
	{ id: "openai-mini", label: "gpt-5-mini", detail: "openai", group: "OpenAI" },
	{ id: "zai-glm", label: "GLM-4.6", detail: "z.ai", group: "Z.ai" },
	{ id: "local-qwen", label: "qwen3-coder", detail: "local", group: "Local" },
	{ id: "local-llama", label: "llama-3", detail: "local", group: "Local" },
];

describe("filterPickerItems", () => {
	test("an empty query keeps everything, in order", () => {
		expect(filterPickerItems(items, "").map((item) => item.id)).toEqual([
			"openai-gpt",
			"openai-mini",
			"zai-glm",
			"local-qwen",
			"local-llama",
		]);
	});

	test("a whitespace-only query is an empty query", () => {
		expect(filterPickerItems(items, "   ")).toHaveLength(items.length);
	});

	test("matches the label, ignoring case", () => {
		expect(filterPickerItems(items, "GLM").map((item) => item.id)).toEqual(["zai-glm"]);
		expect(filterPickerItems(items, "gpt-5").map((item) => item.id)).toEqual(["openai-gpt", "openai-mini"]);
	});

	test("matches the detail, ignoring case", () => {
		expect(filterPickerItems(items, "Z.AI").map((item) => item.id)).toEqual(["zai-glm"]);
		expect(filterPickerItems(items, "local").map((item) => item.id)).toEqual(["local-qwen", "local-llama"]);
	});

	test("keeps group order: a later group never jumps above an earlier one", () => {
		const mixed: PickerItem[] = [
			{ id: "a1", label: "alpha", detail: "", group: "A" },
			{ id: "b1", label: "beta", detail: "", group: "B" },
			{ id: "a2", label: "beta two", detail: "", group: "A" },
		];
		expect(filterPickerItems(mixed, "beta").map((item) => item.group)).toEqual(["B", "A"]);
	});

	test("nothing matching is an empty list, not an error", () => {
		expect(filterPickerItems(items, "no-such-model")).toEqual([]);
	});

	test("never mutates its input", () => {
		const before = JSON.stringify(items);
		filterPickerItems(items, "gpt");
		expect(JSON.stringify(items)).toBe(before);
	});
});

describe("groupPickerItems", () => {
	test("groups in first appearance order and keeps each group's rows in input order", () => {
		const interleaved: PickerItem[] = [
			{ id: "a1", label: "one", detail: "", group: "A" },
			{ id: "b1", label: "two", detail: "", group: "B" },
			{ id: "a2", label: "three", detail: "", group: "A" },
			{ id: "c1", label: "four", detail: "", group: "C" },
		];
		expect(groupPickerItems(interleaved).map((part) => part.group)).toEqual(["A", "B", "C"]);
		expect(groupPickerItems(interleaved)[0]?.items.map((item) => item.id)).toEqual(["a1", "a2"]);
	});

	test("an empty list has no groups", () => {
		expect(groupPickerItems([])).toEqual([]);
	});

	test("never mutates its input, and its rows are a fresh list", () => {
		const before = JSON.stringify(items);
		const parts = groupPickerItems(items);
		expect(JSON.stringify(items)).toBe(before);
		parts[0]?.items.reverse();
		expect(JSON.stringify(items)).toBe(before);
	});
});
