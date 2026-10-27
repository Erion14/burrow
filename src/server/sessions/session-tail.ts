// Reading a session file another omp process writes: the read only view of a
// session held at the host. This module never writes, never throws on a file that
// changes under it, and never reads more than a bounded chunk per call: a rewritten
// file resets the reader, a deleted one is simply empty, and an incomplete trailing
// line waits for the rest of itself.

import { open, stat } from "node:fs/promises";
import type { StatusView, TranscriptItem } from "../../shared/types";
import { SNAPSHOT_ITEM_LIMIT, bashText, extractParts, outputText, summariseArgs, toolOutputTail } from "./transcript";

/** Where the reader stopped: a byte offset, the file identity, and whether its first window was cut. */
export interface TailState {
	offset: number;
	ino: number | null;
	/** The file's modification time at the last read, so an edit in place is noticed. */
	mtimeMs: number;
	truncated: boolean;
}

export interface TailRead {
	entries: unknown[];
	state: TailState;
	/** The file shrank or was replaced: drop what was read before and keep only these entries. */
	reset: boolean;
}

export interface TailOptions {
	/** How much of an already existing file the first read takes, counted from its end. */
	windowBytes?: number;
	/** Ceiling on one read, so a file that grew by a lot is drained over several polls. */
	maxBytesPerRead?: number;
}

export interface BuiltTranscript {
	items: TranscriptItem[];
	truncated: boolean;
	/** What the file can answer of the live status; the parts it cannot stay absent. */
	status: StatusView;
}

const DEFAULT_WINDOW_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_READ_BYTES = 4 * 1024 * 1024;
const NOTICE_LIMIT = 200;

type Rec = Record<string, unknown>;

