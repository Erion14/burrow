// The composer's drafts, one per session, in `localStorage`: leaving the chat
// screen or reloading the phone must not lose a half typed prompt. Storage is
// injected and may be absent (a browser can refuse localStorage entirely), so
// every call here has to survive a storage that throws.

import { describe, expect, test } from "bun:test";
import { type DraftStorage, readDraft, writeDraft } from "./drafts";

interface Fake extends DraftStorage {
	entries(): string[];
}

function fakeStorage(): Fake {
	const store = new Map<string, string>();
	return {
		getItem: (key) => store.get(key) ?? null,
		setItem: (key, value) => void store.set(key, value),
		removeItem: (key) => void store.delete(key),
		entries: () => [...store.keys()],
	};
}

describe("drafts", () => {
	test("a draft survives a round trip for its session", () => {
		const storage = fakeStorage();
		writeDraft(storage, "session-a", "half typed prompt");
		expect(readDraft(storage, "session-a")).toBe("half typed prompt");
	});

	test("sessions do not read each other's draft", () => {
		const storage = fakeStorage();
		writeDraft(storage, "session-a", "for a");
		writeDraft(storage, "session-b", "for b");
		expect(readDraft(storage, "session-a")).toBe("for a");
		expect(readDraft(storage, "session-b")).toBe("for b");
		expect(readDraft(storage, "session-c")).toBe("");
	});

	test("a blank draft clears the entry instead of storing it", () => {
		const storage = fakeStorage();
		writeDraft(storage, "session-a", "typed");
		writeDraft(storage, "session-a", "");
		expect(storage.entries()).toEqual([]);
		expect(readDraft(storage, "session-a")).toBe("");
	});

	test("a draft of spaces is blank too", () => {
		const storage = fakeStorage();
		writeDraft(storage, "session-a", " \n ");
		expect(storage.entries()).toEqual([]);
	});

	test("a storage without removeItem is emptied with a blank value", () => {
		const store = new Map<string, string>();
		const storage: DraftStorage = {
			getItem: (key) => store.get(key) ?? null,
			setItem: (key, value) => void store.set(key, value),
		};
		writeDraft(storage, "session-a", "typed");
		writeDraft(storage, "session-a", "");
		expect(readDraft(storage, "session-a")).toBe("");
	});

	test("a storage that throws never reaches the composer", () => {
		const hostile: DraftStorage = {
			getItem: () => {
				throw new Error("private mode");
			},
			setItem: () => {
				throw new Error("quota");
			},
			removeItem: () => {
				throw new Error("quota");
			},
		};
		expect(readDraft(hostile, "session-a")).toBe("");
		expect(() => writeDraft(hostile, "session-a", "typed")).not.toThrow();
		expect(() => writeDraft(hostile, "session-a", "")).not.toThrow();
	});

	test("a missing storage is a no-op, not a crash", () => {
		expect(readDraft(null, "session-a")).toBe("");
		expect(() => writeDraft(null, "session-a", "typed")).not.toThrow();
	});
});
