import type { AskAnswerItem, DialogAnswerAsk, DialogAnswerConfirm, DialogAnswerSelect, DialogAnswerText } from "../../shared/protocol";
import type { DialogQuestion } from "../../shared/types";

/** What the phone collected for one ask question. */
export interface QuestionSelection {
	selected: string[];
	custom?: string;
}

export type AskResult = { ok: true; answer: DialogAnswerAsk } | { ok: false; error: string };

export function selectAnswer(value: string): DialogAnswerSelect {
	return { kind: "select", value };
}

export function confirmAnswer(confirmed: boolean): DialogAnswerConfirm {
	return { kind: "confirm", confirmed };
}

export function textAnswer(kind: "input" | "editor", value: string): DialogAnswerText {
	return { kind, value };
}

/**
 * omp fails the whole `ask` tool call on any malformed answer instead of guessing, so every rule
 * is enforced here and surfaced to the user rather than sent.
 */
export function askAnswer(questions: DialogQuestion[], selections: Record<string, QuestionSelection | undefined>): AskResult {
	const answers: AskAnswerItem[] = [];
	for (const question of questions) {
		const selection = selections[question.id];
		if (selection === undefined) return { ok: false, error: `No answer for "${question.question}" (${question.id})` };

		const known = new Set(question.options.map((option) => option.label));
		const selectedOptions = [...new Set(selection.selected)];
		const unknown = selectedOptions.find((label) => !known.has(label));
		if (unknown !== undefined) return { ok: false, error: `"${unknown}" is not an option of ${question.id}` };

		const customInput = (selection.custom ?? "").trim();
		if (question.multi !== true) {
			if (selectedOptions.length > 1) return { ok: false, error: `Pick only one option for ${question.id}` };
			if (selectedOptions.length === 1 && customInput !== "") {
				return { ok: false, error: `Choose an option or type an answer for ${question.id}, not both` };
			}
			if (selectedOptions.length === 0 && customInput === "") return { ok: false, error: `Answer "${question.question}"` };
		}
		answers.push(customInput === "" ? { id: question.id, selectedOptions } : { id: question.id, selectedOptions, customInput });
	}
	return { ok: true, answer: { kind: "ask", answers } };
}
