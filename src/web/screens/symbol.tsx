import type { SymbolKey } from "../lib/symbols";
import { SYMBOLS } from "../lib/symbols";

/**
 * Renders one nerd glyph from the shared table. Every icon in the phone UI goes
 * through here so the family, the size and the accessible label stay in one
 * place: a decoded glyph is invisible to a screen reader, so a labelled symbol
 * carries `role="img"` and an unlabelled one is hidden from the tree.
 */
export function Symbol({ k, class: className, label }: { k: SymbolKey; class?: string; label?: string }) {
	return (
		<span class={className === undefined ? "icon" : `icon ${className}`} aria-hidden={label === undefined ? "true" : undefined} role={label === undefined ? undefined : "img"} aria-label={label}>
			{SYMBOLS[k]}
		</span>
	);
}
