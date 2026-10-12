import { describe, expect, test } from "bun:test";
import { createTranscript } from "./transcript";

const fixed = () => new Date("2026-10-12T10:00:00Z");

describe("messages", () => {
	test("full lifecycle yields one item and deltas concatenate to the final text", () => {
		const t = createTranscript({ now: fixed });
		const out = [
			...t.handle({ type: "message_start", messageId: "m1", message: { role: "assistant", content: [] } }),
			...t.handle({ type: "message_update", messageId: "m1", message: { role: "assistant" }, assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "hmm" } }),
			...t.handle({ type: "message_update", messageId: "m1", message: { role: "assistant" }, assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "Hel" } }),
			...t.handle({ type: "message_update", messageId: "m1", message: { role: "assistant" }, assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "lo" } }),
			...t.handle({ type: "message_update", messageId: "m1", assistantMessageEvent: { type: "text_end", contentIndex: 1, content: "Hello world" } }),
			...t.handle({
				type: "message_end",
				messageId: "m1",
				message: { role: "assistant", content: [{ type: "thinking", thinking: "hmm" }, { type: "text", text: "Hello world" }] },
			}),
		];
		expect(out.filter((m) => m.type === "item")).toHaveLength(1);
		const deltas = out.filter((m) => m.type === "delta") as Array<{ text: string; thinking: string }>;
		expect(deltas.map((d) => d.text).join("")).toBe("Hello world");
		expect(deltas.map((d) => d.thinking).join("")).toBe("hmm");
		const last = out[out.length - 1];
		expect(last?.type).toBe("item_update");
		const snap = t.snapshot();
		expect(snap.items).toHaveLength(1);
		expect(snap.items[0]).toMatchObject({ id: "m1", kind: "assistant", text: "Hello world", thinking: "hmm" });
		expect(snap.truncated).toBe(false);
	});

	test("user message with string content", () => {
		const t = createTranscript({ now: fixed });
		const out = t.handle({ type: "message_start", messageId: "u1", message: { role: "user", content: "hi" } });
		expect(out).toHaveLength(1);
		expect(t.snapshot().items[0]).toMatchObject({ kind: "user", text: "hi" });
	});

	test("update for unknown id and frames without id change nothing", () => {
		const t = createTranscript();
		expect(t.handle({ type: "message_update", messageId: "ghost", assistantMessageEvent: { type: "text_delta", delta: "x" } })).toEqual([]);
		expect(t.handle({ type: "message_start", message: { role: "assistant" } })).toEqual([]);
		expect(t.snapshot().items).toEqual([]);
	});

	test("block end that disagrees with streamed text resends the item", () => {
		const t = createTranscript();
		t.handle({ type: "message_start", messageId: "m", message: { role: "assistant" } });
		t.handle({ type: "message_update", messageId: "m", assistantMessageEvent: { type: "text_delta", delta: "abc" } });
		const out = t.handle({ type: "message_update", messageId: "m", assistantMessageEvent: { type: "text_end", content: "xyz" } });
		expect(out[0]?.type).toBe("item_update");
		expect(t.snapshot().items[0]?.text).toBe("xyz");
	});

	test("unknown frames produce nothing", () => {
		const t = createTranscript();
		expect(t.handle({ type: "turn_start" })).toEqual([]);
		expect(t.handle({ type: "who_knows", x: 1 })).toEqual([]);
	});
});

