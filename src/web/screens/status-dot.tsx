import type { SessionStatus } from "../../shared/types";

const LABELS: Record<SessionStatus, string> = {
	working: "Working",
	needs_answer: "Needs your answer",
	idle: "Idle",
	stopped: "Stopped",
};

export function StatusDot({ status }: { status: SessionStatus }) {
	return <span class={`dot dot-${status}`} role="img" aria-label={LABELS[status]} title={LABELS[status]} />;
}
