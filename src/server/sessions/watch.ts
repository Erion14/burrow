// Following one session file as another omp process writes it. The watcher holds
// the parsed entries in memory, rebuilds the transcript from the entry tree, and
// reports only what changed since the last poll, so the manager can push it to a
// phone. It never writes, and never holds more than a bounded slice of a file.

import type { StatusView, TranscriptItem } from "../../shared/types";
import { type TailRead, type TailState, buildTranscript, readTail } from "./session-tail";

/** What a poll found: appends, one item that changed in place, or a rebuild. */
export type WatchUpdate =
	| { kind: "items"; added: TranscriptItem[] }
	| { kind: "update"; item: TranscriptItem }
	| { kind: "reset" };

export interface Watcher {
	/** Reads what the file gained and says what the phone should hear. */
	poll(): Promise<WatchUpdate[]>;
	items(): TranscriptItem[];
	truncated(): boolean;
	status(): StatusView;
}

export interface WatcherOptions {
	file: string;
	/** How much of an already existing file the first read takes, counted from its end. */
	windowBytes?: number;
}

/** Older entries than this are dropped: the item cap already hides them from the phone. */
const ENTRY_LIMIT = 2000;

function sameItem(left: TranscriptItem, right: TranscriptItem): boolean {
	return (
		left.text === right.text &&
		left.thinking === right.thinking &&
		left.tool?.status === right.tool?.status &&
		left.tool?.output === right.tool?.output &&
		left.bash?.status === right.bash?.status &&
		left.bash?.exitCode === right.bash?.exitCode &&
		left.bash?.cancelled === right.bash?.cancelled
	);
}

export async function createWatcher(options: WatcherOptions): Promise<Watcher> {
	let state: TailState = { offset: 0, ino: null, mtimeMs: 0, truncated: false };
	let entries: unknown[] = [];
	let current = buildTranscript(entries);
	let sent: TranscriptItem[] = [];

	const absorb = (read: TailRead): WatchUpdate[] => {
		const hadItems = sent.length > 0;
		state = read.state;
		entries = read.reset ? read.entries : [...entries, ...read.entries];
		if (entries.length > ENTRY_LIMIT) entries = entries.slice(entries.length - ENTRY_LIMIT);
		const next = buildTranscript(entries, { truncated: state.truncated });
		const aligned = next.items.length >= sent.length && sent.every((item, index) => next.items[index]?.id === item.id);
		const updates: WatchUpdate[] = [];
		if (!hadItems) {
			// Nothing has been sent yet: the caller's own snapshot is the first word.
		} else if (read.reset || !aligned) {
			updates.push({ kind: "reset" });
		} else {
			for (const [index, item] of sent.entries()) {
				const rebuilt = next.items[index];
				if (rebuilt !== undefined && !sameItem(item, rebuilt)) updates.push({ kind: "update", item: rebuilt });
			}
			const added = next.items.slice(sent.length);
			if (added.length > 0) updates.push({ kind: "items", added });
		}
		current = next;
		sent = next.items;
		return updates;
	};

	absorb(await readTail(options.file, state, { windowBytes: options.windowBytes }));

	return {
		async poll() {
			const read = await readTail(options.file, state, { windowBytes: options.windowBytes });
			if (read.reset) return absorb(read);
			const noBytes = read.state.offset === state.offset;
			return noBytes ? [] : absorb(read);
		},
		items: () =>
			current.items.map((item) => ({
				...item,
				...(item.tool === undefined ? {} : { tool: { ...item.tool } }),
				...(item.bash === undefined ? {} : { bash: { ...item.bash } }),
			})),
		truncated: () => current.truncated,
		status: () => current.status,
	};
}
