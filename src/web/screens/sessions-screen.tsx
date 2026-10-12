import { useState } from "preact/hooks";
import type { SessionSummary } from "../../shared/types";
import { relativeTime } from "../lib/format";
import type { ScreenProps } from "./props";
import { StatusDot } from "./status-dot";

function SessionRow({ session, onTap }: { session: SessionSummary; onTap: () => void }) {
	const blocked = session.openAtLaptop;
	return (
		<li>
			<button type="button" class="row" disabled={blocked} onClick={onTap}>
				<StatusDot status={session.status} />
				<span class="row-main">
					<span class="row-title">{session.title || "(untitled)"}</span>
					<span class="row-sub">{session.repoName} · {relativeTime(session.updatedAt)}</span>
				</span>
				{blocked ? <span class="badge">open at laptop</span> : null}
				{!blocked && !session.running ? <span class="badge badge-muted">resume</span> : null}
			</button>
		</li>
	);
}

export function SessionsScreen({ state, actions }: ScreenProps) {
	const [picking, setPicking] = useState(false);
	const [busy, setBusy] = useState(false);
	const [turningOn, setTurningOn] = useState(false);

	const start = async (repoPath: string) => {
		if (busy) return;
		setBusy(true);
		try {
			await actions.newSession(repoPath);
			setPicking(false);
		} finally {
			setBusy(false);
		}
	};

	const turnOn = async () => {
		setTurningOn(true);
		try {
			await actions.turnRemoteOn();
		} finally {
			setTurningOn(false);
		}
	};

	const tap = (session: SessionSummary) => {
		if (session.running) actions.openSession(session.id);
		else void actions.newSession(session.repo, session.sessionFile ?? undefined);
	};

	if (state.remoteOff) {
		return (
			<main class="screen center-screen">
				<h1>Remote is OFF</h1>
				<p class="muted">Burrow is not running on the laptop.</p>
				{state.error ? <p class="error" role="alert">{state.error}</p> : null}
				<button type="button" class="btn btn-primary big-btn" disabled={turningOn} onClick={() => void turnOn()}>
					{turningOn ? "Turning ON..." : "Turn ON"}
				</button>
			</main>
		);
	}

	const open = state.connection === "open";
	const loading = state.connection === "connecting" && state.sessions.length === 0;

	return (
		<main class="screen">
			<header class="bar">
				<h1>Burrow</h1>
				<span class={`conn conn-${state.connection}`}>{open ? "connected" : state.connection === "connecting" ? "connecting" : "disconnected"}</span>
				<span class="spacer" />
				<button type="button" class="btn" onClick={() => actions.refreshSessions()}>Refresh</button>
				<button type="button" class="btn btn-danger" onClick={() => void actions.turnRemoteOff()}>Remote OFF</button>
			</header>
			{state.error ? <p class="error" role="alert">{state.error}</p> : null}
			{!open && state.sessions.length > 0 ? <p class="banner">Disconnected. Showing the last known list.</p> : null}
			{picking ? (
				<section class="card">
					<h2>Pick a repo</h2>
					{state.repos.length === 0 ? <p class="muted">No repos on the allowlist.</p> : null}
					<div class="choices">
						{state.repos.map((option) => (
							<button key={option.path} type="button" class="btn btn-choice" disabled={busy} onClick={() => void start(option.path)}>
								<span>{option.name}</span>
								<small>{option.path}</small>
							</button>
						))}
					</div>
					<button type="button" class="btn btn-quiet" onClick={() => setPicking(false)}>Cancel</button>
				</section>
			) : (
				<div class="card">
					<button type="button" class="btn btn-primary big-btn" disabled={!open} onClick={() => setPicking(true)}>+ New agent</button>
				</div>
			)}
			{loading ? <p class="muted center">Loading sessions...</p> : null}
			<ul class="list">
				{state.sessions.map((session) => (
					<SessionRow key={session.id} session={session} onTap={() => tap(session)} />
				))}
			</ul>
			{!loading && state.sessions.length === 0 ? <p class="muted center">No sessions yet.</p> : null}
		</main>
	);
}
