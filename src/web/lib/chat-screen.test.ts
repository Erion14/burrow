// The chat screen while following a session another omp process at the host writes:
// there is nothing to type into, and taking the session over is the way to get a
// composer back. Both directions are pinned here, because "no composer" is behavior,
// not an omission.

import { describe, expect, test } from "bun:test";
import { act } from "preact/test-utils";
import type { SessionSummary } from "../../shared/types";
import { ChatScreen } from "../screens/chat-screen";
import { byClass, mount, stubActions, type Elm } from "../../../test/web-dom";
import type { AppActions, AppState } from "./app-state";
import { initialAppState } from "./app-state";

function summary(over: Partial<SessionSummary>): SessionSummary {
	return {
		id: "s1",
		repo: "/home/user/code",
		repoName: "code",
		title: "Open on the laptop",
		status: "idle",
		running: false,
		openElsewhere: true,
		canTakeOver: true,
		sessionFile: "/sessions/s1.jsonl",
		updatedAt: "2026-10-12T15:00:00.000Z",
		...over,
	};
}

function chat(over: Partial<AppState>, actions: AppActions): Elm {
	const state: AppState = {
		...initialAppState(),
		connection: "open",
		screen: "chat",
		sessionId: "s1",
		session: summary({}),
		...over,
	};
	return mount(ChatScreen, { state, actions });
}

describe("ChatScreen following another process's session", () => {
	test("offers no composer, says it is read only, and takes over after a confirm", async () => {
		const taken: string[] = [];
		const root = chat({ readOnly: true }, stubActions({ takeOver: async (file) => void taken.push(file) }));

		expect(byClass(root, "composer")).toHaveLength(0);
		expect(byClass(root, "key-bar")).toHaveLength(0);
		expect(byClass(root, "read-only-bar")).toHaveLength(1);
		expect(root.textContent).toContain("read only");
		expect(root.textContent).toContain("Following the copy on the laptop");

		act(() => byClass(root, "btn-take-over")[0]!.dispatch("click"));
		expect(taken).toEqual([]);
		expect(root.textContent).toContain("Stops the omp running on the laptop and continues the session here");

		await act(async () => byClass(root, "take-over-confirm")[0]!.dispatch("click"));
		expect(taken).toEqual(["/sessions/s1.jsonl"]);
	});

	test("a held session that no omp can be stopped for offers no take over", () => {
		const root = chat({ readOnly: true, session: summary({ canTakeOver: false }) }, stubActions());
		expect(byClass(root, "composer")).toHaveLength(0);
		expect(byClass(root, "read-only-bar")).toHaveLength(1);
		expect(byClass(root, "btn-take-over")).toHaveLength(0);
	});

	test("a session Burrow runs keeps its composer", () => {
		const root = chat(
			{ readOnly: false, session: summary({ running: true, openElsewhere: false, canTakeOver: false }) },
			stubActions(),
		);
		expect(byClass(root, "composer")).toHaveLength(1);
		expect(byClass(root, "read-only-bar")).toHaveLength(0);
	});
});
