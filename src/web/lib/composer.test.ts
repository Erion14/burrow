// The composer's own text rules: the `!` bash mode and the pure edits the key
// bar's chords run. They live here rather than in the screen because the screen
// owns the socket, the caret and the completion menu, and only the string work
// is worth pinning: a chord that mangles the draft is the failure this file is
// here to catch.

import { describe, expect, test } from "bun:test";
import { bashCommand, bashMode, editDraft, insertText } from "./composer";

describe("bashMode", () => {
	test("only a leading bang takes the composer into bash mode", () => {
		expect(bashMode("!ls")).toBe(true);
		expect(bashMode("ls !")).toBe(false);
		expect(bashMode("  !ls")).toBe(false);
	});
});

describe("bashCommand", () => {
	test("a bang message runs what follows it", () => {
		expect(bashCommand("!ls")).toBe("ls");
		expect(bashCommand("!git status --short")).toBe("git status --short");
		expect(bashCommand("! ls")).toBe("ls");
	});

	test("a lone bang has nothing to run", () => {
		expect(bashCommand("!")).toBeNull();
		expect(bashCommand("!   ")).toBeNull();
	});

	test("only a bang in the first column is a command", () => {
		expect(bashCommand("  !ls")).toBeNull();
	});

	test("a multi line paste runs its first line only", () => {
		expect(bashCommand("!ls\ngit status")).toBe("ls");
		expect(bashCommand("!git log\n--oneline")).toBe("git log");
	});

	test("a plain draft is a prompt, not a command", () => {
		expect(bashCommand("ls")).toBeNull();
		expect(bashCommand("")).toBeNull();
		expect(bashCommand("\n!ls")).toBeNull();
	});
});

describe("editDraft", () => {
	test("clear empties the message and the caret", () => {
		expect(editDraft("hello\nworld", 7, 7, "clear")).toEqual({ text: "", caret: 0 });
	});

	test("caret_start goes to the head of the message", () => {
		expect(editDraft("hello\nworld", 7, 7, "caret_start")).toEqual({ text: "hello\nworld", caret: 0 });
	});

	test("caret_end goes to the tail of the message", () => {
		expect(editDraft("hello\nworld", 2, 2, "caret_end")).toEqual({ text: "hello\nworld", caret: 11 });
	});

	test("kill_to_end drops the rest of the line, not the rest of the message", () => {
		expect(editDraft("hello world\nsecond", 5, 5, "kill_to_end")).toEqual({ text: "hello\nsecond", caret: 5 });
	});

	test("kill_to_end at the end of a line leaves the message alone", () => {
		expect(editDraft("hello\nsecond", 5, 5, "kill_to_end")).toEqual({ text: "hello\nsecond", caret: 5 });
	});

	test("kill_to_end on the last line drains to the end", () => {
		expect(editDraft("hello\nsecond", 8, 8, "kill_to_end")).toEqual({ text: "hello\nse", caret: 8 });
	});

	test("kill_to_end at the start of the message keeps the first line", () => {
		expect(editDraft("hello\nworld", 0, 0, "kill_to_end")).toEqual({ text: "\nworld", caret: 0 });
	});

	test("a selection is what the deleting actions take", () => {
		expect(editDraft("hello world", 0, 5, "kill_to_end")).toEqual({ text: " world", caret: 0 });
		expect(editDraft("hello world", 2, 5, "delete_word")).toEqual({ text: "he world", caret: 2 });
	});

	test("a backwards selection collapses the same way", () => {
		expect(editDraft("hello world", 5, 2, "delete_word")).toEqual({ text: "he world", caret: 2 });
		expect(editDraft("hello world", 5, 0, "kill_to_end")).toEqual({ text: " world", caret: 0 });
	});

	test("delete_word takes the word the caret sits at the end of", () => {
		expect(editDraft("hello world", 11, 11, "delete_word")).toEqual({ text: "hello ", caret: 6 });
	});

	test("delete_word at the head of a word takes the word before it, with the space", () => {
		expect(editDraft("hello world", 6, 6, "delete_word")).toEqual({ text: "world", caret: 0 });
	});

	test("delete_word at the head of the message has nothing to take", () => {
		expect(editDraft("hello", 0, 0, "delete_word")).toEqual({ text: "hello", caret: 0 });
	});

	test("delete_word under a caret inside a word takes its head", () => {
		expect(editDraft("hello world", 8, 8, "delete_word")).toEqual({ text: "hello rld", caret: 6 });
	});

	test("delete_word keeps the text after the caret and the lines below", () => {
		expect(editDraft("hello world\nsecond", 11, 11, "delete_word")).toEqual({ text: "hello \nsecond", caret: 6 });
		expect(editDraft("hello\nsecond", 12, 12, "delete_word")).toEqual({ text: "hello\n", caret: 6 });
	});

	test("delete_word walks back over a line break, because a newline is a space", () => {
		expect(editDraft("hello\nsecond", 6, 6, "delete_word")).toEqual({ text: "second", caret: 0 });
	});
});

describe("insertText", () => {
	test("inserts at the head", () => {
		expect(insertText("hello", 0, "|")).toEqual({ text: "|hello", caret: 1 });
	});

	test("inserts at the caret", () => {
		expect(insertText("hello", 2, "|")).toEqual({ text: "he|llo", caret: 3 });
	});

	test("inserts at the tail", () => {
		expect(insertText("hello", 5, "|")).toEqual({ text: "hello|", caret: 6 });
	});

	test("a symbol that needs escaping is inserted as a character, not as markup", () => {
		expect(insertText("write ", 6, "`$&")).toEqual({ text: "write `$&", caret: 9 });
	});
});
