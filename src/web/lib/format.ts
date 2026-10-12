import type { ToolCard } from "../../shared/types";

export function relativeTime(iso: string, now: number = Date.now()): string {
	const then = Date.parse(iso);
	if (Number.isNaN(then)) return "";
	const seconds = Math.max(0, Math.floor((now - then) / 1000));
	if (seconds < 60) return "just now";
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	return `${Math.floor(hours / 24)}d ago`;
}

/** The server strips the file header, so a leading "---" is a deleted line starting with "--". */
export function diffLineClass(line: string): string {
	if (line.startsWith("@@")) return "diff-hunk";
	if (line.startsWith("+")) return "diff-add";
	if (line.startsWith("-")) return "diff-del";
	return "diff-ctx";
}

/** Slack so a fractional scroll position or a half-visible last line still counts as "at the bottom". */
const BOTTOM_SLACK_PX = 80;

export function isNearBottom(box: { scrollHeight: number; scrollTop: number; clientHeight: number }): boolean {
	return box.scrollHeight - box.scrollTop - box.clientHeight <= BOTTOM_SLACK_PX;
}

export function toolStatusLabel(status: ToolCard["status"]): string {
	return status === "error" ? "failed" : status;
}

/** Seconds with one decimal under a minute, whole minutes and seconds above: the way omp prints tool timings. */
export function toolDuration(ms: number | undefined): string {
	if (ms === undefined || !Number.isFinite(ms) || ms < 0) return "";
	if (ms < 1000) return `${Math.round(ms)}ms`;
	const seconds = ms / 1000;
	if (seconds < 60) return `${seconds.toFixed(1)}s`;
	const whole = Math.round(seconds);
	return `${Math.floor(whole / 60)}m${String(whole % 60).padStart(2, "0")}s`;
}

export type Tone = "running" | "done" | "error" | "other";

/** Subagent status is a free string from omp ("running", "completed", "failed", "aborted"); only its tone matters for the glyph. */
export function subagentTone(status: string): Tone {
	const s = status.toLowerCase();
	if (/run|work|start|progress|pending/.test(s)) return "running";
	if (/fail|error|abort|cancel|kill/.test(s)) return "error";
	if (/done|complete|success|finish|ok/.test(s)) return "done";
	return "other";
}

export type MdBlock =
	| { kind: "para"; text: string }
	| { kind: "heading"; level: number; text: string }
	| { kind: "item"; marker: string; indent: number; text: string }
	| { kind: "quote"; text: string }
	| { kind: "code"; lang: string; text: string }
	| { kind: "hr" };

const FENCE = /^\s*(```|~~~)\s*([\w+-]*)/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const RULE = /^\s*([-*_])(\s*\1){2,}\s*$/;
const ITEM = /^(\s*)([-*+]|\d{1,3}[.)])\s+(.*)$/;
const QUOTE = /^\s*>\s?(.*)$/;

/**
 * Line level markdown, enough to give assistant text omp's spacing and colours.
 * Never builds HTML: the caller renders blocks as elements, so agent text cannot inject markup.
 * An unclosed fence (text still streaming) runs to the end.
 */
export function markdownBlocks(source: string): MdBlock[] {
	const blocks: MdBlock[] = [];
	const lines = source.split("\n");
	let para: string[] = [];
	const flush = () => {
		if (para.length > 0) blocks.push({ kind: "para", text: para.join("\n") });
		para = [];
	};
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;
		const fence = FENCE.exec(line);
		if (fence) {
			flush();
			const body: string[] = [];
			i++;
			while (i < lines.length && !lines[i]!.trimStart().startsWith(fence[1]!)) body.push(lines[i++]!);
			blocks.push({ kind: "code", lang: fence[2] ?? "", text: body.join("\n") });
			continue;
		}
		if (line.trim() === "") {
			flush();
			continue;
		}
		const heading = HEADING.exec(line);
		if (heading) {
			flush();
			blocks.push({ kind: "heading", level: heading[1]!.length, text: heading[2]! });
			continue;
		}
		if (RULE.test(line)) {
			flush();
			blocks.push({ kind: "hr" });
			continue;
		}
		const item = ITEM.exec(line);
		if (item) {
			flush();
			const marker = /\d/.test(item[2]!) ? item[2]! : "•";
			blocks.push({ kind: "item", marker, indent: Math.min(3, Math.floor(item[1]!.length / 2)), text: item[3]! });
			continue;
		}
		const quote = QUOTE.exec(line);
		if (quote) {
			flush();
			const last = blocks[blocks.length - 1];
			if (last?.kind === "quote") last.text += `\n${quote[1]!}`;
			else blocks.push({ kind: "quote", text: quote[1]! });
			continue;
		}
		para.push(line);
	}
	flush();
	return blocks;
}

export type InlineSpan = { kind: "text" | "code" | "bold"; text: string };

const INLINE = /`([^`\n]+)`|\*\*([^*\n]+)\*\*/g;

export function inlineSpans(text: string): InlineSpan[] {
	const spans: InlineSpan[] = [];
	let at = 0;
	for (const match of text.matchAll(INLINE)) {
		const index = match.index ?? 0;
		if (index > at) spans.push({ kind: "text", text: text.slice(at, index) });
		spans.push(match[1] !== undefined ? { kind: "code", text: match[1] } : { kind: "bold", text: match[2]! });
		at = index + match[0].length;
	}
	if (at < text.length) spans.push({ kind: "text", text: text.slice(at) });
	return spans;
}
