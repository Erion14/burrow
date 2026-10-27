// The composer's drafts, one per session, in `localStorage`: leaving the chat
// screen or reloading the phone must not lose a half typed prompt. The storage
// is injected and may be absent, because a phone browser can refuse
// `localStorage` outright, and the composer has to keep typing when it does.

/**
 * The slice of `Storage` this module needs. `removeItem` is optional so a stub
 * (or a guarded polyfill) without it can still clear an entry with a blank.
 */
export interface DraftStorage {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
	removeItem?(key: string): void;
}

const PREFIX = "burrow.draft:";

export function readDraft(storage: DraftStorage | null, sessionId: string): string {
	if (storage === null) return "";
	try {
		return storage.getItem(`${PREFIX}${sessionId}`) ?? "";
	} catch {
		// A refused read is a draft that is not there, not a broken composer.
		return "";
	}
}

export function writeDraft(storage: DraftStorage | null, sessionId: string, text: string): void {
	if (storage === null) return;
	const key = `${PREFIX}${sessionId}`;
	try {
		// A blank draft clears the entry, so the map does not fill with one key per
		// session that was merely opened.
		if (text.trim() === "") {
			if (storage.removeItem === undefined) storage.setItem(key, "");
			else storage.removeItem(key);
			return;
		}
		storage.setItem(key, text);
	} catch {
		// Private mode and a full quota refuse the write; losing the draft must not
		// cost the keystroke.
	}
}
