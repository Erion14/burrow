// The phone's chord table: every modifier plus key combination the composer
// answers with an omp action. A press that is not in the table is left alone,
// so the character types normally instead of being eaten by the key handler.

export type ChordModifier = "ctrl" | "alt" | "shift";

export type ChordAction =
	| "abort"
	| "models"
	| "tools_expand"
	| "thinking_blocks"
	| "thinking_cycle"
	| "caret_start"
	| "caret_end"
	| "kill_to_end"
	| "clear"
	| "delete_word"
	| "dequeue"
	| "accept_completion"
	| "completion_up"
	| "completion_down"
	| "escape";

export interface ChordRow {
	/** The held modifier, or null for a bare key. */
	readonly modifier: ChordModifier | null;
	/** A KeyboardEvent.key value; a single letter matches in either case. */
	readonly key: string;
	readonly action: ChordAction;
}

/** The chords in the order the key bar lists them in its titles. */
export const CHORDS: readonly ChordRow[] = [
	{ modifier: "ctrl", key: "c", action: "abort" },
	{ modifier: "ctrl", key: "p", action: "models" },
	{ modifier: "ctrl", key: "t", action: "thinking_blocks" },
	{ modifier: "ctrl", key: "o", action: "tools_expand" },
	{ modifier: "ctrl", key: "a", action: "caret_start" },
	{ modifier: "ctrl", key: "e", action: "caret_end" },
	{ modifier: "ctrl", key: "k", action: "kill_to_end" },
	{ modifier: "ctrl", key: "u", action: "clear" },
	{ modifier: "ctrl", key: "l", action: "clear" },
	{ modifier: "ctrl", key: "w", action: "delete_word" },
	{ modifier: "shift", key: "Tab", action: "thinking_cycle" },
	{ modifier: "alt", key: "ArrowUp", action: "dequeue" },
	{ modifier: null, key: "Tab", action: "accept_completion" },
	{ modifier: null, key: "ArrowUp", action: "completion_up" },
	{ modifier: null, key: "ArrowDown", action: "completion_down" },
	{ modifier: null, key: "Escape", action: "escape" },
];

/** One letter case, so a chord is the same whether Shift was part of the press. */
function chordId(modifier: ChordModifier | null, key: string): string {
	return `${modifier ?? ""}|${key.length === 1 ? key.toLowerCase() : key}`;
}

// Built from the table above, so a chord is never listed twice.
const ACTION_BY_CHORD: Record<string, ChordAction | undefined> = Object.fromEntries(
	CHORDS.map((chord) => [chordId(chord.modifier, chord.key), chord.action]),
);

export function chordAction(modifiers: readonly ChordModifier[], key: string): ChordAction | null {
	// A chord holds at most one modifier. Ctrl+Shift+C and Ctrl+H are unbound on
	// purpose: returning null there is what lets the composer type the character.
	if (modifiers.length > 1) return null;
	return ACTION_BY_CHORD[chordId(modifiers[0] ?? null, key)] ?? null;
}
