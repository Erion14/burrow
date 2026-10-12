// Pure mapping between omp extension UI frames and the phone's DialogView.
// Field names beyond rpc.md (editor prefill) are guesses and read defensively.

import type { DialogAnswer } from "../../shared/protocol";
import type { DialogQuestion, DialogQuestionOption, DialogView } from "../../shared/types";
import type { OmpEvent } from "../omp/port";

type Rec = Record<string, unknown>;

function isRec(value: unknown): value is Rec {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown, fallback = ""): string {
	return typeof value === "string" ? value : fallback;
}

function normaliseOption(raw: unknown): DialogQuestionOption | null {
	if (typeof raw === "string") return { label: raw };
	if (!isRec(raw) || typeof raw.label !== "string") return null;
	const option: DialogQuestionOption = { label: raw.label };
	if (typeof raw.description === "string" && raw.description !== "") option.description = raw.description;
	if (typeof raw.preview === "string" && raw.preview !== "") option.preview = raw.preview;
	return option;
}

function normaliseQuestion(raw: unknown, index: number): DialogQuestion | null {
	if (!isRec(raw)) return null;
	const rawOptions = Array.isArray(raw.options) ? raw.options : [];
	const options: DialogQuestionOption[] = [];
	let recommended: number | undefined =
		typeof raw.recommended === "number" && Number.isInteger(raw.recommended) ? raw.recommended : undefined;
	let recommendedLabel: string | undefined;
	rawOptions.forEach((entry, i) => {
		const option = normaliseOption(entry);
		if (!option) return;
		if (i === recommended) recommendedLabel = option.label;
		// omp never sends "Other"; the phone always offers free text itself.
		if (option.label.trim().toLowerCase() === "other") return;
		options.push(option);
	});
	if (recommendedLabel !== undefined) {
		const mapped = options.findIndex((o) => o.label === recommendedLabel);
		recommended = mapped >= 0 ? mapped : undefined;
	} else {
		recommended = undefined;
	}
	const question: DialogQuestion = {
		id: typeof raw.id === "string" && raw.id !== "" ? raw.id : String(index),
		question: str(raw.question),
		options,
		multi: raw.multi === true,
	};
	if (typeof raw.header === "string" && raw.header !== "") question.header = raw.header;
	if (recommended !== undefined) question.recommended = recommended;
	return question;
}

export function toDialogView(frame: OmpEvent): DialogView | null {
	if (frame.type !== "extension_ui_request") return null;
	const id = frame.id;
	if (typeof id !== "string" || id === "") return null;
	const timeoutMs = typeof frame.timeout === "number" && frame.timeout > 0 ? frame.timeout : undefined;
	const withTimeout = <T extends DialogView>(view: T): T => (timeoutMs === undefined ? view : { ...view, timeoutMs });
	const title = str(frame.title);
	const message = str(frame.message);

	switch (frame.method) {
		case "select": {
			const options = Array.isArray(frame.options) ? frame.options.filter((o): o is string => typeof o === "string") : [];
			const details = Array.isArray(frame.optionDetails) ? frame.optionDetails : [];
			const optionDetails = options.map((_, i) => {
				const detail = details[i];
				if (typeof detail === "string") return detail;
				return isRec(detail) ? str(detail.description) : "";
			});
			return withTimeout({ id, kind: "select", title, message, options, optionDetails });
		}
		case "confirm":
			return withTimeout({ id, kind: "confirm", title, message });
		case "input":
			return withTimeout({ id, kind: "input", title, message, placeholder: str(frame.placeholder) });
		case "editor":
			// Prefill field name is not documented; accept the likely variants.
			return withTimeout({ id, kind: "editor", title, message, text: str(frame.prefill ?? frame.text ?? frame.value) });
		case "ask": {
			const raw = Array.isArray(frame.questions) ? frame.questions : [];
			const questions: DialogQuestion[] = [];
			raw.forEach((entry, i) => {
				const q = normaliseQuestion(entry, i);
				if (q) questions.push(q);
			});
			return withTimeout({ id, kind: "ask", questions });
		}
		default:
			return null;
	}
}

export function toCancelResponse(dialogId: string): OmpEvent {
	return { type: "extension_ui_response", id: dialogId, cancelled: true };
}

export function toUiResponse(dialog: DialogView, answer: DialogAnswer): OmpEvent {
	const id = dialog.id;
	switch (dialog.kind) {
		case "select":
			if (answer.kind !== "select") return toCancelResponse(id);
			return { type: "extension_ui_response", id, value: answer.value };
		case "input":
		case "editor":
			if (answer.kind !== "input" && answer.kind !== "editor") return toCancelResponse(id);
			return { type: "extension_ui_response", id, value: answer.value };
		case "confirm":
			if (answer.kind !== "confirm") return toCancelResponse(id);
			return { type: "extension_ui_response", id, confirmed: answer.confirmed };
		case "ask": {
			if (answer.kind !== "ask") return toCancelResponse(id);
			const answers = dialog.questions.map((question) => {
				const given = answer.answers.find((a) => a.id === question.id);
				const known = new Set(question.options.map((o) => o.label));
				const custom = (given?.customInput ?? "").trim();
				let selected = [...new Set(given?.selectedOptions ?? [])].filter((label) => known.has(label));
				if (!question.multi) {
					// omp rejects an option together with custom text on a single select; typed text wins.
					selected = custom !== "" ? [] : selected.slice(0, 1);
				}
				const entry: { id: string; selectedOptions: string[]; customInput?: string } = {
					id: question.id,
					selectedOptions: selected,
				};
				if (custom !== "") entry.customInput = custom;
				return entry;
			});
			return { type: "extension_ui_response", id, answers };
		}
	}
}
