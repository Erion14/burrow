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
