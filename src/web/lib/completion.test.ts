// The completion menus are pure string work: where the caret's `@` or `/` token
// starts, which rows it offers, and what the composer's text becomes after a
// pick. These tests pin the omp shapes the plan copies: `@path` narrows the file
// menu, `/name` lists the commands, and a second word lists that command's
// subcommands.

import { describe, expect, test } from "bun:test";
import type { CommandView } from "../../shared/types";
import { applyCompletion, commandItems, completionAt, fileItems } from "./completion";

const COMMANDS: CommandView[] = [
	{
		name: "security",
		description: "Run a security scan",
		hint: "<path>",
		subcommands: [
			{ name: "scan", description: "Scan the working tree" },
			{ name: "audit", description: "Audit dependencies" },
			{ name: "report", description: "" },
		],
	},
	{ name: "compact", description: "", hint: "drop the old context", subcommands: [] },
	{ name: "status", description: "Show the session state", hint: "", subcommands: [] },
];

describe("completionAt", () => {
	test("a bare at sign opens the file menu with an empty query", () => {
		expect(completionAt("@", 1)).toEqual({ menu: "file", query: "", start: 0, end: 1 });
	});

	test("the file query is the text between the at sign and the caret", () => {
		expect(completionAt("hi @src/we", 10)).toEqual({ menu: "file", query: "src/we", start: 3, end: 10 });
		// A caret in the middle of the run narrows to what is typed before it.
		expect(completionAt("hi @src/we", 6)).toEqual({ menu: "file", query: "sr", start: 3, end: 6 });
	});

	test("an at sign inside a word is not a token", () => {
		expect(completionAt("mail@example", 12)).toBeNull();
	});

	test("a caret past the end of the run is not a token", () => {
		// Right after the space, and in the word that follows it.
		expect(completionAt("hi @src/we now", 11)).toBeNull();
		expect(completionAt("hi @src/we now", 12)).toBeNull();
	});

	test("whitespace and an opening bracket both start a file token", () => {
		expect(completionAt("see (@src", 9)).toEqual({ menu: "file", query: "src", start: 5, end: 9 });
	});

	test("text with neither shape has no token", () => {
		expect(completionAt("", 0)).toBeNull();
		expect(completionAt("hello", 5)).toBeNull();
		expect(completionAt("@src", 0)).toBeNull();
		// A caret still in the leading spaces is before the slash, not in its run.
		expect(completionAt("  /sec", 1)).toBeNull();
	});

	test("a leading slash run is a command token", () => {
		expect(completionAt("/sec", 4)).toEqual({ menu: "command", query: "sec", start: 0, end: 4 });
		// The caret may sit inside the run, not only at its end.
		expect(completionAt("/sec now", 3)).toEqual({ menu: "command", query: "se", start: 0, end: 3 });
	});

	test("a typed name followed by a space is the subcommand level", () => {
		expect(completionAt("/security s", 11)).toEqual({ menu: "command", query: "security s", start: 0, end: 11 });
		// The trailing space alone lists every subcommand.
		expect(completionAt("/security ", 10)).toEqual({ menu: "command", query: "security ", start: 0, end: 10 });
	});

	test("a slash run that matches no command offers no rows", () => {
		const token = completionAt("/x", 2);
		expect(token?.menu).toBe("command");
		expect(commandItems(COMMANDS, token!)).toEqual([]);
	});
});

