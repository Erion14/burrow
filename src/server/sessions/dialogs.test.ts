import { describe, expect, test } from "bun:test";
import type { DialogView } from "../../shared/types";
import { toCancelResponse, toDialogView, toUiResponse } from "./dialogs";

const req = (extra: Record<string, unknown>) => ({ type: "extension_ui_request", id: "ui_1", ...extra });

describe("toDialogView", () => {
	test("select aligns optionDetails and carries timeout", () => {
		const view = toDialogView(req({ method: "select", title: "Pick", options: ["a", "b", "c"], optionDetails: [{ description: "A!" }, {}], timeout: 30000 }));
		expect(view).toEqual({ id: "ui_1", kind: "select", title: "Pick", message: "", options: ["a", "b", "c"], optionDetails: ["A!", "", ""], timeoutMs: 30000 });
	});

	test("confirm, input, editor", () => {
		expect(toDialogView(req({ method: "confirm", title: "T", message: "Go?" }))).toEqual({ id: "ui_1", kind: "confirm", title: "T", message: "Go?" });
		expect(toDialogView(req({ method: "input", title: "T", placeholder: "name" }))).toMatchObject({ kind: "input", placeholder: "name" });
		expect(toDialogView(req({ method: "editor", title: "T", prefill: "draft" }))).toMatchObject({ kind: "editor", text: "draft" });
	});

	test("non dialog frames give null", () => {
		expect(toDialogView(req({ method: "notify", message: "hi" }))).toBeNull();
		expect(toDialogView(req({ method: "cancel", targetId: "x" }))).toBeNull();
		expect(toDialogView({ type: "agent_start" })).toBeNull();
		expect(toDialogView({ type: "extension_ui_request", method: "confirm" })).toBeNull();
	});

	test("ask normalises questions and never keeps Other", () => {
		const view = toDialogView(
			req({
				method: "ask",
				timeout: 5000,
				questions: [
					{ id: "db", question: "Which?", options: [{ label: "Postgres" }, { label: "Other" }, { label: "SQLite", description: "small" }], recommended: 2 },
					{ id: "f", question: "Features?", header: "H", options: [{ label: "Auth" }], multi: true },
				],
			}),
		);
		expect(view).toEqual({
			id: "ui_1",
			kind: "ask",
			timeoutMs: 5000,
			questions: [
				{ id: "db", question: "Which?", options: [{ label: "Postgres" }, { label: "SQLite", description: "small" }], multi: false, recommended: 1 },
				{ id: "f", question: "Features?", header: "H", options: [{ label: "Auth" }], multi: true },
			],
		});
	});
});

const ask: DialogView = {
	id: "ui_9",
	kind: "ask",
	questions: [
		{ id: "db", question: "DB?", options: [{ label: "Postgres" }, { label: "SQLite" }], multi: false },
		{ id: "features", question: "Features?", options: [{ label: "Auth" }, { label: "Billing" }, { label: "Search" }], multi: true },
	],
};

describe("toUiResponse", () => {
	test("select, input, editor use value; confirm uses confirmed", () => {
		const select = toDialogView(req({ method: "select", title: "t", options: ["a"] })) as DialogView;
		expect(toUiResponse(select, { kind: "select", value: "a" })).toEqual({ type: "extension_ui_response", id: "ui_1", value: "a" });
		const input = toDialogView(req({ method: "input", title: "t" })) as DialogView;
		expect(toUiResponse(input, { kind: "input", value: "x" })).toEqual({ type: "extension_ui_response", id: "ui_1", value: "x" });
		const editor = toDialogView(req({ method: "editor", title: "t" })) as DialogView;
		expect(toUiResponse(editor, { kind: "editor", value: "y" })).toEqual({ type: "extension_ui_response", id: "ui_1", value: "y" });
		const confirm = toDialogView(req({ method: "confirm", title: "t" })) as DialogView;
		expect(toUiResponse(confirm, { kind: "confirm", confirmed: false })).toEqual({ type: "extension_ui_response", id: "ui_1", confirmed: false });
	});

	test("mismatched answer kind cancels", () => {
		const confirm = toDialogView(req({ method: "confirm", title: "t" })) as DialogView;
		expect(toUiResponse(confirm, { kind: "select", value: "a" })).toEqual(toCancelResponse("ui_1"));
	});

	test("cancel response shape", () => {
		expect(toCancelResponse("z")).toEqual({ type: "extension_ui_response", id: "z", cancelled: true });
	});

	test("single select with custom text, multi select", () => {
		const out = toUiResponse(ask, {
			kind: "ask",
			answers: [
				{ id: "features", selectedOptions: ["Auth", "Search"] },
				{ id: "db", selectedOptions: [], customInput: "  DuckDB " },
			],
		});
		expect(out).toEqual({
			type: "extension_ui_response",
			id: "ui_9",
			answers: [
				{ id: "db", selectedOptions: [], customInput: "DuckDB" },
				{ id: "features", selectedOptions: ["Auth", "Search"] },
			],
		});
	});

	test("missing question gets an empty entry; unknown ids are dropped; blank custom omitted", () => {
		const out = toUiResponse(ask, { kind: "ask", answers: [{ id: "features", selectedOptions: ["Billing"], customInput: "   " }, { id: "ghost", selectedOptions: ["x"] }] });
		expect(out.answers).toEqual([
			{ id: "db", selectedOptions: [] },
			{ id: "features", selectedOptions: ["Billing"] },
		]);
	});

	test("duplicate and unknown labels are removed; single select keeps one", () => {
		const out = toUiResponse(ask, {
			kind: "ask",
			answers: [
				{ id: "db", selectedOptions: ["Postgres", "SQLite"] },
				{ id: "features", selectedOptions: ["Auth", "Auth", "Nope", "Search"] },
			],
		});
		expect(out.answers).toEqual([
			{ id: "db", selectedOptions: ["Postgres"] },
			{ id: "features", selectedOptions: ["Auth", "Search"] },
		]);
	});
});
