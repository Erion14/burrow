// Stops the omp process of a session nobody is watching once it has been quiet
// for the idle timeout. The session stays resumable from its session file.

import type { SessionSnapshot } from "../shared/types";
import type { SessionManagerPort } from "./sessions/port";

export interface IdleStopperOptions {
	manager: SessionManagerPort;
	attachedCount: (sessionId: string) => number;
	timeoutMs: number;
	pollMs?: number;
	now?: () => number;
	onStopped?: (sessionId: string) => void;
}

export interface IdleStopper {
	start(): void;
	stop(): void;
	/** Runs one sweep and returns the ids it stopped. Never throws. */
	evaluate(): Promise<string[]>;
}

export function idleEligible(snapshot: SessionSnapshot, attached: number): boolean {
	return (
		attached === 0 &&
		snapshot.status.isSettled &&
		!snapshot.status.hasPendingAsyncWork &&
		snapshot.dialog === null &&
		snapshot.queued.steering.length === 0 &&
		snapshot.queued.followUp.length === 0
	);
}

export function createIdleStopper(options: IdleStopperOptions): IdleStopper {
	const { manager, attachedCount, timeoutMs } = options;
	const pollMs = options.pollMs ?? Math.max(1000, Math.min(30_000, Math.floor(timeoutMs / 4)));
	const now = options.now ?? Date.now;
	/** When each session last became continuously eligible. */
	const eligibleSince = new Map<string, number>();
	const stopping = new Set<string>();
	let timer: ReturnType<typeof setInterval> | null = null;

	async function evaluate(): Promise<string[]> {
		const stopped: string[] = [];
		try {
			const running = manager.heldIds();
			const runningSet = new Set(running);
			for (const id of eligibleSince.keys()) {
				if (!runningSet.has(id)) eligibleSince.delete(id);
			}
			const t = now();
			for (const id of running) {
				if (stopping.has(id)) continue;
				const snapshot = manager.snapshot(id);
				if (!snapshot || !idleEligible(snapshot, attachedCount(id))) {
					eligibleSince.delete(id);
					continue;
				}
				const since = eligibleSince.get(id) ?? t;
				eligibleSince.set(id, since);
				if (t - since < timeoutMs) continue;
				stopping.add(id);
				try {
					const result = await manager.stop(id, "idle");
					eligibleSince.delete(id);
					if (result.ok) {
						stopped.push(id);
						options.onStopped?.(id);
					}
				} catch {
					eligibleSince.delete(id);
				} finally {
					stopping.delete(id);
				}
			}
		} catch {
			// A failing sweep must not break the next one.
		}
		return stopped;
	}

	return {
		start() {
			if (timer) return;
			timer = setInterval(() => void evaluate(), pollMs);
		},
		stop() {
			clearInterval(timer ?? undefined);
			timer = null;
		},
		evaluate,
	};
}