function isRec(value: unknown): value is Rec {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Bytes from `from` to the end of that line, so a window never starts mid line. */
async function lineStartAfter(file: string, from: number): Promise<number> {
	const handle = await open(file, "r");
	try {
		const buffer = Buffer.allocUnsafe(64 * 1024);
		const { bytesRead } = await handle.read(buffer, 0, buffer.length, from);
		const newline = buffer.subarray(0, bytesRead).indexOf(0x0a);
		return newline < 0 ? from + bytesRead : from + newline + 1;
	} finally {
		await handle.close();
	}
}

async function readBytes(file: string, from: number, length: number): Promise<Buffer> {
	const handle = await open(file, "r");
	try {
		const buffer = Buffer.allocUnsafe(length);
		let filled = 0;
		while (filled < length) {
			const { bytesRead } = await handle.read(buffer, filled, length - filled, from + filled);
			if (bytesRead === 0) break;
			filled += bytesRead;
		}
		return buffer.subarray(0, filled);
	} finally {
		await handle.close();
	}
}

function parseLines(bytes: Buffer): unknown[] {
	const entries: unknown[] = [];
	for (const line of bytes.toString("utf8").split("\n")) {
		if (line.trim() === "") continue;
		try {
			entries.push(JSON.parse(line));
		} catch {
			// A half written or corrupt line is not worth failing the view over.
		}
	}
	return entries;
}

export async function readTail(file: string, state: TailState, options: TailOptions = {}): Promise<TailRead> {
	const windowBytes = options.windowBytes ?? DEFAULT_WINDOW_BYTES;
	const maxBytesPerRead = options.maxBytesPerRead ?? DEFAULT_MAX_READ_BYTES;
	let info;
	try {
		info = await stat(file);
	} catch {
		return { entries: [], state, reset: false };
	}
	// A shrink or a new inode is a rewrite. So is a file that changed while keeping its
	// size: the title slot is updated in place, and a rewrite that lands on the same length
	// would otherwise leave the reader stuck on a line boundary that no longer exists.
	const editedInPlace = info.size === state.offset && info.mtimeMs !== state.mtimeMs;
	const replaced = state.ino !== null && (info.ino !== state.ino || info.size < state.offset || editedInPlace);
	let from = replaced ? 0 : state.offset;
	let truncated = replaced ? false : state.truncated;
	if (replaced || state.ino === null) {
		if (info.size > windowBytes) {
			from = await lineStartAfter(file, info.size - windowBytes);
			truncated = true;
		}
	}
	if (from >= info.size) {
		return { entries: [], state: { offset: from, ino: info.ino, mtimeMs: info.mtimeMs, truncated }, reset: replaced };
	}

	const bytes = await readBytes(file, from, Math.min(info.size - from, maxBytesPerRead));
	const lastNewline = bytes.lastIndexOf(0x0a);
	if (lastNewline < 0) {
		return { entries: [], state: { offset: from, ino: info.ino, mtimeMs: info.mtimeMs, truncated }, reset: replaced };
	}
	const complete = bytes.subarray(0, lastNewline + 1);
	return {
		entries: parseLines(complete),
		state: { offset: from + complete.length, ino: info.ino, mtimeMs: info.mtimeMs, truncated },
		reset: replaced,
	};
}

/** The session entry a line carries: the header and the title slot are not entries. */
function asEntry(value: unknown): Rec | null {
	if (!isRec(value) || typeof value.id !== "string") return null;
	return value.type === "session" || value.type === "title" ? null : value;
}

function parentOf(entry: Rec): string | null {
	return typeof entry.parentId === "string" ? entry.parentId : null;
}

function stampOf(entry: Rec): string {
	return typeof entry.timestamp === "string" ? entry.timestamp : new Date().toISOString();
}

function textOf(value: unknown): string {
	return typeof value === "string" ? value : "";
}

/** The header a session file starts with: the title slot may sit in front of it. */
export interface SessionHeaderFacts {
	id: string;
	cwd: string;
	title: string;
}

const HEADER_BYTES = 64 * 1024;

export async function readHeader(file: string): Promise<SessionHeaderFacts | null> {
	let text: string;
	try {
		text = await Bun.file(file).slice(0, HEADER_BYTES).text();
	} catch {
		return null;
	}
	let slotTitle = "";
	for (const line of text.split("\n", 200)) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			continue;
		}
		if (!isRec(parsed)) continue;
		if (parsed.type === "title" && typeof parsed.title === "string" && parsed.title !== "") slotTitle = parsed.title;
		if (parsed.type !== "session") continue;
		if (typeof parsed.id !== "string" || typeof parsed.cwd !== "string") return null;
		const own = typeof parsed.title === "string" && parsed.title !== "" ? parsed.title : slotTitle;
		return { id: parsed.id, cwd: parsed.cwd, title: own };
	}
	return null;
}

/** The chain of entries from the last one back to the root, in file order. */
function chainOf(entries: unknown[]): Rec[] {
	const byId = new Map<string, Rec>();
	for (const value of entries) {
		const entry = asEntry(value);
		if (entry !== null) byId.set(entry.id as string, entry);
	}
	let current: Rec | null = null;
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = asEntry(entries[index]);
		if (entry !== null) {
			current = entry;
			break;
		}
	}
	const chain: Rec[] = [];
	const seen = new Set<string>();
	while (current !== null) {
		const id = current.id as string;
		if (seen.has(id)) break;
		seen.add(id);
		chain.push(current);
		const parent = parentOf(current);
		current = parent === null ? null : (byId.get(parent) ?? null);
	}
	return chain.reverse();
}

function toolResultsOf(chain: Rec[]): Map<string, { text: string; isError: boolean }> {
	const results = new Map<string, { text: string; isError: boolean }>();
	for (const entry of chain) {
		const message = isRec(entry.message) ? entry.message : null;
		if (message === null || message.role !== "toolResult") continue;
		const callId = typeof message.toolCallId === "string" ? message.toolCallId : "";
		if (callId === "") continue;
		results.set(callId, { text: outputText(message.content) ?? "", isError: message.isError === true });
	}
	return results;
}

