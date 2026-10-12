// View types shared by the Burrow server and the phone web app.
// These mirror the phone's screens; they are deliberately smaller than the omp protocol.

export type SessionStatus = "working" | "needs_answer" | "idle" | "stopped";

export interface SessionSummary {
	id: string;
	/** Absolute repo path (already resolved through symlinks). */
	repo: string;
	repoName: string;
	title: string;
	status: SessionStatus;
	/** Burrow owns a live omp process for this session. */
	running: boolean;
	/** Another process (omp started at the laptop) holds the session file open. */
	openAtLaptop: boolean;
	sessionFile: string | null;
	/** ISO-8601 UTC. */
	updatedAt: string;
}

export type TranscriptItemKind = "user" | "assistant" | "tool" | "notice";

export interface ToolCard {
	id: string;
	name: string;
	/** One line summary of the call arguments. */
	args: string;
	/** Bounded tail of the tool output. */
	output: string;
	status: "running" | "done" | "error";
	durationMs?: number;
}

export interface TranscriptItem {
	id: string;
	kind: TranscriptItemKind;
	text: string;
	/** Empty string when the message carries no thinking. */
	thinking: string;
	tool?: ToolCard;
	createdAt: string;
}

export interface DialogQuestionOption {
	label: string;
	description?: string;
	preview?: string;
}

export interface DialogQuestion {
	id: string;
	question: string;
	header?: string;
	options: DialogQuestionOption[];
	multi: boolean;
	recommended?: number;
}

export type DialogView =
	| { id: string; kind: "select"; title: string; message: string; options: string[]; optionDetails: string[]; timeoutMs?: number }
	| { id: string; kind: "confirm"; title: string; message: string; timeoutMs?: number }
	| { id: string; kind: "input"; title: string; message: string; placeholder: string; timeoutMs?: number }
	| { id: string; kind: "editor"; title: string; message: string; text: string; timeoutMs?: number }
	| { id: string; kind: "ask"; questions: DialogQuestion[]; timeoutMs?: number };

export interface SubagentView {
	id: string;
	label: string;
	status: string;
	detail: string;
}

export interface QueuedMessages {
	steering: string[];
	followUp: string[];
}

export interface StatusView {
	status: SessionStatus;
	isSettled: boolean;
	hasPendingAsyncWork: boolean;
}

export interface SessionSnapshot {
	session: SessionSummary;
	items: TranscriptItem[];
	dialog: DialogView | null;
	subagents: SubagentView[];
	queued: QueuedMessages;
	status: StatusView;
	/** Older transcript items were dropped from the snapshot. */
	truncated: boolean;
}

export interface RepoOption {
	path: string;
	name: string;
}

export interface DiffFile {
	path: string;
	status: "modified" | "added" | "deleted" | "renamed" | "conflict" | "untracked";
	/** Unified diff for one file, without the "diff --git" header block. */
	unified: string;
	additions: number;
	deletions: number;
	binary: boolean;
}

export interface DiffResponse {
	repo: string;
	files: DiffFile[];
	truncated: boolean;
}
