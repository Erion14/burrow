import { describe, expect, test } from "bun:test";
import type { DialogView, SessionSnapshot, SessionSummary, TranscriptItem } from "../../shared/types";
import { MAX_TRANSCRIPT_ITEMS, applyServerMessage, initialAppState } from "./app-state";

const session: SessionSummary = {
	id: "s1",
	repo: "/r",
	repoName: "r",
	title: "t",
	status: "idle",
	running: true,
	openAtLaptop: false,
	sessionFile: null,
	updatedAt: "2026-10-12T00:00:00Z",
};

function item(id: string, text = ""): TranscriptItem {
	return { id, kind: "assistant", text, thinking: "", createdAt: "2026-10-12T00:00:00Z" };
}

const dialog: DialogView = { id: "d1", kind: "confirm", title: "Run?", message: "ok?" };

function snapshot(items: TranscriptItem[], dlg: DialogView | null = null): SessionSnapshot {
	return {
		session,
		items,
		dialog: dlg,
		subagents: [],
		queued: { steering: [], followUp: [] },
		status: { status: "idle", isSettled: true, hasPendingAsyncWork: false },
		truncated: false,
	};
}

describe("applyServerMessage", () => {
	test("snapshot replaces the transcript and clears a stale dialog", () => {
		let state = initialAppState();
		state = applyServerMessage(state, { type: "snapshot", snapshot: snapshot([item("old")], dialog) });
		expect(state.dialog?.id).toBe("d1");

		state = applyServerMessage(state, { type: "snapshot", snapshot: snapshot([item("a"), item("b")]) });
		expect(state.items.map((i) => i.id)).toEqual(["a", "b"]);
		expect(state.dialog).toBeNull();
		expect(state.status.status).toBe("idle");
	});

	test("delta appends to the matching item only", () => {
		let state = initialAppState();
		state = applyServerMessage(state, { type: "snapshot", snapshot: snapshot([item("a", "x"), item("b", "y")]) });
		state = applyServerMessage(state, { type: "delta", itemId: "b", text: "z", thinking: "t" });

		expect(state.items[0]!.text).toBe("x");
		expect(state.items[1]!.text).toBe("yz");
		expect(state.items[1]!.thinking).toBe("t");
	});

	test("delta for an unknown item changes nothing", () => {
		const state = applyServerMessage(initialAppState(), { type: "delta", itemId: "nope", text: "z", thinking: "" });
		expect(state.items).toEqual([]);
	});

	test("an open dialog shows needs_answer in the status dot, and closing it restores the stream status", () => {
		let state = initialAppState();
		state = applyServerMessage(state, { type: "dialog", dialog });
		expect(state.status.status).toBe("needs_answer");

		state = applyServerMessage(state, {
			type: "status",
			status: { status: "working", isSettled: false, hasPendingAsyncWork: false },
		});
		expect(state.status.status).toBe("needs_answer");

		state = applyServerMessage(state, { type: "dialog", dialog: null });
		state = applyServerMessage(state, {
			type: "status",
			status: { status: "working", isSettled: false, hasPendingAsyncWork: false },
		});
		expect(state.status.status).toBe("working");
	});

	test("sessions message fills the list and repos", () => {
		const state = applyServerMessage(initialAppState(), {
			type: "sessions",
			sessions: [session],
			repos: [{ path: "/r", name: "r" }],
		});
		expect(state.sessions).toEqual([session]);
		expect(state.repos).toEqual([{ path: "/r", name: "r" }]);
	});

	test("ack with status error surfaces the error; ok and duplicate do not", () => {
		let state = initialAppState();
		state = applyServerMessage(state, { type: "ack", clientId: "c", status: "ok" });
		state = applyServerMessage(state, { type: "ack", clientId: "c", status: "duplicate" });
		expect(state.error).toBeNull();

		state = applyServerMessage(state, { type: "ack", clientId: "c", status: "error", error: "session busy" });
		expect(state.error).toBe("session busy");
	});

	test("the transcript is capped at MAX_TRANSCRIPT_ITEMS, dropping the oldest", () => {
		let state = initialAppState();
		const items = Array.from({ length: MAX_TRANSCRIPT_ITEMS }, (_, i) => item(`i${i}`));
		state = applyServerMessage(state, { type: "snapshot", snapshot: snapshot(items) });
		state = applyServerMessage(state, { type: "item", item: item("new") });

		expect(state.items).toHaveLength(MAX_TRANSCRIPT_ITEMS);
		expect(state.items[0]!.id).toBe("i1");
		expect(state.items.at(-1)!.id).toBe("new");
	});
});
