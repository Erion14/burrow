// Wire protocol between the phone app and the Burrow server.
// One WebSocket per open phone screen: "/ws" streams the session list,
// "/ws?session=<id>" streams one session (snapshot, then live messages).

import type {
	DialogView,
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
	| { type: "stop_session"; clientId: string };

export type ServerMessage =
	| { type: "snapshot"; snapshot: SessionSnapshot }
	| { type: "sessions"; sessions: SessionSummary[]; repos: RepoOption[] }
	| { type: "item"; item: TranscriptItem }
	| { type: "item_update"; item: TranscriptItem }
	| { type: "delta"; itemId: string; text: string; thinking: string }
	| { type: "status"; status: StatusView }
	| { type: "dialog"; dialog: DialogView | null }
	| { type: "subagents"; subagents: SubagentView[] }
	| { type: "queued"; queued: QueuedMessages }
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
