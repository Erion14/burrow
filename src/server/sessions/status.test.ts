import { expect, test } from "bun:test";
import { createStatusTracker } from "./status";

test("starts idle and settled", () => {
	expect(createStatusTracker().snapshot()).toEqual({ status: "idle", isSettled: true, hasPendingAsyncWork: false });
});

test("run lifecycle: working until a yielding agent_end", () => {
	const s = createStatusTracker();
	expect(s.handle({ type: "agent_start" })).toEqual([{ type: "status", status: { status: "working", isSettled: false, hasPendingAsyncWork: false } }]);
	expect(s.handle({ type: "agent_start" })).toEqual([]);
	const end = s.handle({ type: "agent_end", yielded: true, isTerminal: true });
	expect(end[0]).toMatchObject({ type: "status", status: { status: "idle" } });
});

test("agent_end with yielded false stays working, three times over", () => {
	const s = createStatusTracker();
	s.handle({ type: "agent_start" });
	for (let i = 0; i < 3; i++) {
		s.handle({ type: "agent_end", yielded: false });
		expect(s.snapshot().status).toBe("working");
	}
	s.handle({ type: "session_settled" });
	expect(s.snapshot()).toEqual({ status: "idle", isSettled: true, hasPendingAsyncWork: false });
});

test("awaitingAsyncWork keeps working until session_settled", () => {
	const s = createStatusTracker();
	s.handle({ type: "agent_start" });
	s.handle({ type: "agent_end", yielded: true, awaitingAsyncWork: true });
	expect(s.snapshot()).toEqual({ status: "working", isSettled: false, hasPendingAsyncWork: true });
	s.handle({ type: "session_settled" });
	expect(s.snapshot().status).toBe("idle");
});

test("get_state with pending async work is not idle", () => {
	const s = createStatusTracker();
	s.setState({ isStreaming: false, isSettled: true, hasPendingAsyncWork: true });
	expect(s.snapshot().status).toBe("working");
	s.setState({ isStreaming: false, isSettled: true, hasPendingAsyncWork: false });
	expect(s.snapshot().status).toBe("idle");
	s.setState({ isStreaming: true, isSettled: false, hasPendingAsyncWork: false });
	expect(s.snapshot().status).toBe("working");
});

test("garbage state and unknown frames change nothing", () => {
	const s = createStatusTracker();
	s.setState(null);
	s.setState("x");
	expect(s.handle({ type: "message_start" })).toEqual([]);
	expect(s.snapshot().status).toBe("idle");
});