describe("tools", () => {
	test("card runs then completes with bounded output", () => {
		const t = createTranscript({ now: fixed });
		const start = t.handle({ type: "tool_execution_start", toolCallId: "c1", toolName: "bash", args: { command: "ls" }, timestamp: 1000 });
		expect(start[0]?.type).toBe("item");
		expect(t.snapshot().items[0]?.tool).toMatchObject({ id: "c1", name: "bash", args: '{"command":"ls"}', status: "running" });
		t.handle({ type: "tool_execution_update", toolCallId: "c1", partialResult: { content: [{ type: "text", text: "part" }] } });
		expect(t.snapshot().items[0]?.tool?.output).toBe("part");
		const big = "x".repeat(10000);
		const end = t.handle({ type: "tool_execution_end", toolCallId: "c1", result: big, isError: false, timestamp: 1500 });
		expect(end[0]?.type).toBe("item_update");
		const snap = t.snapshot();
		expect(snap.items).toHaveLength(1);
		expect(snap.items[0]?.tool?.status).toBe("done");
		expect(snap.items[0]?.tool?.output).toHaveLength(4000);
		expect(snap.items[0]?.tool?.durationMs).toBe(500);
	});

	test("failed call ends in error", () => {
		const t = createTranscript();
		t.handle({ type: "tool_execution_start", toolCallId: "c2", toolName: "read", args: {} });
		t.handle({ type: "tool_execution_end", toolCallId: "c2", result: "boom", isError: true });
		expect(t.snapshot().items[0]?.tool?.status).toBe("error");
	});

	test("long args are one line and truncated", () => {
		const t = createTranscript();
		t.handle({ type: "tool_execution_start", toolCallId: "c3", toolName: "edit", args: { text: "a\nb".repeat(200) } });
		const args = t.snapshot().items[0]?.tool?.args ?? "";
		expect(args.includes("\n")).toBe(false);
		expect(args.length).toBeLessThanOrEqual(120);
	});

	test("update for unknown call changes nothing", () => {
		const t = createTranscript();
		expect(t.handle({ type: "tool_execution_update", toolCallId: "nope", partialResult: "x" })).toEqual([]);
	});
});