function toolCard(call: Rec, result: { text: string; isError: boolean } | undefined): TranscriptItem {
	const callId = typeof call.id === "string" ? call.id : "";
	return {
		id: `tool:${callId}`,
		kind: "tool",
		text: "",
		thinking: "",
		tool: {
			id: callId,
			name: typeof call.name === "string" ? call.name : "tool",
			args: summariseArgs(call.arguments ?? call.input ?? call.args),
			output: result === undefined ? "" : toolOutputTail(result.text),
			status: result === undefined ? "running" : result.isError ? "error" : "done",
		},
		createdAt: new Date().toISOString(),
	};
}

function messageItems(entry: Rec, results: Map<string, { text: string; isError: boolean }>): TranscriptItem[] {
	const message = isRec(entry.message) ? entry.message : null;
	if (message === null) return [];
	const id = entry.id as string;
	const createdAt = stampOf(entry);

	if (message.role === "user") {
		const parts = extractParts(message);
		return parts === null || parts.text === "" ? [] : [{ id, kind: "user", text: parts.text, thinking: "", createdAt }];
	}
	if (message.role === "assistant") {
		const parts = extractParts(message);
		const items: TranscriptItem[] = [];
		if (parts !== null && (parts.text !== "" || parts.thinking !== "")) {
			items.push({ id, kind: "assistant", text: parts.text, thinking: parts.thinking, createdAt });
		}
		if (Array.isArray(message.content)) {
			for (const block of message.content) {
				if (isRec(block) && block.type === "toolCall") {
					const card = toolCard(block, typeof block.id === "string" ? results.get(block.id) : undefined);
					items.push({ ...card, createdAt });
				}
			}
		}
		return items;
	}
	if (message.role === "bashExecution") {
		const output = outputText(message.output ?? message.content) ?? "";
		const cancelled = message.cancelled === true;
		const failed = cancelled || message.isError === true;
		return [
			{
				id,
				kind: "bash",
				text: bashText(output, false),
				thinking: "",
				bash: {
					command: textOf(message.command),
					status: failed ? "error" : "done",
					exitCode: typeof message.exitCode === "number" ? message.exitCode : null,
					...(cancelled ? { cancelled: true } : {}),
				},
				createdAt,
			},
		];
	}
	return [];
}

function summaryItems(entry: Rec): TranscriptItem[] {
	if (entry.type !== "compaction" && entry.type !== "branch_summary") return [];
	const summary = textOf(entry.summary);
	if (summary === "") return [];
	return [{ id: entry.id as string, kind: "notice", text: summary.slice(0, NOTICE_LIMIT), thinking: "", createdAt: stampOf(entry) }];
}

function statusOf(chain: Rec[]): StatusView {
	// The file cannot answer settledness, dialogs or a queue: it holds what omp persisted.
	const status: StatusView = { status: "idle", isSettled: true, hasPendingAsyncWork: false, todos: [], goal: null };
	for (const entry of chain) {
		if (entry.type === "thinking_level_change") {
			status.thinkingLevel = typeof entry.thinkingLevel === "string" ? entry.thinkingLevel : null;
			continue;
		}
		const message = isRec(entry.message) ? entry.message : null;
		if (message === null || message.role !== "assistant") continue;
		if (typeof message.model === "string" && message.model !== "") {
			status.model = { provider: textOf(message.provider), id: message.model, name: message.model };
		}
	}
	return status;
}

/** The transcript the file holds: the chain of its last entry, with tool results folded into their call. */
export function buildTranscript(entries: unknown[], options: { itemLimit?: number; truncated?: boolean } = {}): BuiltTranscript {
	const itemLimit = options.itemLimit ?? SNAPSHOT_ITEM_LIMIT;
	const chain = chainOf(entries);
	const boundary = chain.findLastIndex((entry) => entry.type === "reset_boundary");
	const visible = boundary < 0 ? chain : chain.slice(boundary + 1);
	const results = toolResultsOf(visible);
	const items: TranscriptItem[] = [];
	for (const entry of visible) {
		if (entry.type === "message") items.push(...messageItems(entry, results));
		else items.push(...summaryItems(entry));
	}
	const cut = Math.max(0, items.length - itemLimit);
	return {
		items: items.slice(cut),
		truncated: options.truncated === true || cut > 0,
		status: statusOf(visible),
	};
}
