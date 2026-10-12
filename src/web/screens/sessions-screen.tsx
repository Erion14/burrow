import type { ComponentChildren } from "preact";
import { useState } from "preact/hooks";
import type { SessionSummary } from "../../shared/types";
import { relativeTime } from "../lib/format";
import { filterSessions, groupSessionsByRepo, workspaceOptions } from "../lib/sessions";
import { BurrowMark, LaptopIcon, PowerIcon, RefreshIcon } from "./icons";
import type { ScreenProps } from "./props";
import { RemoteOffView } from "./remote-off";
import { ConnMark, STATUS_LABELS, Sep, StatusGlyph } from "./status-glyph";

function RowBody({ session, children }: { session: SessionSummary; children: ComponentChildren }) {
	return (
		<>
			<span class="row-glyph"><StatusGlyph status={session.status} /></span>
			<span class="row-main">
				<span class="row-line">
					<span class="row-title ellipsis">{session.title || "(untitled)"}</span>
					<span class="row-time">{relativeTime(session.updatedAt)}</span>
				</span>
				<span class="row-line">
					<span class="chip chip-repo ellipsis">{session.repoName}</span>
					{children}
				</span>
			</span>
		</>
	);
}

function SessionRow({ session, onTap }: { session: SessionSummary; onTap: () => void }) {
	// Not a button at all when blocked: nothing to press, so nothing to mistake for one.
	if (session.openAtLaptop) {
		return (
			<li>
				<div class="row row-blocked">
					<RowBody session={session}>
						<span class="laptop-note"><LaptopIcon />open at laptop</span>
					</RowBody>
				</div>
			</li>
		);
	}
	return (
		<li>
			<button type="button" class="row" onClick={onTap}>
				<RowBody session={session}>
					{session.running ? (
						<span class={`row-state state-${session.status}`}>{STATUS_LABELS[session.status]}</span>
					) : (
						<>
							<span class="row-state state-stopped">stopped</span>
							<span class="resume">▶ resume</span>
						</>
					)}
				</RowBody>
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
		if (busy) return;
		if (session.running) {
			actions.openSession(session.id);
			return;
		}
		// A resume spawns an omp process; a second tap would be a second POST.
		setBusy(true);
		void actions.newSession(session.repo, session.sessionFile ?? undefined).finally(() => setBusy(false));
	};

	if (state.remoteOff) return <RemoteOffView onTurnOn={() => void turnOn()} error={state.error} busy={turningOn} />;

	const open = state.connection === "open";
	const loading = state.connection === "connecting" && state.sessions.length === 0;
	const visible = filterSessions(state.sessions, state.workspaceFilter);
	const options = workspaceOptions(state.sessions);
	const groups = groupSessionsByRepo(visible);
	const needs = visible.filter((session) => session.status === "needs_answer").length;
	const working = visible.filter((session) => session.status === "working").length;

	return (
		<main class="screen">
			<header class="bar">
				<div class="bar-row">
					<BurrowMark class="bar-mark" />
					<h1 class="bar-title">burrow</h1>
					<button type="button" class="btn btn-bar btn-icon" aria-label="Refresh" title="Refresh" onClick={() => actions.refreshSessions()}>
						<RefreshIcon />
					</button>
					<button type="button" class="btn btn-danger" onClick={() => void actions.turnRemoteOff()}>
						<PowerIcon />
						Remote OFF
					</button>
				</div>
				<div class="statusline">
					<span class="seg-count">{visible.length} {visible.length === 1 ? "session" : "sessions"}</span>
					{needs > 0 ? <><Sep /><span class="state state-needs_answer"><span class="glyph glyph-needs_answer" aria-hidden="true" />{needs} need answer</span></> : null}
					{working > 0 ? <><Sep /><span class="state state-working"><span class="glyph glyph-working" aria-hidden="true" />{working} working</span></> : null}
					<ConnMark connection={state.connection} />
				</div>
			</header>
			{state.error ? <p class="error" role="alert">{state.error}</p> : null}
			{!open && state.sessions.length > 0 ? <p class="banner">disconnected · showing the last known list</p> : null}
			{picking ? (
				<section class="panel picker">
					<p class="panel-title">pick a repo</p>
					{state.repos.length === 0 ? <p class="panel-detail">No repos on the allowlist.</p> : null}
					<div class="choices">
						{state.repos.map((option, index) => (
							<button key={option.path} type="button" class="btn btn-choice" disabled={busy} onClick={() => void start(option.path)}>
								<span class="choice-key" aria-hidden="true">{index + 1}</span>
								<span class="choice-body">
									<span class="choice-label">{option.name}</span>
									<small>{option.path}</small>
								</span>
							</button>
						))}
					</div>
					<button type="button" class="btn btn-quiet" onClick={() => setPicking(false)}>✕ Cancel</button>
				</section>
			) : (
				<div class="new-strip">
					<button type="button" class="btn btn-new big-btn" disabled={!open} onClick={() => setPicking(true)}>+ new agent</button>
				</div>
			)}
			{options.length > 1 ? (
				// Selecting a workspace narrows the list below to it; the selection is kept
				// in app state, so it survives a trip into a chat and back.
				<nav class="workspaces" aria-label="Workspace">
					<button
						type="button"
						class={`ws-chip ${state.workspaceFilter === null ? "is-on" : ""}`}
						aria-pressed={state.workspaceFilter === null}
						onClick={() => actions.selectWorkspace(null)}
					>
						all<span class="ws-count">{state.sessions.length}</span>
					</button>
					{options.map((option) => (
						<button
							key={option.repo}
							type="button"
							class={`ws-chip ${state.workspaceFilter === option.repo ? "is-on" : ""}`}
							aria-pressed={state.workspaceFilter === option.repo}
							title={option.repo}
							onClick={() => actions.selectWorkspace(option.repo)}
						>
							{option.repoName}
							<span class="ws-count">{option.count}</span>
						</button>
					))}
				</nav>
			) : null}
			{loading ? <p class="placeholder"><span class="spin" aria-hidden="true" /> loading sessions…</p> : null}
			{groups.length > 0 ? (
				<div class="groups">
					{groups.map((group) => (
						<section class="group" key={group.repo}>
							<header class="group-head">
								<span class="group-name">{group.repoName}</span>
								<span class="group-path">{group.repo}</span>
								<span class="group-count">{group.sessions.length}</span>
							</header>
							<ul class="list">
								{group.sessions.map((session) => (
									<SessionRow key={session.id} session={session} onTap={() => tap(session)} />
								))}
							</ul>
						</section>
					))}
				</div>
			) : null}
			{!loading && state.sessions.length > 0 && visible.length === 0 ? (
				<section class="panel empty">
					<p class="panel-title">workspace</p>
					<p class="panel-state state-stopped">○ no sessions here right now</p>
					<button type="button" class="btn btn-quiet" onClick={() => actions.selectWorkspace(null)}>show all workspaces</button>
				</section>
			) : null}
			{!loading && state.sessions.length === 0 ? (
				<section class="panel empty">
					<p class="panel-title">sessions</p>
					<p class="panel-state state-stopped">○ no sessions yet</p>
					<p class="panel-detail">Tap <kbd>+ new agent</kbd> to start omp in one of your repos.</p>
					<p class="panel-detail">Sessions you start at the laptop show up here too.</p>
				</section>
			) : null}
		</main>
	);
}
