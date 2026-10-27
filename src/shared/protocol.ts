// Wire protocol between the phone app and the Burrow server.
// One WebSocket per open phone screen: "/ws" streams the session list,
// "/ws?session=<id>" streams one session (snapshot, then live messages).

import type {
	CommandView,
	DialogView,
	ModelView,
	QueuedMessages,
	RepoOption,
	SessionSnapshot,
	SessionSummary,
	StatusView,
	SubagentView,
	TranscriptItem,
} from "./types";

export interface DialogAnswerSelect {
	kind: "select";
	value: string;
}

export interface DialogAnswerConfirm {
	kind: "confirm";
	confirmed: boolean;
}

export interface DialogAnswerText {
	kind: "input" | "editor";
	value: string;
}

export interface AskAnswerItem {
	id: string;
	selectedOptions: string[];
	customInput?: string;
}

export interface DialogAnswerAsk {
	kind: "ask";
	answers: AskAnswerItem[];
}

export type DialogAnswer = DialogAnswerSelect | DialogAnswerConfirm | DialogAnswerText | DialogAnswerAsk;

/**
 * Phone to server. Every message carries a client id; the server applies a
 * given id once and answers `duplicate` on a resend, so a message sent during
 * a dropout reaches the agent exactly once.
 */
export type ClientMessage =
	| { type: "prompt"; clientId: string; text: string }
	| { type: "abort"; clientId: string }
	| { type: "answer"; clientId: string; dialogId: string; answer: DialogAnswer }
	| { type: "discard_dialog"; clientId: string; dialogId: string }
	| { type: "stop_session"; clientId: string }
	| { type: "list_models"; clientId: string }
	| { type: "refresh_state"; clientId: string }
	| { type: "set_model"; clientId: string; provider: string; modelId: string }
	| { type: "cycle_model"; clientId: string }
	| { type: "set_thinking"; clientId: string; level: string }
	| { type: "cycle_thinking"; clientId: string }
	| { type: "compact"; clientId: string }
	| { type: "remove_queued"; clientId: string; text: string; queue: "steering" | "followUp" }
	| { type: "promote_queued"; clientId: string; text: string }
	| { type: "restore_queue"; clientId: string }
	| { type: "cancel_subagent"; clientId: string; subagentId: string }
	| { type: "steer_subagent"; clientId: string; subagentId: string; message: string }
	| { type: "rename_session"; clientId: string; name: string }
	| { type: "goal_action"; clientId: string; op: "resume" | "pause" | "drop" }
	| { type: "bash"; clientId: string; command: string };

export type ServerMessage =
	| { type: "snapshot"; snapshot: SessionSnapshot }
	| { type: "sessions"; sessions: SessionSummary[]; repos: RepoOption[] }
	| { type: "item"; item: TranscriptItem }
	| { type: "item_update"; item: TranscriptItem }
	| { type: "delta"; itemId: string; text: string; thinking: string }
	| { type: "status"; status: StatusView }
	| { type: "commands"; commands: CommandView[] }
	/** Answer to `list_models`; a failed read reports itself here instead of as an ack error. */
	| { type: "models"; models: ModelView[]; thinkingLevels: string[]; error?: string }
	| { type: "dialog"; dialog: DialogView | null }
	| { type: "subagents"; subagents: SubagentView[] }
	| { type: "queued"; queued: QueuedMessages }
	/** Answer to `restore_queue`: the withdrawn texts, for the composer. The queue is empty now. */
	| { type: "queue_restored"; steering: string[]; followUp: string[] }
	| { type: "session"; session: SessionSummary }
	| { type: "ack"; clientId: string; status: "ok" | "duplicate" | "error"; error?: string }
	| { type: "error"; code: string; message: string };

export interface BootstrapResponse {
	repos: RepoOption[];
	sessions: SessionSummary[];
}

export interface ApiErrorBody {
	error: {
		code: string;
		message: string;
	};
}
