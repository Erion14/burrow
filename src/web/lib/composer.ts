// The composer's own string rules, kept out of the screen so the key bar's
// chords and the `!` bash mode can be tested without a DOM. Nothing here knows
// about the socket, the caret element or the completion menu: `editDraft` takes
// the textarea's own selection pair and hands back the message and the caret it
// leaves behind, which the screen writes back through `setSelectionRange`.

/** The four edits the key bar addresses by name, plus the caret moves. */
export type EditAction = "kill_to_end" | "delete_word" | "clear" | "caret_start" | "caret_end";

export interface DraftEdit {
	text: string;
	caret: number;
}

const SPACE = /\s/;

/** A message that starts with a bang runs in the session's shell, not in the model. */
export function bashMode(draft: string): boolean {
	return draft.startsWith("!");
}

/**
 * The command a `!` message runs, or null when there is nothing to run. Only a
 * bang in the first column counts, so "  !ls" stays a prompt, and only the first
 * line runs, because the omp `bash` call takes one command.
 */
export function bashCommand(draft: string): string | null {
	if (!bashMode(draft)) return null;
	const line = draft.slice(1).split("\n")[0] ?? "";
	const command = line.trim();
	return command === "" ? null : command;
}

/**
 * The message and caret after an edit. A non-empty selection is the range the
 * deleting actions take, so a request made with a selection never reaches past
 * it; a bare caret addresses the word or the line it sits in.
 */
export function editDraft(
	text: string,
	selectionStart: number,
	selectionEnd: number,
	action: EditAction,
): DraftEdit {
	if (action === "clear") return { text: "", caret: 0 };
	if (action === "caret_start") return { text, caret: 0 };
	if (action === "caret_end") return { text, caret: text.length };

	const from = Math.max(0, Math.min(selectionStart, selectionEnd));
	const to = Math.min(text.length, Math.max(selectionStart, selectionEnd));
	if (from !== to) return { text: text.slice(0, from) + text.slice(to), caret: from };

	if (action === "kill_to_end") {
		// To the end of the line, not the end of the message: a multi-line draft
		// keeps the paragraphs below the one being edited.
		const lineEnd = text.indexOf("\n", from);
		const end = lineEnd === -1 ? text.length : lineEnd;
		return { text: text.slice(0, from) + text.slice(end), caret: from };
	}

	// delete_word: the whitespace before the caret goes with the word, which is
	// what makes it repeatable at the head of a word as well as at its end.
	let at = from;
	while (at > 0 && SPACE.test(text[at - 1] ?? "")) at--;
	while (at > 0 && !SPACE.test(text[at - 1] ?? "")) at--;
	return { text: text.slice(0, at) + text.slice(from), caret: at };
}

/** A character from the symbol row, typed where the caret is. */
export function insertText(text: string, caret: number, insert: string): DraftEdit {
	return { text: text.slice(0, caret) + insert + text.slice(caret), caret: caret + insert.length };
}
