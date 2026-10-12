// Stream decoder for omp stdout: JSONL lines plus protocol v2 `rpc_chunk`
// reassembly. Malformed input is reported as an `error` result and never
// throws, so one bad line cannot take the stream down.

export type DecodeResult = { kind: "frame"; value: unknown } | { kind: "error"; message: string };

export interface FrameDecoderOptions {
	maxReassembledBytes: number;
}

export interface FrameDecoder {
	push(bytes: Uint8Array): DecodeResult[];
}

interface Sequence {
	chunkId: string;
	count: number;
	byteLength: number;
	next: number;
	parts: Uint8Array[];
	received: number;
}

const NEWLINE = 0x0a;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCount(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function concat(parts: Uint8Array[], total: number): Uint8Array {
	if (parts.length === 1) return parts[0]!;
	const out = new Uint8Array(total);
	let offset = 0;
	for (const part of parts) {
		out.set(part, offset);
		offset += part.length;
	}
	return out;
}

export function createFrameDecoder(options: FrameDecoderOptions): FrameDecoder {
	// Fatal decoders throw on invalid UTF-8, which we turn into an error result.
	const utf8 = new TextDecoder("utf-8", { fatal: true });
	let pending: Uint8Array[] = [];
	let pendingBytes = 0;
	let sequence: Sequence | null = null;
	// After a sequence fails, its remaining chunks are dropped silently so one
	// fault produces one error and cannot corrupt the frames that follow.
	const discarded = new Set<string>();
	function discard(id: string): void {
		if (discarded.size >= 64) discarded.clear();
		discarded.add(id);
	}

	function parseObject(bytes: Uint8Array, what: string): DecodeResult {
		let value: unknown;
		try {
			value = JSON.parse(utf8.decode(bytes));
		} catch (error) {
			return { kind: "error", message: `${what} is not valid UTF-8 JSON: ${error instanceof Error ? error.message : String(error)}` };
		}
		if (!isObject(value)) return { kind: "error", message: `${what} is not a JSON object` };
		return { kind: "frame", value };
	}

	function abandon(message: string, out: DecodeResult[]): void {
		if (sequence) discard(sequence.chunkId);
		sequence = null;
		out.push({ kind: "error", message });
	}

	function handleChunk(frame: Record<string, unknown>, out: DecodeResult[]): void {
		const { chunkId, index, count, byteLength, data } = frame;
		if (typeof chunkId !== "string" || chunkId === "") {
			if (sequence) abandon("rpc_chunk sequence interrupted by an invalid chunk", out);
			else out.push({ kind: "error", message: "rpc_chunk has no chunkId" });
			return;
		}
		if (!isCount(index) || !isCount(count) || count < 1 || index >= count || !isCount(byteLength) || typeof data !== "string" || !BASE64.test(data)) {
			if (sequence) abandon(`rpc_chunk ${chunkId} has invalid fields`, out);
			else {
				discard(chunkId);
				out.push({ kind: "error", message: `rpc_chunk ${chunkId} has invalid fields` });
			}
			return;
		}
		if (sequence && sequence.chunkId !== chunkId) {
			abandon(`rpc_chunk ${chunkId} interleaved with ${sequence.chunkId}`, out);
			// The newcomer's own chunks are part of the same fault.
			discard(chunkId);
			return;
		}
		if (!sequence) {
			if (discarded.has(chunkId)) return;
			if (index !== 0) {
				discard(chunkId);
				out.push({ kind: "error", message: `rpc_chunk ${chunkId} starts at index ${index}` });
				return;
			}
			if (byteLength > options.maxReassembledBytes) {
				discard(chunkId);
				out.push({ kind: "error", message: `rpc_chunk ${chunkId} is ${byteLength} bytes, over the ${options.maxReassembledBytes} byte limit` });
				return;
			}
			sequence = { chunkId, count, byteLength, next: 0, parts: [], received: 0 };
		}
		const seq = sequence;
		if (count !== seq.count || byteLength !== seq.byteLength) {
			abandon(`rpc_chunk ${chunkId} changed count or byteLength mid sequence`, out);
			return;
		}
		if (index !== seq.next) {
			abandon(`rpc_chunk ${chunkId} out of order: expected ${seq.next}, got ${index}`, out);
			return;
		}
		const bytes = Buffer.from(data, "base64");
		seq.received += bytes.length;
		if (seq.received > seq.byteLength) {
			abandon(`rpc_chunk ${chunkId} carries more than its byteLength`, out);
			return;
		}
		seq.parts.push(bytes);
		seq.next += 1;
		if (seq.next < seq.count) return;
		sequence = null;
		if (seq.received !== seq.byteLength) {
			discard(chunkId);
			out.push({ kind: "error", message: `rpc_chunk ${chunkId} decoded to ${seq.received} bytes, expected ${seq.byteLength}` });
			return;
		}
		const result = parseObject(concat(seq.parts, seq.received), `rpc_chunk ${chunkId} payload`);
		if (result.kind === "frame" && isObject(result.value) && result.value.type === "rpc_chunk") {
			out.push({ kind: "error", message: `rpc_chunk ${chunkId} payload is itself a chunk` });
			return;
		}
		out.push(result);
	}

	function handleLine(bytes: Uint8Array, out: DecodeResult[]): void {
		let end = bytes.length;
		if (end > 0 && bytes[end - 1] === 0x0d) end -= 1;
		if (end === 0) return;
		const parsed = parseObject(bytes.subarray(0, end), "line");
		if (parsed.kind === "error") {
			if (sequence) abandon("rpc_chunk sequence interrupted by a malformed line", out);
			out.push(parsed);
			return;
		}
		const frame = parsed.value as Record<string, unknown>;
		if (frame.type === "rpc_chunk") {
			handleChunk(frame, out);
			return;
		}
		if (sequence) abandon(`rpc_chunk sequence ${sequence.chunkId} interrupted by a ${String(frame.type)} frame`, out);
		out.push(parsed);
	}

	return {
		push(bytes) {
			const out: DecodeResult[] = [];
			let start = 0;
			// Only scan new bytes for the newline so a multi-MiB line is not rescanned per push.
			for (let at = bytes.indexOf(NEWLINE, start); at !== -1; at = bytes.indexOf(NEWLINE, start)) {
				pending.push(bytes.subarray(start, at));
				pendingBytes += at - start;
				handleLine(concat(pending, pendingBytes), out);
				pending = [];
				pendingBytes = 0;
				start = at + 1;
			}
			if (start < bytes.length) {
				// Copy: the caller may reuse its buffer after push returns.
				pending.push(bytes.slice(start));
				pendingBytes += bytes.length - start;
			}
			return out;
		},
	};
}
