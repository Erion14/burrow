// The one drawing that is not a font glyph. Every icon the UI draws is a text node from
// ../lib/symbols rendered through ./symbol, so this file holds only the app's own mark.

/** The Burrow mark: the same arch as the app icon. */
export function BurrowMark({ class: className }: { class?: string }) {
	return (
		<svg class={className} viewBox="0 0 512 512" aria-hidden="true">
			<path d="M112 392 V252 C112 166 176 112 256 112 C336 112 400 166 400 252 V392 Z M188 392 V274 C188 236 218 208 256 208 C294 208 324 236 324 274 V392 Z" />
		</svg>
	);
}
