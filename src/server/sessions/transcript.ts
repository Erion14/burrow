// Turns omp session events into transcript items and the wire messages that
// keep the phone's copy in step. Pure: frames in, messages out.
//
// Field names for tool and subagent frames are not fully documented in rpc.md.
// They are read defensively (documented name first, then likely variants) so
// the manual smoke against real omp can settle them.

import type { ServerMessage } from "../../shared/protocol";
import type { SubagentView, ToolCard, TranscriptItem } from "../../shared/types";
import type { OmpEvent } from "../omp/port";

export const SNAPSHOT_ITEM_LIMIT = 500;
const STORE_ITEM_LIMIT = 2000;
const TOOL_OUTPUT_LIMIT = 4000;
const TOOL_ARGS_LIMIT = 120;
const DETAIL_LIMIT = 160;

export interface Transcript {
	handle(event: OmpEvent): ServerMessage[];
	snapshot(): { items: TranscriptItem[]; subagents: SubagentView[]; truncated: boolean };
	appendNotice(text: string): ServerMessage;
}

type Rec = Record<string, unknown>;

function isRec(value: unknown): value is Rec {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function firstString(rec: Rec, keys: string[]): string | undefined {
	for (const key of keys) {
		const value = rec[key];
		if (typeof value === "string" && value !== "") return value;
	}
	return undefined;
}

/** Text and thinking carried by a message: string content, or text/thinking blocks. */
export function extractParts(message: unknown): { text: string; thinking: string } | null {
	if (!isRec(message)) return null;
	const content = message.content;
	if (typeof content === "string") return { text: content, thinking: "" };
	if (!Array.isArray(content)) return null;
	let text = "";
	let thinking = "";
	for (const block of content) {
		if (!isRec(block)) continue;
		if (block.type === "text" && typeof block.text === "string") text += block.text;
		else if (block.type === "thinking" && typeof block.thinking === "string") thinking += block.thinking;
	}
	return { text, thinking };
}

function oneLine(text: string, limit: number): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
}

function tail(text: string): string {
	return text.length > TOOL_OUTPUT_LIMIT ? text.slice(text.length - TOOL_OUTPUT_LIMIT) : text;
}

function summariseArgs(args: unknown): string {
	if (args === undefined || args === null) return "";
	if (typeof args === "string") return oneLine(args, TOOL_ARGS_LIMIT);
	try {
		return oneLine(JSON.stringify(args) ?? "", TOOL_ARGS_LIMIT);
	} catch {
		return "";
	}
}

/** Tool output as text: a string, text blocks (directly or under `content`), or JSON. */
function outputText(value: unknown): string | null {
	if (value === undefined || value === null) return null;
	if (typeof value === "string") return value;
	if (Array.isArray(value)) {
		return value
			.map((block) => (isRec(block) && typeof block.text === "string" ? block.text : typeof block === "string" ? block : ""))
			.join("");
	}
	if (isRec(value)) {
		if (Array.isArray(value.content) || typeof value.content === "string") return outputText(value.content);
		if (typeof value.text === "string") return value.text;
		if (typeof value.output === "string") return value.output;
	}
	try {
		return JSON.stringify(value) ?? null;
	} catch {
		return null;
	}
}

function toMillis(value: unknown): number | null {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string") {
		const parsed = Date.parse(value);
		return Number.isNaN(parsed) ? null : parsed;
	}
	return null;
}

