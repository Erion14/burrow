import { describe, expect, test } from "bun:test";
import { diffLineClass, isNearBottom, relativeTime, toolStatusLabel } from "./format";

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
