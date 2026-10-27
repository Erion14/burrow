// The sessions screen divides the list by workspace: everything Burrow runs
// and everything resumable, grouped by the repo the session started in, so
// `code`, `rausoft` and `burrow` do not run together in one stream.

import type { SessionStatus, SessionSummary } from "../../shared/types";

export interface SessionGroup {
	repo: string;
	repoName: string;
	sessions: SessionSummary[];
}

/**
 * Groups by repo path, in order of first appearance. The server already sends
 * the list newest first with running sessions on top, so that order carries
 * over: the workspace with the most recent activity leads, and sessions inside
 * a group keep their relative order.
 */
export function groupSessionsByRepo(sessions: SessionSummary[]): SessionGroup[] {
	const groups = new Map<string, SessionGroup>();
	for (const session of sessions) {
		const existing = groups.get(session.repo);
		if (existing === undefined) groups.set(session.repo, { repo: session.repo, repoName: session.repoName, sessions: [session] });
		else existing.sessions.push(session);
	}
	return [...groups.values()];
}

export interface WorkspaceOption {
	repo: string;
	repoName: string;
	count: number;
}

/** The workspaces that currently have sessions, in list order, each with its count. */
export function workspaceOptions(sessions: SessionSummary[]): WorkspaceOption[] {
	return groupSessionsByRepo(sessions).map((group) => ({ repo: group.repo, repoName: group.repoName, count: group.sessions.length }));
}

/** null means every workspace. */
export function filterSessions(sessions: SessionSummary[], repo: string | null): SessionSummary[] {
	return repo === null ? sessions : sessions.filter((session) => session.repo === repo);
}

/**
 * Keeps the sessions whose title or repo name contains the query, case insensitively.
 * A blank query is not a search at all, so the same array comes back untouched rather
 * than a copy: the phone shows the list it already had.
 */
export function filterSessionsByQuery(sessions: SessionSummary[], query: string): SessionSummary[] {
	const needle = query.trim().toLowerCase();
	if (needle === "") return sessions;
	return sessions.filter((session) => session.title.toLowerCase().includes(needle) || session.repoName.toLowerCase().includes(needle));
}

const ATTENTION_RANK: Record<SessionStatus, number> = { needs_answer: 0, working: 1, idle: 2, stopped: 3 };

/**
 * Puts the session that wants the phone first: needs_answer, then working, then idle,
 * then stopped. The server's order (newest first) survives inside a status, so the sort
 * is stable and two sessions in the same state never swap places.
 */
export function sortSessionsByAttention(sessions: SessionSummary[]): SessionSummary[] {
	return sessions
		.map((session, index) => ({ session, index }))
		.sort((a, b) => ATTENTION_RANK[a.session.status] - ATTENTION_RANK[b.session.status] || a.index - b.index)
		.map((entry) => entry.session);
}
