import type { SessionStatus } from "../../shared/types";
import type { ConnectionState } from "../lib/app-state";
import type { Tone } from "../lib/format";
import type { SymbolKey } from "../lib/symbols";
import { Symbol } from "./symbol";

export const STATUS_LABELS: Record<SessionStatus, string> = {
	working: "working",
	needs_answer: "needs answer",
	idle: "idle",
	stopped: "stopped",
};

const STATUS_SYMBOL: Record<SessionStatus, SymbolKey> = {
	working: "status.working",
	needs_answer: "status.needs_answer",
	idle: "status.idle",
	stopped: "status.stopped",
};

/** The mark on its own, announced: a session row and the first segment of a status line. */
export function StatusGlyph({ status }: { status: SessionStatus }) {
	return <Symbol k={STATUS_SYMBOL[status]} class={`glyph-${status}`} label={STATUS_LABELS[status]} />;
}

/** The same mark where the word beside it already says the state, so it stays out of the tree. */
export function StatusMark({ status }: { status: SessionStatus }) {
	return <Symbol k={STATUS_SYMBOL[status]} class={`glyph-${status}`} />;
}

/** Glyph plus word, coloured by state: the first segment of every status line. */
export function StatusWord({ status }: { status: SessionStatus }) {
	return (
		<span class={`state state-${status}`}>
			<StatusMark status={status} />
			{STATUS_LABELS[status]}
		</span>
	);
}

const TONE_SYMBOL: Record<Tone, SymbolKey> = {
	running: "status.working",
	done: "status.done",
	error: "status.error",
	other: "status.stopped", // an unmatched agent state is the open circle, not a claim about what happened
};

/** The outcome mark on a tool card and on an agent row; "running" keeps the CSS braille spin. */
export function ToneMark({ tone, label }: { tone: Tone; label?: string }) {
	return <Symbol k={TONE_SYMBOL[tone]} class={`tone-${tone}`} label={label} />;
}

const CONN_LABELS: Record<ConnectionState, string> = {
	open: "live",
	connecting: "connecting",
	closed: "offline",
};

const CONN_SYMBOL: Record<ConnectionState, SymbolKey> = {
	open: "ui.pulse",
	connecting: "ui.clock",
	closed: "ui.close",
};

/** The link to the host, as the last segment of a status line. The word carries the state, so the
 * mark stays out of the tree and only the title says what it is. */
export function ConnMark({ connection }: { connection: ConnectionState }) {
	return (
		<span class={`conn conn-${connection}`} title="Connection to the host">
			<Symbol k={CONN_SYMBOL[connection]} />
			{CONN_LABELS[connection]}
		</span>
	);
}

/** Status line segment separator, the same bar omp draws in statusLineSep. */
export function Sep() {
	return <span class="sep" aria-hidden="true">│</span>;
}
