// The `@` and `/` completion menus of the composer, as pure string work: no
// DOM, no fetch, no commands list. `completionAt` locates the token under the
// caret, `commandItems` turns it into rows, and `applyCompletion` writes the
// picked row back into the message. The composer owns the socket, the file
// fetch, and the selection index.

import type { CommandView } from "../../shared/types";

export type CompletionMenu = "file" | "command";

/**
 * The token the caret sits in. `start` and `end` are the message slice
 * `applyCompletion` replaces, `[start, end)`, and `end` is always the caret, so
 * a pick never eats text the user typed after it.
 */
export interface TokenRange {
	menu: CompletionMenu;
	query: string;
	start: number;
	end: number;
}

export interface CompletionItem {
	id: string;
	label: string;
	/** The dim second column: a description, or the command's argument hint. */
	detail: string;
	insert: string;
	dir: boolean;
}

const SPACE = /\s/;

/** The brackets a `@` path can open right after, as in "(see @src". */
const OPENERS: Record<string, true> = { "(": true, "[": true, "{": true };

/**
 * The file token under the caret: an `@` at the start of the message or right
 * after whitespace or an opening bracket, whose run of non-whitespace reaches
 * the caret. The query is what is typed between the `@` and the caret, so a
 * caret in the middle of the run narrows to the part before it.
 */
function fileAt(text: string, caret: number): TokenRange | null {
	// A caret that sits on whitespace (or at position zero) is in no run, which
	// is what closes the menu when the user types a space after the path.
	let runStart = caret;
	while (runStart > 0 && !SPACE.test(text[runStart - 1])) runStart--;
	for (let at = runStart; at < caret; at++) {
		if (text[at] !== "@") continue;
		const preceding = text[at - 1];
		if (preceding !== undefined && !SPACE.test(preceding) && OPENERS[preceding] !== true) continue;
		return { menu: "file", query: text.slice(at + 1, caret), start: at, end: caret };
	}
	return null;
}

/**
 * The command token under the caret: the message's first non-space run when it
 * starts with `/`, with the caret inside the run or after it. A space after the
 * word opens one subcommand level, and the token keeps the name in its query:
 * `commandItems` has only the token to find the command the level belongs to.
 */
function commandAt(text: string, caret: number): TokenRange | null {
	let start = 0;
	while (start < text.length && SPACE.test(text[start])) start++;
	if (text[start] !== "/") return null;
	if (caret < start) return null;
	let runEnd = start;
	while (runEnd < text.length && !SPACE.test(text[runEnd])) runEnd++;
	// Past the word means the caret is in the argument; only a space there opens
	// the subcommand level, so a caret in a run of spaces again matches nothing.
	if (caret > runEnd && !SPACE.test(text[runEnd] ?? "")) return null;
	return { menu: "command", query: text.slice(start + 1, caret), start, end: caret };
}

/**
 * The token under the caret, or null when neither menu applies. The command
 * token wins: it can only ever start the message, file tokens come later.
 * Whether a command token matches anything is `commandItems`' answer, so a
 * slash word no command answers yields no rows rather than no token.
 */
export function completionAt(text: string, caret: number): TokenRange | null {
	if (caret < 0 || caret > text.length) return null;
	return commandAt(text, caret) ?? fileAt(text, caret);
}

/** omp's ranking: a name prefix, then a name substring, then nothing at all. */
function matchRank(query: string, name: string): number {
	if (query === "") return 0;
	const needle = query.toLowerCase();
	const haystack = name.toLowerCase();
	if (haystack.startsWith(needle)) return 0;
	return haystack.includes(needle) ? 1 : -1;
}

/**
 * The rows for a command token: command names for a bare token, one command's
 * subcommands for a token with a second word. Matches come prefix first, then
 * substring, in the order omp lists them.
 */
export function commandItems(commands: CommandView[], token: TokenRange): CompletionItem[] {
	if (token.menu !== "command") return [];
	const items: CompletionItem[] = [];
	const space = token.query.indexOf(" ");
	if (space !== -1) {
		const name = token.query.slice(0, space);
		const command = commands.find((candidate) => candidate.name === name);
		if (command === undefined || command.subcommands.length === 0) return [];
		const query = token.query.slice(space + 1);
		for (const rank of [0, 1]) {
			for (const sub of command.subcommands) {
				if (matchRank(query, sub.name) !== rank) continue;
				items.push({
					id: `/${command.name} ${sub.name}`,
					label: sub.name,
					// A subcommand carries no hint of its own, so the parent's stands in.
					detail: sub.description === "" ? command.hint : sub.description,
					insert: `/${command.name} ${sub.name} `,
					dir: false,
				});
			}
		}
		return items;
	}
	for (const rank of [0, 1]) {
		for (const command of commands) {
			if (matchRank(token.query, command.name) !== rank) continue;
			items.push({
				id: `/${command.name}`,
				label: `/${command.name}`,
				detail: command.description === "" ? command.hint : command.description,
				insert: `/${command.name} `,
				dir: false,
			});
		}
	}
	return items;
}

/** The file menu's rows from `GET /api/files`; a directory inserts `path/`. */
export function fileItems(entries: readonly { path: string; dir: boolean }[]): CompletionItem[] {
	return entries.map((entry) => ({
		id: `@${entry.path}`,
		label: entry.path,
		detail: "",
		insert: entry.dir ? `${entry.path}/` : `@${entry.path}`,
		dir: entry.dir,
	}));
}

/**
 * The message and caret after a pick. Only `[token.start, token.end)` moves, so
 * an argument the user already typed after the token stays put (which is why a
 * command insert can leave two spaces in a row: the caret lands on the insert,
 * after the space it ends with). The incoming caret is not consulted: the token
 * its caller matched carries the range, and it may be stale by a keystroke.
 */
export function applyCompletion(
	text: string,
	caret: number,
	token: TokenRange,
	item: CompletionItem,
): { text: string; caret: number } {
	void caret;
	return { text: text.slice(0, token.start) + item.insert + text.slice(token.end), caret: token.start + item.insert.length };
}