describe("tool-only turns and tool results", () => {
	const upd = (messageId: string, assistantMessageEvent: unknown) => ({ type: "message_update", messageId, message: { role: "assistant" }, assistantMessageEvent });

	test("tool-only assistant turn makes no item; the following text turn does, announced before its deltas", () => {
		const t = createTranscript({ now: fixed });
		const call = { type: "toolCall", id: "call-1", name: "bash", arguments: { command: "ls" } };
		const out = [
			...t.handle({ type: "message_start", messageId: "msg-1", message: { role: "assistant", content: [call] } }),
			...t.handle(upd("msg-1", { type: "toolcall_start", contentIndex: 0 })),
			...t.handle(upd("msg-1", { type: "toolcall_delta", contentIndex: 0, delta: '{"command": "ls' })),
			...t.handle(upd("msg-1", { type: "toolcall_end", contentIndex: 0 })),
			...t.handle({ type: "message_end", messageId: "msg-1", message: { role: "assistant", content: [call] } }),
			...t.handle({ type: "tool_execution_start", toolCallId: "call-1", toolName: "bash", args: { command: "ls" } }),
			...t.handle({ type: "tool_execution_end", toolCallId: "call-1", toolName: "bash", result: { content: [{ type: "text", text: "a.txt" }] } }),
			...t.handle({ type: "message_start", messageId: "msg-tr", message: { role: "toolResult", toolCallId: "call-1", toolName: "bash", content: [{ type: "text", text: "a.txt" }] } }),
			...t.handle({ type: "message_end", messageId: "msg-tr", message: { role: "toolResult", toolCallId: "call-1", toolName: "bash", content: [{ type: "text", text: "a.txt" }] } }),
			...t.handle({ type: "message_start", messageId: "msg-2", message: { role: "assistant", content: [] } }),
			...t.handle(upd("msg-2", { type: "text_start", contentIndex: 0 })),
			...t.handle(upd("msg-2", { type: "text_delta", contentIndex: 0, delta: "Done." })),
			...t.handle(upd("msg-2", { type: "text_end", contentIndex: 0, content: "Done." })),
			...t.handle({ type: "message_end", messageId: "msg-2", message: { role: "assistant", content: [{ type: "text", text: "Done." }] } }),
		];
		const items = t.snapshot().items;
		expect(items).toHaveLength(2);
		expect(items[0]?.tool).toMatchObject({ name: "bash", output: "a.txt" });
		expect(items[1]).toMatchObject({ id: "msg-2", kind: "assistant", text: "Done." });
		expect(items.some((i) => i.kind !== "tool" && i.text === "" && i.thinking === "")).toBe(false);
		const itemAt = out.findIndex((m) => m.type === "item" && m.item.id === "msg-2");
		const firstDelta = out.findIndex((m) => m.type === "delta" && m.itemId === "msg-2");
		expect(itemAt).toBeGreaterThanOrEqual(0);
		expect(firstDelta).toBeGreaterThan(itemAt);
		expect(out.some((m) => (m.type === "item" || m.type === "item_update") && m.item.id === "msg-1")).toBe(false);
	});

	const call = { type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls" } };
	const result = (isError?: boolean) => ({ role: "toolResult", toolCallId: "c1", toolName: "bash", isError, content: [{ type: "text", text: "a.txt" }] });

	test("stored sequence yields one tool card and one assistant item, the card emitted once", () => {
		const t = createTranscript({ now: fixed });
		const out = [
			...t.handle({ type: "message_end", messageId: "a1", message: { role: "assistant", content: [call] } }),
			...t.handle({ type: "message_start", messageId: "tr", message: result() }),
			...t.handle({ type: "message_end", messageId: "tr", message: result() }),
			...t.handle({ type: "message_end", messageId: "a2", message: { role: "assistant", content: [{ type: "text", text: "Done." }] } }),
		];
		const items = t.snapshot().items;
		expect(items).toHaveLength(2);
		expect(items[0]?.tool).toMatchObject({ id: "c1", name: "bash", args: '{"command":"ls"}', output: "a.txt", status: "done" });
		expect(items[1]).toMatchObject({ kind: "assistant", text: "Done." });
		expect(out.filter((m) => m.type === "item" && m.item.kind === "tool")).toHaveLength(1);
		expect(out.filter((m) => m.type === "item_update")).toHaveLength(0);
	});

	test("an error tool result gives an error card", () => {
		const t = createTranscript({ now: fixed });
		t.handle({ type: "message_end", messageId: "tr", message: result(true) });
		expect(t.snapshot().items[0]?.tool?.status).toBe("error");
	});

	test("live sequence keeps exactly one card with the tool output", () => {
		const t = createTranscript({ now: fixed });
		const out = [
			...t.handle({ type: "message_end", messageId: "a1", message: { role: "assistant", content: [call] } }),
			...t.handle({ type: "tool_execution_start", toolCallId: "c1", toolName: "bash", args: { command: "ls" } }),
			...t.handle({ type: "tool_execution_update", toolCallId: "c1", partialResult: "a.t" }),
			...t.handle({ type: "tool_execution_end", toolCallId: "c1", toolName: "bash", result: { content: [{ type: "text", text: "a.txt" }] } }),
			...t.handle({ type: "message_start", messageId: "tr", message: result() }),
			...t.handle({ type: "message_end", messageId: "tr", message: result() }),
		];
		const items = t.snapshot().items;
		expect(items).toHaveLength(1);
		expect(items[0]?.tool).toMatchObject({ output: "a.txt", status: "done" });
		expect(out.filter((m) => m.type === "item")).toHaveLength(1);
	});
});

describe("subagents and notices", () => {
	test("subagent frames update the list", () => {
		const t = createTranscript();
		const a = t.handle({ type: "subagent_lifecycle", subagentId: "OmpWorker", status: "running" });
		expect(a).toEqual([{ type: "subagents", subagents: [{ id: "OmpWorker", label: "OmpWorker", status: "running", detail: "" }] }]);
		t.handle({ type: "subagent_progress", subagentId: "OmpWorker", message: "reading\nfiles" });
		const done = t.handle({ type: "subagent_lifecycle", subagentId: "OmpWorker", status: "completed" });
		expect(done[0]).toMatchObject({ type: "subagents", subagents: [{ status: "completed", detail: "reading files" }] });
		expect(t.handle({ type: "subagent_lifecycle", subagentId: "OmpWorker", status: "completed" })).toEqual([]);
		expect(t.snapshot().subagents).toHaveLength(1);
	});

	test("notice frames and appendNotice add notice items", () => {
		const t = createTranscript({ now: fixed });
		const n = t.handle({ type: "notice", level: "error", message: "disk full", source: "session-persistence" });
		expect(n[0]).toMatchObject({ type: "item", item: { kind: "notice", text: "disk full" } });
		const m = t.appendNotice("server says hi");
		expect(m).toMatchObject({ type: "item", item: { kind: "notice", text: "server says hi" } });
		expect(t.snapshot().items).toHaveLength(2);
	});
});

describe("snapshot bounds", () => {
	test("keeps the last 500 items and reports truncation", () => {
		const t = createTranscript();
		for (let i = 0; i < 503; i++) t.appendNotice(`n${i}`);
		const snap = t.snapshot();
		expect(snap.items).toHaveLength(500);
		expect(snap.items[0]?.text).toBe("n3");
		expect(snap.truncated).toBe(true);
	});
});
