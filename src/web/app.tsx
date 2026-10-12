import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { ApiErrorBody, BootstrapResponse } from "../shared/protocol";
import type { SessionSummary } from "../shared/types";
import {
	type AppActions,
	type AppState,
	applyServerMessage,
	initialAppState,
	openChat,
	showScreen,
	showSessions,
	withConnection,
	withDraft,
	withRemoteOff,
	withWorkspaceFilter,
} from "./lib/app-state";
import { type Connection, createConnection } from "./lib/conn";
import { ChatScreen, DiffScreen, RemoteOffView, SessionsScreen } from "./screens";

const WAKE_POLL_ATTEMPTS = 30;
const WAKE_POLL_MS = 1000;

function startState(): AppState {
	const state = initialAppState();
	const sessionId = new URLSearchParams(location.search).get("session");
	return sessionId ? openChat(state, sessionId) : state;
}

function socketUrl(state: AppState): string {
	const scheme = location.protocol === "https:" ? "wss" : "ws";
	const query = state.screen !== "sessions" && state.sessionId ? `?session=${encodeURIComponent(state.sessionId)}` : "";
	return `${scheme}://${location.host}/ws${query}`;
}

async function errorText(response: Response): Promise<string> {
	try {
		const body = (await response.json()) as ApiErrorBody;
		return body.error.message;
	} catch {
		return `Request failed (${response.status})`;
	}
}

export function App() {
	const [state, setState] = useState(startState);
	const [bootstrapFailed, setBootstrapFailed] = useState(false);
	const [waking, setWaking] = useState(false);
	// Bumped whenever the screen opens a session, so a resume reconnects even when
	// the socket URL itself does not change.
	const [epoch, setEpoch] = useState(0);
	const stateRef = useRef(state);
	stateRef.current = state;
	const connRef = useRef<Connection | null>(null);
	const actionsRef = useRef<AppActions | null>(null);
	const pendingPrompts = useRef(new Map<string, string>());

	const url = socketUrl(state);
	useEffect(() => {
		const conn = createConnection({
			url,
			onMessage: (message) => setState((current) => applyServerMessage(current, message)),
			onState: (connection) => {
				setState((current) => withConnection(current, connection));
				if (connection === "open") {
					setBootstrapFailed(false);
					if (stateRef.current.screen === "sessions") actionsRef.current?.refreshSessions();
				}
			},
			onAck: (ack) => {
				const text = pendingPrompts.current.get(ack.clientId);
				if (ack.status === "error" && text !== undefined) setState((current) => withDraft(current, text));
				pendingPrompts.current.delete(ack.clientId);
			},
		});
		connRef.current = conn;
		return () => {
			conn.close();
			if (connRef.current === conn) connRef.current = null;
		};
	}, [url, epoch]);

	// "Remote is OFF" means both ways in failed: the list fetch and the socket.
	useEffect(() => {
		if (bootstrapFailed && state.connection === "closed" && !state.remoteOff) setState((current) => withRemoteOff(current, true));
	}, [bootstrapFailed, state.connection, state.remoteOff]);

	const actions = useMemo<AppActions>(() => {
		const fail = (message: string) => setState((current) => ({ ...current, error: message }));

		const loadBootstrap = async (): Promise<boolean> => {
			try {
				const response = await fetch("/api/bootstrap");
				if (!response.ok) {
					setBootstrapFailed(true);
					return false;
				}
				const body = (await response.json()) as BootstrapResponse;
				setBootstrapFailed(false);
				setState((current) => applyServerMessage(current, { type: "sessions", sessions: body.sessions, repos: body.repos }));
				return true;
			} catch {
				setBootstrapFailed(true);
				return false;
			}
		};

		const post = async (path: string, body?: unknown): Promise<Response | null> => {
			try {
				return await fetch(path, {
					method: "POST",
					...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
				});
			} catch {
				return null;
			}
		};

		return {
			sendPrompt(text) {
				const trimmed = text.trim();
				if (trimmed === "") return;
				const clientId = connRef.current?.send({ type: "prompt", text: trimmed });
				if (clientId !== undefined) pendingPrompts.current.set(clientId, trimmed);
				setState((current) => withDraft(current, ""));
			},
			setDraft: (text) => setState((current) => withDraft(current, text)),
			selectWorkspace: (repo) => setState((current) => withWorkspaceFilter(current, repo)),
			abort: () => connRef.current?.send({ type: "abort" }),
			answerDialog: (dialogId, answer) => connRef.current?.send({ type: "answer", dialogId, answer }),
			discardDialog: (dialogId) => connRef.current?.send({ type: "discard_dialog", dialogId }),
			async handOffToLaptop() {
				const sessionId = stateRef.current.sessionId;
				if (sessionId === null) return;
				const response = await post(`/api/sessions/${encodeURIComponent(sessionId)}/stop`);
				if (response === null || !response.ok) {
					fail(response === null ? "Could not reach Burrow" : await errorText(response));
					return;
				}
				setState((current) => showSessions(current));
				void loadBootstrap();
			},
			openSession: (sessionId) => setState((current) => openChat(current, sessionId)),
			async newSession(repoPath, sessionFile) {
				const response = await post("/api/sessions", sessionFile === undefined ? { repoPath } : { repoPath, sessionFile });
				if (response === null || !response.ok) {
					fail(response === null ? "Could not reach Burrow" : await errorText(response));
					return;
				}
				const { session } = (await response.json()) as { session: SessionSummary };
				setState((current) => openChat(applyServerMessage(current, { type: "session", session }), session.id));
				setEpoch((value) => value + 1);
			},
			showSessions() {
				if (location.search !== "") history.replaceState(null, "", "/");
				setState((current) => showSessions(current));
				void loadBootstrap();
			},
			showScreen: (screen) => setState((current) => showScreen(current, screen)),
			async turnRemoteOn() {
				const response = await post("/wake");
				if (response === null || !response.ok) {
					fail("Could not reach the laptop. Is it on the tailnet?");
					return;
				}
				// Burrow needs a few seconds to start after the wake call.
				for (let attempt = 0; attempt < WAKE_POLL_ATTEMPTS; attempt++) {
					if (await loadBootstrap()) return;
					await new Promise((resolve) => setTimeout(resolve, WAKE_POLL_MS));
				}
				fail("Burrow did not come up");
			},
			async turnRemoteOff() {
				const response = await post("/wake/off");
				if (response === null || !response.ok) {
					fail(response === null ? "Could not reach the laptop" : await errorText(response));
					return;
				}
				setBootstrapFailed(true);
				setState((current) => withRemoteOff(current, true));
			},
			refreshSessions: () => void loadBootstrap(),
		};
	}, []);
	actionsRef.current = actions;

	useEffect(() => actions.refreshSessions(), [actions]);

	if (state.remoteOff) {
		const turnOn = async () => {
			setWaking(true);
			try {
				await actions.turnRemoteOn();
			} finally {
				setWaking(false);
			}
		};
		return <RemoteOffView onTurnOn={() => void turnOn()} error={state.error} busy={waking} />;
	}

	const props = { state, actions };
	if (state.screen === "chat") return <ChatScreen {...props} />;
	if (state.screen === "diff") return <DiffScreen {...props} />;
	return <SessionsScreen {...props} />;
}
