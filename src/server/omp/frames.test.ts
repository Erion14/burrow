import { describe, expect, test } from "bun:test";
import { createFrameDecoder, type DecodeResult } from "./frames";

const enc = new TextEncoder();

function line(value: unknown): Uint8Array {
	return enc.encode(`${JSON.stringify(value)}\n`);
}

function chunks(value: unknown, size: number, chunkId = "rpc-1") {
	const bytes = enc.encode(JSON.stringify(value));
	const count = Math.ceil(bytes.length / size);
	return Array.from({ length: count }, (_, index) => ({
		type: "rpc_chunk",
		chunkId,
		index,
		count,
		byteLength: bytes.length,
		data: Buffer.from(bytes.subarray(index * size, (index + 1) * size)).toString("base64"),
	}));
}

function decoder(max = 1 << 20) {
	const d = createFrameDecoder({ maxReassembledBytes: max });
	return (...parts: Uint8Array[]): DecodeResult[] => parts.flatMap((p) => d.push(p));
}

const kinds = (r: DecodeResult[]) => r.map((x) => x.kind);

describe("createFrameDecoder", () => {
	test("splits lines and keeps a partial line buffered across pushes", () => {
		const push = decoder();
		const bytes = line({ type: "a", n: 1 });
		expect(push(bytes.subarray(0, 5))).toEqual([]);
		const out = push(bytes.subarray(5), line({ type: "b" }));
		expect(out).toEqual([
			{ kind: "frame", value: { type: "a", n: 1 } },
			{ kind: "frame", value: { type: "b" } },
		]);
	});

	test("handles a multi-byte character split across pushes", () => {
		const push = decoder();
		const bytes = line({ text: "héllo €" });
		const out: DecodeResult[] = [];
		for (const b of bytes) out.push(...push(new Uint8Array([b])));
		expect(out).toEqual([{ kind: "frame", value: { text: "héllo €" } }]);
	});

	test("a malformed line is one error and the stream continues", () => {
		const push = decoder();
		const out = push(enc.encode("{not json\n"), line({ type: "ok" }));
		expect(kinds(out)).toEqual(["error", "frame"]);
		expect(out[1]).toEqual({ kind: "frame", value: { type: "ok" } });
	});

	test("non-object JSON is an error, blank lines are skipped", () => {
		const push = decoder();
		const out = push(enc.encode("[1]\n\n42\r\n"), line({ type: "ok" }));
		expect(kinds(out)).toEqual(["error", "error", "frame"]);
	});

	test("reassembles a large logical frame byte exact", () => {
		const big = { type: "response", data: { text: "€é".repeat(200_000) } };
		const frames = chunks(big, 64 * 1024);
		expect(frames.length).toBeGreaterThan(5);
		const push = decoder();
		const out = push(...frames.map(line));
		expect(out).toEqual([{ kind: "frame", value: big }]);
	});

	test("chunk boundaries may split a UTF-8 character", () => {
		const value = { text: "€€€€" };
		const out = decoder()(...chunks(value, 2).map(line));
		expect(out).toEqual([{ kind: "frame", value }]);
	});

	test("out of order chunks are an error and the next frame is intact", () => {
		const f = chunks({ type: "x", pad: "y".repeat(100) }, 30);
		const push = decoder();
		const out = push(line(f[0]), line(f[2]), line(f[1]), line({ type: "next" }));
		expect(out.filter((r) => r.kind === "error")).toHaveLength(1);
		expect(out.at(-1)).toEqual({ kind: "frame", value: { type: "next" } });
	});

	test("an interleaved sequence is an error", () => {
		const a = chunks({ type: "a", pad: "1".repeat(80) }, 30, "rpc-a");
		const b = chunks({ type: "b", pad: "2".repeat(80) }, 30, "rpc-b");
		const push = decoder();
		const out = push(line(a[0]), line(b[0]), line(b[1]), line(b[2]), line(a[1]), line({ type: "next" }));
		expect(out.some((r) => r.kind === "error")).toBe(true);
		expect(out.filter((r) => r.kind === "frame").at(-1)).toEqual({ kind: "frame", value: { type: "next" } });
		// Neither interleaved logical frame is delivered.
		expect(out.filter((r) => r.kind === "frame")).toHaveLength(1);
	});

	test("a sequence interrupted by a plain frame is an error, the plain frame is delivered", () => {
		const f = chunks({ type: "x", pad: "y".repeat(100) }, 30);
		const out = decoder()(line(f[0]), line({ type: "event" }));
		expect(kinds(out)).toEqual(["error", "frame"]);
		expect(out[1]).toEqual({ kind: "frame", value: { type: "event" } });
	});

	test("count mismatch inside a sequence is an error", () => {
		const f = chunks({ type: "x", pad: "y".repeat(100) }, 30);
		const bad = { ...f[1], count: f[1]!.count + 1 };
		const out = decoder()(line(f[0]), line(bad), line(f[2]!), line({ type: "next" }));
		expect(out.filter((r) => r.kind === "error")).toHaveLength(1);
		expect(out.at(-1)).toEqual({ kind: "frame", value: { type: "next" } });
	});

	test("byteLength that does not match the decoded bytes is an error", () => {
		const f = chunks({ type: "x", pad: "y".repeat(100) }, 30).map((c) => ({ ...c, byteLength: c.byteLength + 1 }));
		const out = decoder()(...f.map(line), line({ type: "next" }));
		expect(kinds(out)).toEqual(["error", "frame"]);
	});

	test("a sequence over maxReassembledBytes is an error and the next frame is intact", () => {
		const f = chunks({ type: "x", pad: "y".repeat(5000) }, 1000);
		const out = decoder(1024)(...f.map(line), line({ type: "next" }));
		expect(kinds(out)).toEqual(["error", "frame"]);
		expect(out[1]).toEqual({ kind: "frame", value: { type: "next" } });
	});

	test("invalid chunk fields are errors", () => {
		const base = chunks({ type: "x" }, 100)[0]!;
		for (const patch of [
			{ chunkId: "" },
			{ chunkId: 5 },
			{ index: -1 },
			{ index: 1.5 },
			{ count: 0 },
			{ count: "1" },
			{ byteLength: -1 },
			{ data: 7 },
			{ data: "!!!" },
		]) {
			const out = decoder()(line({ ...base, ...patch }), line({ type: "next" }));
			expect(kinds(out)).toEqual(["error", "frame"]);
		}
	});

	test("invalid UTF-8 after reassembly is an error", () => {
		const bytes = new Uint8Array([0x7b, 0xff, 0x7d]);
		const frame = {
			type: "rpc_chunk",
			chunkId: "c",
			index: 0,
			count: 1,
			byteLength: 3,
			data: Buffer.from(bytes).toString("base64"),
		};
		expect(kinds(decoder()(line(frame)))).toEqual(["error"]);
	});

	test("reassembled bytes that are not a JSON object are an error", () => {
		const frame = {
			type: "rpc_chunk",
			chunkId: "c",
			index: 0,
			count: 1,
			byteLength: 4,
			data: Buffer.from("nope").toString("base64"),
		};
		expect(kinds(decoder()(line(frame), line({ type: "next" })))).toEqual(["error", "frame"]);
	});

	test("two sequential sequences both reassemble", () => {
		const a = chunks({ type: "a", pad: "1".repeat(80) }, 30, "rpc-1");
		const b = chunks({ type: "b", pad: "2".repeat(80) }, 30, "rpc-2");
		const out = decoder()(...[...a, ...b].map(line));
		expect(out.map((r) => (r.kind === "frame" ? (r.value as { type: string }).type : "error"))).toEqual(["a", "b"]);
	});
});
