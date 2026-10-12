// Derives the working/idle status the phone shows from get_state data and the
// event stream. needs_answer and stopped belong to the session manager.

import type { ServerMessage } from "../../shared/protocol";
import type { StatusView } from "../../shared/types";
import type { OmpEvent } from "../omp/port";

export interface StatusTracker {
	handle(event: OmpEvent): ServerMessage[];
	setState(data: unknown): void;
	snapshot(): StatusView;
}

export function createStatusTracker(): StatusTracker {
	let streaming = false;
	let settled = true;
	let pending = false;
	let last: StatusView | null = null;

	function view(): StatusView {
		const working = streaming || pending || !settled;
		return { status: working ? "working" : "idle", isSettled: settled, hasPendingAsyncWork: pending };
	}

	function emit(): ServerMessage[] {
		const next = view();
		if (last && last.status === next.status && last.isSettled === next.isSettled && last.hasPendingAsyncWork === next.hasPendingAsyncWork) {
			return [];
		}
		last = next;
		return [{ type: "status", status: next }];
	}

	return {
		handle(event) {
			switch (event.type) {
				case "agent_start":
					streaming = true;
					settled = false;
					return emit();
				case "agent_end":
					if (event.yielded === false) {
						// The run continues (for example a queued follow-up); stay working.
						streaming = true;
						settled = false;
					} else {
						streaming = false;
						pending = event.awaitingAsyncWork === true;
						settled = !pending;
					}
					return emit();
				case "session_settled":
					streaming = false;
					pending = false;
					settled = true;
					return emit();
				default:
					return [];
			}
		},
		setState(data) {
			if (typeof data !== "object" || data === null) return;
			const state = data as Record<string, unknown>;
			if (typeof state.isStreaming === "boolean") streaming = state.isStreaming;
			if (typeof state.isSettled === "boolean") settled = state.isSettled;
			if (typeof state.hasPendingAsyncWork === "boolean") pending = state.hasPendingAsyncWork;
		},
		snapshot() {
			return view();
		},
	};
}
