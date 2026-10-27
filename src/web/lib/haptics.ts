// Haptics for the phone. `navigator.vibrate` is absent on iOS Safari, refused
// when the page has no permission or is not visible, and some engines throw on
// the lookup itself, so every door here is a no-op door: a buzz is a garnish and
// must never cost the interaction it decorates. The host is injected so those
// doors can be walked in tests instead of on a phone.

/** The slice of `navigator` haptics touch, and the seam tests stand in for. */
export interface VibrationHost {
	vibrate?(pattern: number | number[]): unknown;
}

/** Short enough to read as the tap itself rather than as a notification. */
const TAP_PATTERN = 10;

/** Two ticks with a gap the motor can separate into "done". */
const SUCCESS_PATTERN = [10, 60, 10];

function activeVibrate(host: VibrationHost | null): ((pattern: number | number[]) => unknown) | null {
	try {
		const vibrate = host?.vibrate;
		// `bind` because the method wants its own navigator as `this`.
		return typeof vibrate === "function" ? vibrate.bind(host) : null;
	} catch {
		// A hardened webview throws on the property read itself.
		return null;
	}
}

/** The real navigator, or null in a runtime that has none. */
function phoneHost(): VibrationHost | null {
	try {
		return globalThis.navigator ?? null;
	} catch {
		return null;
	}
}

function buzz(host: VibrationHost | null, pattern: number | number[]): void {
	const vibrate = activeVibrate(host);
	if (vibrate === null) return;
	try {
		// `false` means the engine declined to buzz; there is nothing to do about
		// that either, so the return value is deliberately ignored.
		vibrate(pattern);
	} catch {
		// Denied permission, or a page the engine will not buzz.
	}
}

/** Every key bar tap, including a modifier: the press landed, whatever it did. */
export function tapFeedback(host: VibrationHost | null = phoneHost()): void {
	buzz(host, TAP_PATTERN);
}

/** Something completed: a message sent, a question answered, a bubble copied. */
export function successFeedback(host: VibrationHost | null = phoneHost()): void {
	buzz(host, SUCCESS_PATTERN);
}
