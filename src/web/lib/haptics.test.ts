import { describe, expect, test } from "bun:test";
import { type VibrationHost, successFeedback, tapFeedback } from "./haptics";

/** A navigator stand-in that records the patterns it was asked to buzz. */
function recorder(): { host: VibrationHost; calls: (number | number[])[] } {
	const calls: (number | number[])[] = [];
	return { calls, host: { vibrate: (pattern) => calls.push(pattern) } };
}

describe("tapFeedback", () => {
	test("ticks once for the 10 ms the tap lasts", () => {
		const { host, calls } = recorder();
		tapFeedback(host);
		expect(calls).toEqual([10]);
	});
});

describe("successFeedback", () => {
	test("ticks twice with a gap between them", () => {
		const { host, calls } = recorder();
		successFeedback(host);
		expect(calls).toEqual([[10, 60, 10]]);
	});
});

describe("the no-op doors", () => {
	test("no navigator at all", () => {
		expect(() => tapFeedback(null)).not.toThrow();
		expect(() => successFeedback(null)).not.toThrow();
	});
	test("a navigator without vibrate", () => {
		expect(() => tapFeedback({})).not.toThrow();
		expect(() => successFeedback({})).not.toThrow();
	});
	test("a vibrate that a denied permission makes throw", () => {
		const host: VibrationHost = {
			vibrate: () => {
				throw new DOMException("denied", "NotAllowedError");
			},
		};
		expect(() => tapFeedback(host)).not.toThrow();
		expect(() => successFeedback(host)).not.toThrow();
	});
	test("a vibrate that returns false", () => {
		const calls: (number | number[])[] = [];
		const host: VibrationHost = {
			vibrate: (pattern) => {
				calls.push(pattern);
				return false;
			},
		};
		expect(() => tapFeedback(host)).not.toThrow();
		expect(calls).toEqual([10]);
	});
	test("the real navigator, which this runtime has no vibrate on", () => {
		expect(() => tapFeedback()).not.toThrow();
		expect(() => successFeedback()).not.toThrow();
	});
});
