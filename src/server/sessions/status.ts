// Derives the working/idle status the phone shows from get_state data and the
// event stream. needs_answer and stopped belong to the session manager.

import type { ServerMessage } from "../../shared/protocol";
import type { StatusView, TodoPhaseView } from "../../shared/types";
import type { OmpEvent } from "../omp/port";

export interface StatusTracker {
	handle(event: OmpEvent): ServerMessage[];
	setState(data: unknown): void;
	snapshot(): StatusView;
}

/** The StatusView fields only `get_state` reports; absent until a read names them. */
type ReadFields = Pick<StatusView, "model" | "thinkingLevel" | "contextUsage" | "todos" | "goal">;

function readModel(raw: unknown): StatusView["model"] {
	if (typeof raw !== "object" || raw === null) return null;
	const rec = raw as Record<string, unknown>;
	if (typeof rec.provider !== "string" || typeof rec.id !== "string") return null;
	return { provider: rec.provider, id: rec.id, name: typeof rec.name === "string" ? rec.name : rec.id };
}

function readUsage(raw: unknown): StatusView["contextUsage"] {
	if (typeof raw !== "object" || raw === null) return null;
	const rec = raw as Record<string, unknown>;
	if (typeof rec.tokens !== "number" || typeof rec.contextWindow !== "number") return null;
	return { tokens: rec.tokens, contextWindow: rec.contextWindow, percent: typeof rec.percent === "number" ? rec.percent : 0 };
}

function readTodos(raw: unknown): TodoPhaseView[] {
	if (!Array.isArray(raw)) return [];
	const phases: TodoPhaseView[] = [];
	for (const entry of raw) {
		if (typeof entry !== "object" || entry === null) continue;
		const phase = entry as Record<string, unknown>;
		const tasks: TodoPhaseView["tasks"] = [];
		if (Array.isArray(phase.tasks)) {
			for (const rawTask of phase.tasks) {
				if (typeof rawTask !== "object" || rawTask === null) continue;
				const task = rawTask as Record<string, unknown>;
				if (typeof task.content !== "string") continue;
				tasks.push({ content: task.content, status: typeof task.status === "string" ? task.status : "" });
			}
		}
		phases.push({ name: typeof phase.name === "string" ? phase.name : "", tasks });
	}
	return phases;
}

function readGoal(raw: unknown): StatusView["goal"] {
	if (typeof raw !== "object" || raw === null) return null;
	const rec = raw as Record<string, unknown>;
	if (typeof rec.objective !== "string") return null;
	return { objective: rec.objective, state: typeof rec.state === "string" ? rec.state : "" };
}

export function createStatusTracker(): StatusTracker {
	let streaming = false;
	let settled = true;
	let pending = false;
	const read: ReadFields = {};
	let last: StatusView | null = null;

	function view(): StatusView {
		const working = streaming || pending || !settled;
		return { status: working ? "working" : "idle", isSettled: settled, hasPendingAsyncWork: pending, ...read };
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
			// A field the frame omits is not reported as missing: the last read's value stands.
			if (state.model !== undefined) read.model = readModel(state.model);
			if (state.thinkingLevel !== undefined) {
				read.thinkingLevel = typeof state.thinkingLevel === "string" ? state.thinkingLevel : null;
			}
			if (state.contextUsage !== undefined) read.contextUsage = readUsage(state.contextUsage);
			if (state.todoPhases !== undefined) read.todos = readTodos(state.todoPhases);
			if (state.goal !== undefined) read.goal = readGoal(state.goal);
		},
		snapshot() {
			return view();
		},
	};
}
