// The `@` and `/` menu above the composer: one row per completion, the active
// row highlighted and scrolled into view. It holds no state of its own, because
// the composer owns the message, the caret, the fetch and the keyboard, and the
// menu only reports what a finger picked or hovered.

import { useEffect, useRef } from "preact/hooks";
import type { CompletionItem } from "../lib/completion";
import { fileSymbol } from "../lib/symbols";
import { Symbol } from "./symbol";
import "./completion.css";

export interface CompletionMenuProps {
	items: readonly CompletionItem[];
	/** The index the composer's arrows and Tab act on. */
	active: number;
	onPick(index: number): void;
	onHighlight(index: number): void;
}

export function CompletionMenu({ items, active, onPick, onHighlight }: CompletionMenuProps) {
	const activeRow = useRef<HTMLButtonElement>(null);

	// The arrows can walk the selection past the visible rows of a long file
	// list, so the active row follows the finger and the keys.
	useEffect(() => {
		activeRow.current?.scrollIntoView({ block: "nearest" });
	}, [active, items]);

	// A tap must not blur the textarea, or the phone closes the keyboard the
	// next character needs.
	const keepFocus = (event: Event) => event.preventDefault();

	if (items.length === 0) return null;
	return (
		<div class="completion-menu" role="listbox" aria-label="Completions">
			{items.map((item, index) => (
				<button
					key={item.id}
					type="button"
					ref={index === active ? activeRow : undefined}
					role="option"
					aria-selected={index === active}
					class="completion-row"
					onMouseDown={keepFocus}
					onPointerEnter={() => onHighlight(index)}
					onClick={() => onPick(index)}
				>
					{/* Command rows are labelled with their slash, file rows with a path. */}
					<Symbol k={item.label.startsWith("/") ? "ui.code" : fileSymbol(item.label, item.dir)} />
					<span class="completion-label">{item.label}</span>
					{item.detail === "" ? null : <span class="completion-detail">{item.detail}</span>}
				</button>
			))}
		</div>
	);
}
