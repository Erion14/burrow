import { describe, expect, test } from "bun:test";
import type { TranscriptItem } from "../../shared/types";
import { copyTextFor } from "./message-text";

function item(fields: Partial<TranscriptItem> & Pick<TranscriptItem, "kind">): TranscriptItem {
	return { id: "i1", text: "", thinking: "", createdAt: "2026-10-12T12:00:00Z", ...fields };
}

describe("copyTextFor", () => {
	test("the user's own text", () => {
		expect(copyTextFor(item({ kind: "user", text: "ship it\nplease" }))).toBe("ship it\nplease");
	});

	test("an assistant answer", () => {
		expect(copyTextFor(item({ kind: "assistant", text: "done in three steps" }))).toBe("done in three steps");
	});

	test("an assistant answer carries its thinking", () => {
		const copy = copyTextFor(item({ kind: "assistant", text: "the answer", thinking: "because of the first probe" }));
		expect(copy).toBe("the answer\n\nbecause of the first probe");
	});

	test("an assistant item that streamed only thinking", () => {
		expect(copyTextFor(item({ kind: "assistant", thinking: "still weighing it" }))).toBe("still weighing it");
	});

	test("an empty assistant item copies nothing", () => {
		expect(copyTextFor(item({ kind: "assistant" }))).toBeNull();
	});

	test("a tool card carries its call and its bounded output", () => {
		const copy = copyTextFor(
			item({ kind: "tool", tool: { id: "t1", name: "Read", args: "src/web/main.tsx", output: "1  import ...", status: "done" } }),
		);
		expect(copy).toBe("Read src/web/main.tsx\n\n1  import ...");
	});

	test("a tool card with no output yet still copies the call", () => {
		const copy = copyTextFor(item({ kind: "tool", tool: { id: "t1", name: "Bash", args: "", output: "", status: "running" } }));
		expect(copy).toBe("Bash");
	});

	test("a tool item with no card copies nothing", () => {
		expect(copyTextFor(item({ kind: "tool" }))).toBeNull();
	});

	test("a bash card carries the command and its output", () => {
		const copy = copyTextFor(
			item({ kind: "bash", text: " M src/web/main.tsx", bash: { command: "git status --short", status: "done", exitCode: 0 } }),
		);
		expect(copy).toBe("git status --short\n\n M src/web/main.tsx");
	});

	test("a bash card with no output yet copies the command alone", () => {
		const copy = copyTextFor(item({ kind: "bash", bash: { command: "bun test", status: "running", exitCode: null } }));
		expect(copy).toBe("bun test");
	});

	test("a notice is not worth pasting", () => {
		expect(copyTextFor(item({ kind: "notice", text: "session settled" }))).toBeNull();
	});

	test("an item with nothing in it copies nothing", () => {
		expect(copyTextFor(item({ kind: "user", text: "   " }))).toBeNull();
	});
});
