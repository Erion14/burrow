import { describe, expect, test } from "bun:test";
import type { SessionSummary } from "../../shared/types";
import { filterSessions, groupSessionsByRepo, workspaceOptions } from "./sessions";

function session(repo: string, repoName: string, id: string, updatedAt: string): SessionSummary {
	return {
		id,
		repo,
		repoName,
		title: id,
		status: "idle",
		running: false,
		openAtLaptop: false,
		sessionFile: `/sessions/${id}.jsonl`,
		updatedAt,
	};
}

describe("groupSessionsByRepo", () => {
	test("divides sessions by workspace, keeping the newest workspace first", () => {
		const groups = groupSessionsByRepo([
			session("/home/erioni/code", "code", "a", "2026-10-12T16:00:00.000Z"),
			session("/home/erioni/code/burrow", "burrow", "b", "2026-10-12T15:00:00.000Z"),
			session("/home/erioni/code", "code", "c", "2026-10-12T14:00:00.000Z"),
			session("/home/erioni/rausoft", "rausoft", "d", "2026-10-12T13:00:00.000Z"),
		]);
		expect(groups.map((group) => group.repoName)).toEqual(["code", "burrow", "rausoft"]);
		expect(groups[0]!.sessions.map((entry) => entry.id)).toEqual(["a", "c"]);
		expect(groups[0]!.repo).toBe("/home/erioni/code");
	});

	test("keeps a workspace together even when its sessions are not adjacent", () => {
		const groups = groupSessionsByRepo([
			session("/one", "one", "a", "2026-10-12T16:00:00.000Z"),
			session("/two", "two", "b", "2026-10-12T15:00:00.000Z"),
			session("/one", "one", "c", "2026-10-12T14:00:00.000Z"),
		]);
		expect(groups.map((group) => group.repoName)).toEqual(["one", "two"]);
		expect(groups[0]!.sessions.map((entry) => entry.id)).toEqual(["a", "c"]);
	});

	test("an empty list has no groups", () => {
		expect(groupSessionsByRepo([])).toEqual([]);
	});
});

describe("workspaceOptions", () => {
	test("lists each workspace once, in list order, with its count", () => {
		const options = workspaceOptions([
			session("/home/erioni/code", "code", "a", "2026-10-12T16:00:00.000Z"),
			session("/home/erioni/code/burrow", "burrow", "b", "2026-10-12T15:00:00.000Z"),
			session("/home/erioni/code", "code", "c", "2026-10-12T14:00:00.000Z"),
		]);
		expect(options).toEqual([
			{ repo: "/home/erioni/code", repoName: "code", count: 2 },
			{ repo: "/home/erioni/code/burrow", repoName: "burrow", count: 1 },
		]);
	});
});

describe("filterSessions", () => {
	const sessions = [session("/one", "one", "a", "2026-10-12T16:00:00.000Z"), session("/two", "two", "b", "2026-10-12T15:00:00.000Z")];

	test("null keeps every workspace", () => {
		expect(filterSessions(sessions, null).map((entry) => entry.id)).toEqual(["a", "b"]);
	});

	test("a repo keeps only that workspace", () => {
		expect(filterSessions(sessions, "/two").map((entry) => entry.id)).toEqual(["b"]);
	});

	test("a workspace that is no longer in the list yields nothing", () => {
		expect(filterSessions(sessions, "/gone")).toEqual([]);
	});
});
