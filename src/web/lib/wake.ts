// Turning Remote mode on from the phone. The wake server is the always-on piece,
// but it can be mid-restart (a reboot, a crash, a deploy), so a failed wake
// request is retried before the user is told the laptop did not answer.

export type WakeOutcome = "woke" | "already-up" | "no-answer";

export interface WakeAttempt {
	/** True when the wake server answered the request. */
	post: () => Promise<boolean>;
	/** True when Burrow answers, which means Remote mode is already on. */
	burrowUp: () => Promise<boolean>;
	attempts?: number;
	delayMs?: number;
	sleep?: (ms: number) => Promise<void>;
}

export async function turnRemoteOn(options: WakeAttempt): Promise<WakeOutcome> {
	const attempts = options.attempts ?? 3;
	const delayMs = options.delayMs ?? 1000;
	const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

	for (let attempt = 1; attempt <= attempts; attempt++) {
		const woke = await options.post().catch(() => false);
		if (woke) return "woke";
		if (await options.burrowUp().catch(() => false)) return "already-up";
		if (attempt < attempts) await sleep(delayMs);
	}
	return "no-answer";
}
