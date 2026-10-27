import { describe, expect, test } from "bun:test";
import { h, render } from "preact";
import { act } from "preact/test-utils";
import type { SessionSummary } from "../../shared/types";
import { SessionsScreen } from "../screens/sessions-screen";
import { byClass, mount as mountView, stubActions, type Elm } from "../../../test/web-dom";
import type { AppActions, AppState } from "./app-state";
import { initialAppState } from "./app-state";
import { filterSessions, filterSessionsByQuery, groupSessionsByRepo, sortSessionsByAttention, workspaceOptions } from "./sessions";

/** The list screen, mounted through the shared element shim. */
function mount(state: AppState, actions: AppActions): Elm {
	return mountView(SessionsScreen, { state, actions });
}

function session(repo: string, repoName: string, id: string, updatedAt: string, over: Partial<SessionSummary> = {}): SessionSummary {
	return {
		id,
		repo,
		repoName,
		title: id,
		status: "idle",
		running: false,
		openElsewhere: false,
		canTakeOver: false,
		sessionFile: `/sessions/${id}.jsonl`,
		updatedAt,
		...over,
	};
}

describe("groupSessionsByRepo", () => {
	test("divides sessions by workspace, keeping the newest workspace first", () => {
		const groups = groupSessionsByRepo([
			session("/home/user/code", "code", "a", "2026-10-12T16:00:00.000Z"),
			session("/home/user/code/burrow", "burrow", "b", "2026-10-12T15:00:00.000Z"),
			session("/home/user/code", "code", "c", "2026-10-12T14:00:00.000Z"),
			session("/home/user/rausoft", "rausoft", "d", "2026-10-12T13:00:00.000Z"),
		]);
		expect(groups.map((group) => group.repoName)).toEqual(["code", "burrow", "rausoft"]);
		expect(groups[0]!.sessions.map((entry) => entry.id)).toEqual(["a", "c"]);
		expect(groups[0]!.repo).toBe("/home/user/code");
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
			session("/home/user/code", "code", "a", "2026-10-12T16:00:00.000Z"),
			session("/home/user/code/burrow", "burrow", "b", "2026-10-12T15:00:00.000Z"),
			session("/home/user/code", "code", "c", "2026-10-12T14:00:00.000Z"),
		]);
		expect(options).toEqual([
			{ repo: "/home/user/code", repoName: "code", count: 2 },
			{ repo: "/home/user/code/burrow", repoName: "burrow", count: 1 },
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

describe("filterSessionsByQuery", () => {
	const sessions = [
		session("/home/user/code", "code", "alpha", "2026-10-12T16:00:00.000Z", { title: "Fix the parser" }),
		session("/home/user/rausoft", "rausoft", "beta", "2026-10-12T15:00:00.000Z", { title: "Deploy script" }),
	];

	test("an empty query returns the list unchanged", () => {
		expect(filterSessionsByQuery(sessions, "")).toBe(sessions);
	});

	test("a whitespace query is no filter either", () => {
		expect(filterSessionsByQuery(sessions, "   ")).toBe(sessions);
	});

	test("matches the title, case insensitively", () => {
		expect(filterSessionsByQuery(sessions, "PARSER").map((entry) => entry.id)).toEqual(["alpha"]);
	});

	test("matches the repo name, case insensitively", () => {
		expect(filterSessionsByQuery(sessions, "RAUSoft").map((entry) => entry.id)).toEqual(["beta"]);
	});

	test("nothing matching is an empty list", () => {
		expect(filterSessionsByQuery(sessions, "zzz")).toEqual([]);
	});
});

describe("sortSessionsByAttention", () => {
	test("needs_answer, then working, then idle, then stopped", () => {
		const sorted = sortSessionsByAttention([
			session("/one", "one", "stopped", "2026-10-12T13:00:00.000Z", { status: "stopped" }),
			session("/one", "one", "idle", "2026-10-12T14:00:00.000Z", { status: "idle" }),
			session("/one", "one", "working", "2026-10-12T15:00:00.000Z", { status: "working" }),
			session("/one", "one", "needs", "2026-10-12T12:00:00.000Z", { status: "needs_answer" }),
		]);
		expect(sorted.map((entry) => entry.id)).toEqual(["needs", "working", "idle", "stopped"]);
	});

	test("inside one status the server order is kept, so equal rows never swap", () => {
		const sorted = sortSessionsByAttention([
			session("/one", "one", "newer", "2026-10-12T16:00:00.000Z", { status: "working" }),
			session("/one", "one", "older", "2026-10-12T15:00:00.000Z", { status: "working" }),
			session("/one", "one", "needs", "2026-10-12T14:00:00.000Z", { status: "needs_answer" }),
			session("/one", "one", "middle", "2026-10-12T13:00:00.000Z", { status: "working" }),
		]);
		expect(sorted.map((entry) => entry.id)).toEqual(["needs", "newer", "older", "middle"]);
	});

	test("leaves the input array alone", () => {
		const sessions = [session("/one", "one", "a", "2026-10-12T16:00:00.000Z", { status: "stopped" }), session("/one", "one", "b", "2026-10-12T15:00:00.000Z", { status: "needs_answer" })];
		sortSessionsByAttention(sessions);
		expect(sessions.map((entry) => entry.id)).toEqual(["a", "b"]);
	});
});
function openState(over: Partial<AppState>): AppState {
	return { ...initialAppState(), connection: "open", ...over };
}

describe("SessionsScreen", () => {
	test("loading is shown while the first list is on its way", () => {
		const root = mount({ ...initialAppState(), connection: "connecting" }, stubActions());
		expect(root.textContent).toContain("loading sessions");
	});

	test("an error is announced", () => {
		const root = mount(openState({ error: "Could not reach Burrow" }), stubActions());
		expect(root.textContent).toContain("Could not reach Burrow");
	});

	test("no sessions at all explains how to start one", () => {
		const root = mount(openState({}), stubActions());
		expect(root.textContent).toContain("no sessions yet");
	});

	test("sessions render their title and repo, and a held one opens read only", () => {
		const opened: string[] = [];
		const watched: string[] = [];
		const root = mount(
			openState({
				sessions: [
					session("/home/user/code", "code", "alpha", "2026-10-12T16:00:00.000Z", { title: "Fix the parser", status: "working", running: true }),
					session("/home/user/code", "code", "beta", "2026-10-12T15:00:00.000Z", { title: "In use at the host", openElsewhere: true }),
				],
			}),
			stubActions({ openSession: (id) => void opened.push(id), watchSession: async (file) => void watched.push(file) }),
		);
		expect(root.textContent).toContain("Fix the parser");
		expect(root.textContent).toContain("in use elsewhere");
		const rows = byClass(root, "row");
		expect(rows).toHaveLength(2);
		act(() => rows[0]!.dispatch("click"));
		expect(opened).toEqual(["alpha"]);
		act(() => rows[1]!.dispatch("click"));
		expect(watched).toEqual(["/sessions/beta.jsonl"]);
	});

	test("an omp held session says so, and both kinds of holder press into the same view", () => {
		const watched: string[] = [];
		const root = mount(
			openState({
				sessions: [
					session("/home/user/code", "code", "beta", "2026-10-12T15:00:00.000Z", { title: "Open on the laptop", openElsewhere: true, canTakeOver: true }),
					session("/home/user/code", "code", "gamma", "2026-10-12T14:00:00.000Z", { title: "Held elsewhere", openElsewhere: true, canTakeOver: false }),
				],
			}),
			stubActions({ watchSession: async (file) => void watched.push(file) }),
		);
		expect(root.textContent).toContain("in use on the laptop");
		expect(root.textContent).toContain("in use elsewhere");
		const rows = byClass(root, "row");
		expect(rows).toHaveLength(2);
		expect(rows.map((row) => row.nodeName)).toEqual(["BUTTON", "BUTTON"]);
		act(() => rows[0]!.dispatch("click"));
		expect(watched).toEqual(["/sessions/beta.jsonl"]);
		// Taking over is not a list action any more: it lives in the read only view.
		expect(root.textContent).not.toContain("Stops the omp running on the laptop");
	});

	test("a held session with no file to read is not pressable at all", () => {
		const watched: string[] = [];
		const root = mount(
			openState({
				sessions: [
					session("/home/user/code", "code", "beta", "2026-10-12T15:00:00.000Z", { openElsewhere: true, sessionFile: null }),
				],
			}),
			stubActions({ watchSession: async (file) => void watched.push(file) }),
		);
		act(() => byClass(root, "row")[0]!.dispatch("click"));
		expect(watched).toEqual([]);
	});

	test("the search box narrows by title and repo, and says so when nothing matches", async () => {
		const root = mount(
			openState({
				sessions: [
					session("/home/user/code", "code", "alpha", "2026-10-12T16:00:00.000Z", { title: "Fix the parser" }),
					session("/home/user/rausoft", "rausoft", "beta", "2026-10-12T15:00:00.000Z", { title: "Deploy script" }),
				],
			}),
			stubActions(),
		);
		const box = byClass(root, "sessions-search")[0]!;
		box.value = "rausoft";
		box.dispatch("input");
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(root.textContent).toContain("Deploy script");
		expect(root.textContent).not.toContain("Fix the parser");
		box.value = "nothing-here";
		box.dispatch("input");
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(root.textContent).toContain("nothing matches");
	});
});