export function createTranscript(options: { now?: () => Date } = {}): Transcript {
	const now = options.now ?? (() => new Date());
	const items: TranscriptItem[] = [];
	const byId = new Map<string, TranscriptItem>();
	const blocks = new Map<string, { text: Map<number, string>; thinking: Map<number, string> }>();
	const toolStarts = new Map<string, number | null>();
	const pendingAssistant = new Set<string>();
	const toolCalls = new Map<string, { name: string; args: string }>();
	const subagents = new Map<string, SubagentView>();
	let dropped = false;
	let noticeCount = 0;

	function add(item: TranscriptItem): ServerMessage {
		items.push(item);
		byId.set(item.id, item);
		if (items.length > STORE_ITEM_LIMIT) {
			const gone = items.shift();
			if (gone) {
				byId.delete(gone.id);
				blocks.delete(gone.id);
			}
			dropped = true;
		}
		return { type: "item", item: { ...item } };
	}

	function copyOf(item: TranscriptItem): TranscriptItem {
		return item.tool ? { ...item, tool: { ...item.tool } } : { ...item };
	}

	function handleMessage(event: OmpEvent): ServerMessage[] {
		const id = event.messageId;
		if (typeof id !== "string" || id === "") return [];
		const message = event.message;
		const role = isRec(message) ? message.role : undefined;
		const existing = byId.get(id);

		if (event.type === "message_update") {
			if (existing) return applyDelta(existing, event.assistantMessageEvent);
			if (!pendingAssistant.has(id)) return [];
			// No item yet: the message carried no text at start (tool-only turns never get one).
			// Create it on the first text or thinking delta, announcing it before that delta.
			const draft: TranscriptItem = { id, kind: "assistant", text: "", thinking: "", createdAt: now().toISOString() };
			const out = applyDelta(draft, event.assistantMessageEvent);
			if (out.length === 0) return [];
			pendingAssistant.delete(id);
			const added = add(draft);
			if (out[0]?.type === "delta") return [{ type: "item", item: { ...draft, text: "", thinking: "" } }, ...out];
			return [added];
		}

		// A toolResult message becomes (or completes) the tool card. Live, tool_execution_* already
		// built the card and this is a no-op; when resuming from stored messages it is the only source.
		if (role === "toolResult") return handleToolResult(message);
		rememberToolCalls(message);

		const parts = extractParts(message);
		if (!existing) {
			if (role !== "user" && role !== "assistant") return [];
			// A message with neither text nor thinking (e.g. only tool calls) gets no item. At
			// message_start an assistant message may still gain text through deltas; remember it.
			if (!parts || (parts.text === "" && parts.thinking === "")) {
				if (role === "assistant" && event.type === "message_start") pendingAssistant.add(id);
				else pendingAssistant.delete(id);
				return [];
			}
			pendingAssistant.delete(id);
			const item: TranscriptItem = {
				id,
				kind: role,
				text: parts.text,
				thinking: parts.thinking,
				createdAt: now().toISOString(),
			};
			return [add(item)];
		}
		if (event.type === "message_start") return [];
		// message_end carries the full message; it replaces whatever the deltas built.
		if (parts) {
			existing.text = parts.text;
			existing.thinking = parts.thinking;
		}
		blocks.delete(id);
		return [{ type: "item_update", item: copyOf(existing) }];
	}

	function rememberToolCalls(message: unknown): void {
		if (!isRec(message) || message.role !== "assistant" || !Array.isArray(message.content)) return;
		for (const block of message.content) {
			if (!isRec(block) || block.type !== "toolCall" || typeof block.id !== "string") continue;
			toolCalls.set(block.id, { name: typeof block.name === "string" ? block.name : "tool", args: summariseArgs(block.arguments) });
		}
	}

	function handleToolResult(message: unknown): ServerMessage[] {
		if (!isRec(message) || typeof message.toolCallId !== "string" || message.toolCallId === "") return [];
		const callId = message.toolCallId;
		const output = tail(outputText(message.content) ?? "");
		const status = message.isError === true ? "error" : "done";
		const itemId = `tool:${callId}`;
		const existing = byId.get(itemId);
		if (existing?.tool) {
			// A card that tool_execution_end already finished is authoritative.
			if (existing.tool.status !== "running") return [];
			existing.tool.output = output;
			existing.tool.status = status;
			return [{ type: "item_update", item: copyOf(existing) }];
		}
		const call = toolCalls.get(callId);
		toolCalls.delete(callId);
		const card: ToolCard = {
			id: callId,
			name: typeof message.toolName === "string" && message.toolName !== "" ? message.toolName : (call?.name ?? "tool"),
			args: call?.args ?? "",
			output,
			status,
		};
		return [add({ id: itemId, kind: "tool", text: "", thinking: "", tool: card, createdAt: now().toISOString() })];
	}

	function applyDelta(item: TranscriptItem, raw: unknown): ServerMessage[] {
		if (!isRec(raw) || typeof raw.type !== "string") return [];
		const kind = raw.type;
		const isText = kind === "text_delta" || kind === "text_end";
		const isThinking = kind === "thinking_delta" || kind === "thinking_end";
		if (!isText && !isThinking) return [];
		const index = typeof raw.contentIndex === "number" ? raw.contentIndex : 0;
		let acc = blocks.get(item.id);
		if (!acc) {
			acc = { text: new Map(), thinking: new Map() };
			blocks.set(item.id, acc);
		}
		const map = isText ? acc.text : acc.thinking;
		const before = map.get(index) ?? "";
		let piece = "";
		if (kind.endsWith("_delta")) {
			piece = typeof raw.delta === "string" ? raw.delta : "";
			map.set(index, before + piece);
		} else {
			const content = typeof raw.content === "string" ? raw.content : null;
			if (content === null) return [];
			map.set(index, content);
			if (content.startsWith(before)) {
				piece = content.slice(before.length);
			} else {
				// The block end disagrees with what streamed; rebuild the item and resend it whole.
				const joined = [...map.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v).join("");
				if (isText) item.text = joined;
				else item.thinking = joined;
				return [{ type: "item_update", item: copyOf(item) }];
			}
		}
		if (piece === "") return [];
		if (isText) item.text += piece;
		else item.thinking += piece;
		return [{ type: "delta", itemId: item.id, text: isText ? piece : "", thinking: isThinking ? piece : "" }];
	}

	function handleTool(event: OmpEvent): ServerMessage[] {
		const callId = firstString(event, ["toolCallId", "callId", "id"]);
		if (!callId) return [];
		const itemId = `tool:${callId}`;
		const existing = byId.get(itemId);
		const stamp = toMillis(event.timestamp);
		const result = event.type === "tool_execution_update" ? (event.partialResult ?? event.output ?? event.result) : (event.result ?? event.output ?? event.partialResult);

		if (event.type === "tool_execution_start") {
			if (existing) return [];
			toolStarts.set(callId, stamp);
			const card: ToolCard = {
				id: callId,
				name: firstString(event, ["toolName", "name"]) ?? "tool",
				args: summariseArgs(event.args ?? event.arguments ?? event.input),
				output: "",
				status: "running",
			};
			return [add({ id: itemId, kind: "tool", text: "", thinking: "", tool: card, createdAt: now().toISOString() })];
		}

		if (event.type === "tool_execution_update") {
			if (!existing?.tool) return [];
			const text = outputText(result);
			if (text === null) return [];
			existing.tool.output = tail(text);
			return [{ type: "item_update", item: copyOf(existing) }];
		}

		// tool_execution_end
		let item = existing;
		const created: ServerMessage[] = [];
		if (!item) {
			const card: ToolCard = {
				id: callId,
				name: firstString(event, ["toolName", "name"]) ?? "tool",
				args: summariseArgs(event.args ?? event.arguments ?? event.input),
				output: "",
				status: "running",
			};
			const made: TranscriptItem = { id: itemId, kind: "tool", text: "", thinking: "", tool: card, createdAt: now().toISOString() };
			created.push(add(made));
			item = made;
		}
		const card = item.tool;
		if (!card) return created;
		const text = outputText(result);
		if (text !== null) card.output = tail(text);
		card.status = event.isError === true || event.error !== undefined && event.error !== null && event.error !== false ? "error" : "done";
		const started = toolStarts.get(callId);
		toolStarts.delete(callId);
		if (typeof started === "number" && stamp !== null && stamp >= started) card.durationMs = stamp - started;
		else if (typeof event.durationMs === "number") card.durationMs = event.durationMs;
		return [...created, { type: "item_update", item: copyOf(item) }];
	}

	function handleSubagent(event: OmpEvent): ServerMessage[] {
		const id = firstString(event, ["subagentId", "agentId", "id", "name", "agent"]);
		if (!id) return [];
		const prev = subagents.get(id);
		const progress = isRec(event.progress) ? event.progress : {};
		const detailSource =
			firstString(event, ["detail", "currentTool", "lastTool", "message", "task", "description"]) ??
			firstString(progress, ["currentTool", "lastTool", "message", "status"]);
		const next: SubagentView = {
			id,
			label: firstString(event, ["label", "agent", "name", "agentName"]) ?? prev?.label ?? id,
			status: firstString(event, ["status", "state"]) ?? prev?.status ?? "running",
			detail: detailSource ? oneLine(detailSource, DETAIL_LIMIT) : (prev?.detail ?? ""),
		};
		if (prev && prev.label === next.label && prev.status === next.status && prev.detail === next.detail) return [];
		subagents.set(id, next);
		return [{ type: "subagents", subagents: [...subagents.values()].map((s) => ({ ...s })) }];
	}

	function handleNotice(event: OmpEvent): ServerMessage[] {
		const text = firstString(event, ["message", "text"]);
		if (!text) return [];
		return [addNotice(text)];
	}

	function addNotice(text: string): ServerMessage {
		noticeCount += 1;
		return add({ id: `notice:${noticeCount}`, kind: "notice", text, thinking: "", createdAt: now().toISOString() });
	}

	return {
		handle(event) {
			switch (event.type) {
				case "message_start":
				case "message_update":
				case "message_end":
					return handleMessage(event);
				case "tool_execution_start":
				case "tool_execution_update":
				case "tool_execution_end":
					return handleTool(event);
				case "subagent_lifecycle":
				case "subagent_progress":
					return handleSubagent(event);
				case "notice":
					return handleNotice(event);
				default:
					return [];
			}
		},
		snapshot() {
			const start = Math.max(0, items.length - SNAPSHOT_ITEM_LIMIT);
			return {
				items: items.slice(start).map(copyOf),
				subagents: [...subagents.values()].map((s) => ({ ...s })),
				truncated: dropped || start > 0,
			};
		},
		appendNotice: addNotice,
	};
}
