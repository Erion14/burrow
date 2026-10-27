import { describe, expect, test } from "bun:test";
import { turnRemoteOn } from "./wake";

describe("turnRemoteOn", () => {
	test("retries a wake server that is still coming up", async () => {
		const sleeps: number[] = [];
		let posts = 0;
		const outcome = await turnRemoteOn({
			post: async () => {
				posts++;
				return posts >= 2;
			},
			burrowUp: async () => false,
			attempts: 3,
			delayMs: 50,
			sleep: async (ms) => {
				sleeps.push(ms);
			},
		});
		expect(outcome).toBe("woke");
		expect(posts).toBe(2);
		expect(sleeps).toEqual([50]);
	});

	test("a thrown post is a failed attempt, not an error", async () => {
		const outcome = await turnRemoteOn({
			post: async () => {
				throw new Error("connection refused");
			},
			burrowUp: async () => true,
			attempts: 3,
			sleep: async () => {},
		});
		expect(outcome).toBe("already-up");
	});

	test("Burrow answering means Remote mode is already on", async () => {
		let posts = 0;
		const outcome = await turnRemoteOn({
			post: async () => {
				posts++;
				return false;
			},
			burrowUp: async () => true,
			attempts: 3,
			sleep: async () => {},
		});
		expect(outcome).toBe("already-up");
		expect(posts).toBe(1);
	});

	test("no answer after every attempt", async () => {
		let attempts = 0;
		const outcome = await turnRemoteOn({
			post: async () => {
				attempts++;
				return false;
			},
			burrowUp: async () => false,
			attempts: 3,
			delayMs: 5,
			sleep: async () => {},
		});
		expect(outcome).toBe("no-answer");
		expect(attempts).toBe(3);
	});
});
