// The key bar: the strip above the composer that carries the omp chords and the
// characters the phone keyboard buries in a second layer (the Samsung keyboard
// hides backtick, the braces, and most of the shell punctuation). It holds no
// state of its own: it reports taps and the composer owns the armed modifiers,
// because the same strip will send raw keys once Tern lands.

import { CHORDS, type ChordModifier } from "../lib/keys";
import "./key-bar.css";

export interface KeyBarProps {
	armed: readonly ChordModifier[];
	onModifier(modifier: ChordModifier): void;
	onKey(key: string): void;
	onSymbol(text: string): void;
	disabled?: boolean;
}

const MODIFIERS: readonly ChordModifier[] = ["ctrl", "alt", "shift"];

const MODIFIER_LABEL: Record<ChordModifier, string> = { ctrl: "Ctrl", alt: "Alt", shift: "Shift" };

/** "Ctrl+C abort, Ctrl+P models, ...": what one tap on a modifier arms. */
function modifierTitle(modifier: ChordModifier): string {
	return CHORDS.filter((chord) => chord.modifier === modifier)
		.map((chord) => {
			const key = chord.key.length === 1 ? chord.key.toUpperCase() : chord.key;
			return `${MODIFIER_LABEL[modifier]}+${key} ${chord.action.replace(/_/g, " ")}`;
		})
		.join(", ");
}

const FIXED_KEYS: readonly { readonly key: string; readonly label: string; readonly title: string }[] = [
	{ key: "Escape", label: "Esc", title: "Escape" },
	{ key: "Tab", label: "Tab", title: "Tab: accept the completion" },
	{ key: "ArrowUp", label: "\u2191", title: "ArrowUp: move the completion selection up" },
	{ key: "ArrowDown", label: "\u2193", title: "ArrowDown: move the completion selection down" },
	{ key: "ArrowLeft", label: "\u2190", title: "ArrowLeft" },
	{ key: "ArrowRight", label: "\u2192", title: "ArrowRight" },
];

const SYMBOLS: readonly string[] = [
	"`", "~", "|", "$", "&", "*", "%", "^", "_", "=", "+", "-",
	"[", "]", "{", "}", "(", ")", "<", ">", "/", "\\", "@", "#",
	"!", "?", ":", ";", "'", '"', ".", ",",
];

export function KeyBar({ armed, onModifier, onKey, onSymbol, disabled = false }: KeyBarProps) {
	// Without this the tap blurs the textarea and the phone closes its keyboard,
	// which would make the bar useless for the typing it exists to help.
	const keepFocus = (event: Event) => event.preventDefault();

	return (
		<div class="key-bar" role="group" aria-label="Key bar">
			<div class="key-group">
				{MODIFIERS.map((modifier) => (
					<button
						key={modifier}
						type="button"
						class={armed.includes(modifier) ? "key-btn key-mod is-armed" : "key-btn key-mod"}
						aria-pressed={armed.includes(modifier)}
						title={modifierTitle(modifier)}
						disabled={disabled}
						onMouseDown={keepFocus}
						onClick={() => onModifier(modifier)}
					>
						{MODIFIER_LABEL[modifier]}
					</button>
				))}
			</div>
			<div class="key-group">
				{FIXED_KEYS.map((fixed) => (
					<button
						key={fixed.key}
						type="button"
						class="key-btn key-fixed"
						title={fixed.title}
						disabled={disabled}
						onMouseDown={keepFocus}
						onClick={() => onKey(fixed.key)}
					>
						{fixed.label}
					</button>
				))}
			</div>
			<div class="key-group">
				{SYMBOLS.map((symbol) => (
					<button
						key={symbol}
						type="button"
						class="key-btn key-sym"
						disabled={disabled}
						onMouseDown={keepFocus}
						onClick={() => onSymbol(symbol)}
					>
						{symbol}
					</button>
				))}
			</div>
		</div>
	);
}
