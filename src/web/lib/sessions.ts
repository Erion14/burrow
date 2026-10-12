// The sessions screen divides the list by workspace: everything Burrow runs
// and everything resumable, grouped by the repo the session started in, so
// `code`, `rausoft` and `burrow` do not run together in one stream.

import type { SessionSummary } from "../../shared/types";

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
