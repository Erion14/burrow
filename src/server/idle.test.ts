import { describe, expect, test } from "bun:test";
import type { SessionSnapshot } from "../shared/types";
import { createIdleStopper, idleEligible } from "./idle";
import type { Result, SessionManagerPort, StopReason } from "./sessions/port";

const TIMEOUT = 1000;

function snap(over: Partial<{ settled: boolean; pending: boolean; dialog: boolean; steering: string[]; followUp: string[] }> = {}): SessionSnapshot {
	return {
		session: {} as SessionSnapshot["session"],
		items: [],
		dialog: over.dialog ? ({ id: "d" } as unknown as SessionSnapshot["dialog"]) : null,
		subagents: [],
		queued: { steering: over.steering ?? [], followUp: over.followUp ?? [] },
		status: { status: "idle", isSettled: over.settled ?? true, hasPendingAsyncWork: over.pending ?? false },
		truncated: false,
	};
}

function setup(failStop = false) {
	let time = 0;
	const running = new Set<string>(["s1"]);
	const snaps = new Map<string, SessionSnapshot>([["s1", snap()]]);
	const attached = new Map<string, number>();
	const stops: Array<[string, StopReason]> = [];
	const stoppedCb: string[] = [];
	const manager = {
		runningIds: () => [...running],
		snapshot: (id: string) => snaps.get(id) ?? null,
		stop: async (id: string, reason: StopReason): Promise<Result<null>> => {
			stops.push([id, reason]);
			if (failStop) throw new Error("boom");
			running.delete(id);
			return { ok: true, value: null };
		},
	} as unknown as SessionManagerPort;
	const stopper = createIdleStopper({
		manager,
		attachedCount: (id) => attached.get(id) ?? 0,
		timeoutMs: TIMEOUT,
		now: () => time,
		onStopped: (id) => stoppedCb.push(id),
	});
	return {
		stopper,
		snaps,
		attached,
		stops,
		stoppedCb,
		running,
		advance: (ms: number) => {
			time += ms;
		},
	};
}

describe("idleEligible", () => {
	test("true only for a quiet settled session with no phone", () => {
		expect(idleEligible(snap(), 0)).toBe(true);
		expect(idleEligible(snap(), 1)).toBe(false);
		expect(idleEligible(snap({ settled: false }), 0)).toBe(false);
		expect(idleEligible(snap({ pending: true }), 0)).toBe(false);
		expect(idleEligible(snap({ dialog: true }), 0)).toBe(false);
		expect(idleEligible(snap({ steering: ["x"] }), 0)).toBe(false);
		expect(idleEligible(snap({ followUp: ["x"] }), 0)).toBe(false);
	});
});

describe("idle stopper", () => {
	test("stops exactly once after the timeout and not before", async () => {
		const t = setup();
		expect(await t.stopper.evaluate()).toEqual([]);
		t.advance(TIMEOUT - 1);
		expect(await t.stopper.evaluate()).toEqual([]);
		t.advance(1);
		expect(await t.stopper.evaluate()).toEqual(["s1"]);
		t.advance(TIMEOUT * 5);
		expect(await t.stopper.evaluate()).toEqual([]);
		expect(t.stops).toEqual([["s1", "idle"]]);
		expect(t.stoppedCb).toEqual(["s1"]);
	});

	test("attach then detach restarts the full timeout", async () => {
		const t = setup();
		await t.stopper.evaluate();
		t.advance(TIMEOUT - 1);
		t.attached.set("s1", 1);
		await t.stopper.evaluate();
		t.attached.set("s1", 0);
		await t.stopper.evaluate();
		t.advance(TIMEOUT - 1);
		expect(await t.stopper.evaluate()).toEqual([]);
		t.advance(1);
		expect(await t.stopper.evaluate()).toEqual(["s1"]);
	});

	test("an attached phone prevents the stop", async () => {
		const t = setup();
		t.attached.set("s1", 1);
		await t.stopper.evaluate();
		t.advance(TIMEOUT * 10);
		expect(await t.stopper.evaluate()).toEqual([]);
		expect(t.stops).toEqual([]);
	});

	const blockers: Array<[string, Parameters<typeof snap>[0]]> = [
		["pending async work", { pending: true }],
		["an open dialog", { dialog: true }],
		["an unsettled session", { settled: false }],
		["queued steering", { steering: ["a"] }],
		["queued follow-up", { followUp: ["a"] }],
	];
	for (const [name, over] of blockers) {
		test(`${name} prevents the stop`, async () => {
			const t = setup();
			t.snaps.set("s1", snap(over));
			await t.stopper.evaluate();
			t.advance(TIMEOUT * 10);
			expect(await t.stopper.evaluate()).toEqual([]);
			expect(t.stops).toEqual([]);
		});
	}

	test("eligible, active, eligible again waits a fresh timeout", async () => {
		const t = setup();
		await t.stopper.evaluate();
		t.advance(TIMEOUT - 1);
		t.snaps.set("s1", snap({ settled: false }));
		await t.stopper.evaluate();
		t.advance(10);
		t.snaps.set("s1", snap());
		await t.stopper.evaluate();
		t.advance(TIMEOUT - 1);
		expect(await t.stopper.evaluate()).toEqual([]);
		t.advance(1);
		expect(await t.stopper.evaluate()).toEqual(["s1"]);
	});

	test("a dialog opening mid-wait resets the clock", async () => {
		const t = setup();
		await t.stopper.evaluate();
		t.advance(TIMEOUT - 1);
		t.snaps.set("s1", snap({ dialog: true }));
		await t.stopper.evaluate();
		t.snaps.set("s1", snap());
		await t.stopper.evaluate();
		t.advance(TIMEOUT - 1);
		expect(await t.stopper.evaluate()).toEqual([]);
	});

	test("sessions that are not running are ignored", async () => {
		const t = setup();
		await t.stopper.evaluate();
		t.running.delete("s1");
		t.advance(TIMEOUT * 2);
		expect(await t.stopper.evaluate()).toEqual([]);
		expect(t.stops).toEqual([]);
	});

	test("evaluate does not throw when stop fails or reports an error", async () => {
		const t = setup(true);
		await t.stopper.evaluate();
		t.advance(TIMEOUT);
		expect(await t.stopper.evaluate()).toEqual([]);
		expect(t.stops).toEqual([["s1", "idle"]]);
		expect(t.stoppedCb).toEqual([]);

		const manager = {
			runningIds: () => ["s1"],
			snapshot: () => snap(),
			stop: async (): Promise<Result<null>> => ({ ok: false, error: { code: "x", message: "no" } }),
		} as unknown as SessionManagerPort;
		let time = 0;
		const s = createIdleStopper({ manager, attachedCount: () => 0, timeoutMs: TIMEOUT, now: () => time });
		await s.evaluate();
		time = TIMEOUT;
		expect(await s.evaluate()).toEqual([]);
	});

	test("start and stop manage the timer", () => {
		const t = setup();
		t.stopper.start();
		t.stopper.start();
		t.stopper.stop();
		t.stopper.stop();
	});
});
