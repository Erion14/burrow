import { describe, expect, test } from "bun:test";
import type { DialogQuestion } from "../../shared/types";
import { askAnswer, confirmAnswer, selectAnswer, textAnswer } from "./dialog-answers";

const questions: DialogQuestion[] = [
	{ id: "db", question: "Which database?", options: [{ label: "Postgres" }, { label: "SQLite" }], multi: false },
	{ id: "features", question: "Which features?", options: [{ label: "Auth" }, { label: "Billing" }, { label: "Search" }], multi: true },
];

describe("simple answers", () => {
	test("select, confirm and text shapes", () => {
		expect(selectAnswer("a")).toEqual({ kind: "select", value: "a" });
		expect(confirmAnswer(false)).toEqual({ kind: "confirm", confirmed: false });
		expect(textAnswer("input", "hi")).toEqual({ kind: "input", value: "hi" });
		expect(textAnswer("editor", "x\ny")).toEqual({ kind: "editor", value: "x\ny" });
	});
});

describe("askAnswer", () => {
	test("one entry per question in order, custom trimmed", () => {
		const result = askAnswer(questions, {
			db: { selected: [], custom: "  DuckDB " },
			features: { selected: ["Auth", "Search"] },
		});
		expect(result).toEqual({
			ok: true,
			answer: {
				kind: "ask",
				answers: [
					{ id: "db", selectedOptions: [], customInput: "DuckDB" },
					{ id: "features", selectedOptions: ["Auth", "Search"] },
				],
			},
		});
	});

	test("empty or blank custom input is omitted; multi may be empty", () => {
		const result = askAnswer(questions, {
			db: { selected: ["SQLite"], custom: "   " },
			features: { selected: [] },
		});
		expect(result).toEqual({
			ok: true,
			answer: {
				kind: "ask",
				answers: [
					{ id: "db", selectedOptions: ["SQLite"] },
					{ id: "features", selectedOptions: [] },
				],
			},
		});
	});

	test("answers follow question order regardless of selection key order", () => {
		const result = askAnswer(questions, { features: { selected: [] }, db: { selected: ["Postgres"] } });
		expect(result.ok && result.answer.answers.map((a) => a.id)).toEqual(["db", "features"]);
	});

	test("single select with an option and custom text is rejected", () => {
		const result = askAnswer(questions, { db: { selected: ["Postgres"], custom: "DuckDB" }, features: { selected: [] } });
		expect(result.ok).toBe(false);
	});

	test("single select with two options is rejected", () => {
		const result = askAnswer(questions, { db: { selected: ["Postgres", "SQLite"] }, features: { selected: [] } });
		expect(result.ok).toBe(false);
	});

	test("single select with nothing chosen is rejected", () => {
		const result = askAnswer(questions, { db: { selected: [] }, features: { selected: [] } });
		expect(result.ok).toBe(false);
	});

	test("a missing question answer is a failure", () => {
		const result = askAnswer(questions, { db: { selected: ["Postgres"] } });
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toContain("features");
	});

	test("an unknown label is a failure", () => {
		const result = askAnswer(questions, { db: { selected: ["Mongo"] }, features: { selected: [] } });
		expect(result.ok).toBe(false);
	});

	test("duplicate labels collapse", () => {
		const result = askAnswer(questions, { db: { selected: ["Postgres"] }, features: { selected: ["Auth", "Auth", "Search"] } });
		expect(result.ok && result.answer.answers[1]!.selectedOptions).toEqual(["Auth", "Search"]);
	});

	test("multi select with custom text keeps both", () => {
		const result = askAnswer(questions, { db: { selected: ["Postgres"] }, features: { selected: ["Auth"], custom: "Email" } });
		expect(result.ok && result.answer.answers[1]).toEqual({ id: "features", selectedOptions: ["Auth"], customInput: "Email" });
	});
});
