import type { SessionStatus } from "../../shared/types";
import type { ConnectionState } from "../lib/app-state";

export const STATUS_LABELS: Record<SessionStatus, string> = {
	working: "working",
	needs_answer: "needs answer",
	idle: "idle",
	stopped: "stopped",
};

/** The glyph itself is CSS content so "working" can spin like omp's braille spinner. */
export function StatusGlyph({ status }: { status: SessionStatus }) {
	return <span class={`glyph glyph-${status}`} role="img" aria-label={STATUS_LABELS[status]} title={STATUS_LABELS[status]} />;
}

/** Glyph plus word, coloured by state: the first segment of every status line. */
export function StatusWord({ status }: { status: SessionStatus }) {
	return (
		<span class={`state state-${status}`}>
			<span class={`glyph glyph-${status}`} aria-hidden="true" />
			{STATUS_LABELS[status]}
		</span>
	);
}

const CONN_LABELS: Record<ConnectionState, string> = {
	open: "live",
	connecting: "connecting",
	closed: "offline",
};

/** The link to the laptop, as the last segment of a status line. */
export function ConnMark({ connection }: { connection: ConnectionState }) {
	return (
		<span class={`conn conn-${connection}`} title="Connection to the laptop">
			{CONN_LABELS[connection]}
		</span>
	);
}

/** Status line segment separator, the same bar omp draws in statusLineSep. */
export function Sep() {
	return <span class="sep" aria-hidden="true">│</span>;
}
