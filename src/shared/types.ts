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
	/** Another process (omp started at the host) holds the session file open. */
	openElsewhere: boolean;
	/**
	 * The holder is an omp process, so stopping it lets Burrow resume the session
	 * here. Never true unless openElsewhere is.
	 */
	canTakeOver: boolean;
	sessionFile: string | null;
	/** ISO-8601 UTC. */
	updatedAt: string;
}

export type TranscriptItemKind = "user" | "assistant" | "tool" | "notice" | "bash";

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

/** A `!command` run through omp's `bash` RPC, shown as a terminal card. */
export interface BashCard {
	command: string;
	status: "running" | "done" | "error";
	/** null while it runs, or when omp reported no code (a cancellation or a timeout). */
	exitCode: number | null;
	cancelled?: boolean;
}

export interface TranscriptItem {
	id: string;
	kind: TranscriptItemKind;
	text: string;
	/** Empty string when the message carries no thinking. */
	thinking: string;
	tool?: ToolCard;
	/** Set on `bash` items: the command and how it ended. */
	bash?: BashCard;
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

export interface TodoPhaseView {
	name: string;
	tasks: { content: string; status: string }[];
}

export interface StatusView {
	status: SessionStatus;
	isSettled: boolean;
	hasPendingAsyncWork: boolean;
	/**
	 * From omp's `get_state`. A field stays absent until a read reports it, so the
	 * phone can tell "omp has not told us" from "no value"; a later read that omits
	 * the field keeps the value the previous one reported.
	 */
	model?: { provider: string; id: string; name: string } | null;
	thinkingLevel?: string | null;
	contextUsage?: { tokens: number; contextWindow: number; percent: number } | null;
	todos?: TodoPhaseView[];
	goal?: { objective: string; state: string } | null;
}

/** One omp slash command, as the phone's `/` completion menu shows it. */
export interface CommandView {
	name: string;
	description: string;
	/** Placeholder for the first argument, from omp's `input.hint`. */
	hint: string;
	subcommands: { name: string; description: string }[];
}

/** One selectable model, from `get_available_models`. */
export interface ModelView {
	provider: string;
	id: string;
	name: string;
	contextWindow: number | null;
	reasoning: boolean;
}

export interface SessionSnapshot {
	session: SessionSummary;
	items: TranscriptItem[];
	dialog: DialogView | null;
	subagents: SubagentView[];
	queued: QueuedMessages;
	status: StatusView;
	/** omp's slash commands; empty until the update frame or the setup request answered. */
	commands: CommandView[];
	/** Older transcript items were dropped from the snapshot. */
	truncated: boolean;
	/**
	 * Built from the session file another process writes at the host, rather than
	 * from a process Burrow owns: nothing to prompt, nothing to answer, and the
	 * phone shows no composer.
	 */
	readOnly: boolean;
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
	/**
	 * One line per remark: what was shown instead when `repo` is not itself a git
	 * repository, and what the size, count and time limits left out.
	 */
	notice?: string;
}
