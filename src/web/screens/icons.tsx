// Stroke icons drawn with currentColor so every icon takes its colour from a theme variable.

export function BackIcon() {
	return (
		<svg viewBox="0 0 24 24" aria-hidden="true">
			<path d="M15 5l-7 7 7 7" />
		</svg>
	);
}

export function LaptopIcon() {
	return (
		<svg viewBox="0 0 24 24" aria-hidden="true">
			<rect x="4" y="5" width="16" height="11" rx="1.5" />
			<path d="M2 20h20" />
		</svg>
	);
}

export function RefreshIcon() {
	return (
		<svg viewBox="0 0 24 24" aria-hidden="true">
			<path d="M20 12a8 8 0 1 1-2.34-5.66" />
			<path d="M20 4v5h-5" />
		</svg>
	);
}

export function PowerIcon() {
	return (
		<svg viewBox="0 0 24 24" aria-hidden="true">
			<path d="M12 3v8" />
			<path d="M6.3 6.8a8 8 0 1 0 11.4 0" />
		</svg>
	);
}

export function DownIcon() {
	return (
		<svg viewBox="0 0 24 24" aria-hidden="true">
			<path d="M6 9l6 6 6-6" />
		</svg>
	);
}

/** The Burrow mark: the same arch as the app icon. */
export function BurrowMark({ class: className }: { class?: string }) {
	return (
		<svg class={className} viewBox="0 0 512 512" aria-hidden="true">
			<path d="M112 392 V252 C112 166 176 112 256 112 C336 112 400 166 400 252 V392 Z M188 392 V274 C188 236 218 208 256 208 C294 208 324 236 324 274 V392 Z" />
		</svg>
	);
}