describe("commandItems", () => {
	test("prefix matches come before substring matches", () => {
		const mixed: CommandView[] = [
			{ name: "compact", description: "", hint: "", subcommands: [] },
			{ name: "acme", description: "", hint: "", subcommands: [] },
			{ name: "zip", description: "", hint: "", subcommands: [] },
		];
		const token = completionAt("/ac", 3)!;
		expect(commandItems(mixed, token).map((item) => item.label)).toEqual(["/acme", "/compact"]);
	});

	test("a bare slash lists every command", () => {
		const token = completionAt("/", 1)!;
		expect(commandItems(COMMANDS, token).map((item) => item.label)).toEqual([
			"/security",
			"/compact",
			"/status",
		]);
	});

	test("a command row carries its description, its insert, and its circle-off default", () => {
		const token = completionAt("/stat", 5)!;
		expect(commandItems(COMMANDS, token)).toEqual([
			{ id: "/status", label: "/status", detail: "Show the session state", insert: "/status ", dir: false },
		]);
	});

	test("the detail falls back to the hint when there is no description", () => {
		const token = completionAt("/comp", 5)!;
		expect(commandItems(COMMANDS, token)).toEqual([
			{ id: "/compact", label: "/compact", detail: "drop the old context", insert: "/compact ", dir: false },
		]);
	});

	test("the subcommand level lists only that command's subcommands", () => {
		const token = completionAt("/security ", 10)!;
		expect(commandItems(COMMANDS, token).map((item) => item.label)).toEqual(["scan", "audit", "report"]);
		expect(commandItems(COMMANDS, token).map((item) => item.insert)).toEqual([
			"/security scan ",
			"/security audit ",
			"/security report ",
		]);
	});

	test("the subcommand level narrows by what follows the name", () => {
		const token = completionAt("/security au", 12)!;
		expect(commandItems(COMMANDS, token)).toEqual([
			{ id: "/security audit", label: "audit", detail: "Audit dependencies", insert: "/security audit ", dir: false },
		]);
	});

	test("a subcommand without a description falls back to the command's hint", () => {
		const token = completionAt("/security r", 11)!;
		expect(commandItems(COMMANDS, token)).toEqual([
			{ id: "/security report", label: "report", detail: "<path>", insert: "/security report ", dir: false },
		]);
	});

	test("a name without subcommands, or no command at all, lists nothing", () => {
		// /compact is a command, but the second word is not a level it answers.
		expect(commandItems(COMMANDS, completionAt("/compact ", 9)!)).toEqual([]);
		expect(commandItems(COMMANDS, completionAt("/nope x", 7)!)).toEqual([]);
	});

	test("a file token lists nothing", () => {
		expect(commandItems(COMMANDS, { menu: "file", query: "", start: 0, end: 1 })).toEqual([]);
	});
});

describe("fileItems", () => {
	test("a file inserts its path behind the at sign, a directory its path with a slash", () => {
		expect(fileItems([{ path: "src/lib", dir: true }, { path: "src/lib/a.ts", dir: false }])).toEqual([
			{ id: "@src/lib", label: "src/lib", detail: "", insert: "src/lib/", dir: true },
			{ id: "@src/lib/a.ts", label: "src/lib/a.ts", detail: "", insert: "@src/lib/a.ts", dir: false },
		]);
	});
});

describe("applyCompletion", () => {
	test("a file pick keeps the text before and after the token", () => {
		const text = "look at @src/we now";
		const token = completionAt(text, 15)!;
		const item = fileItems([{ path: "src/web.ts", dir: false }])[0]!;
		expect(applyCompletion(text, 15, token, item)).toEqual({ text: "look at @src/web.ts now", caret: 19 });
	});

	test("a directory pick replaces the at sign and reopens the menu after the slash", () => {
		const text = "look at @src/we now";
		const token = completionAt(text, 15)!;
		const item = fileItems([{ path: "src/web", dir: true }])[0]!;
		expect(applyCompletion(text, 15, token, item)).toEqual({ text: "look at src/web/ now", caret: 16 });
	});

	test("a command pick lands at the end of the message", () => {
		const text = "/sec";
		const token = completionAt(text, 4)!;
		const item = commandItems(COMMANDS, token)[0]!;
		expect(applyCompletion(text, 4, token, item)).toEqual({ text: "/security ", caret: 10 });
	});

	test("a command pick leaves an argument the user already typed alone", () => {
		const text = "/sec extra";
		const token = completionAt(text, 4)!;
		const item = commandItems(COMMANDS, token)[0]!;
		expect(applyCompletion(text, 4, token, item)).toEqual({ text: "/security  extra", caret: 10 });
	});

	test("a subcommand pick replaces the argument the user typed", () => {
		const text = "/security a";
		const token = completionAt(text, 11)!;
		const item = commandItems(COMMANDS, token)[0]!;
		expect(applyCompletion(text, 11, token, item)).toEqual({ text: "/security audit ", caret: 16 });
	});
});
