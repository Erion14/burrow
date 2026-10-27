// omp's status line, on the phone: one scrolling row carrying the same segments
// the TUI draws (state word, model, thinking level, context usage, todos,
// subagents, queue, repo, link). It is presentation only: every value comes from
// the last `get_state` read and every tap is reported to the parent, which owns
// the pickers and the panel. A field omp has not reported stays absent from
// `status`, so "no model yet" can be shown as a placeholder instead of a wrong
// name.

import { type ComponentChildren, Fragment } from "preact";
import type { StatusView } from "../../shared/types";
import type { ConnectionState } from "../lib/app-state";
import { Symbol } from "./symbol";
import { ConnMark, Sep, StatusWord } from "./status-glyph";
import "./status-line.css";

/** Cancelled work is closed, so it counts as neither open nor finished. */
const CLOSED_TODO: Record<string, true> = { completed: true, cancelled: true };

/** Past this the next turn is likely to compact, so the segment says so in colour. */
const CONTEXT_WARN_PERCENT = 80;

/** An objective is a sentence and the row scrolls sideways, so the chip carries a head of it. */
const GOAL_CHIP_CHARS = 40;

export interface StatusLineProps {
	status: StatusView;
	subagentCount: number;
	queuedCount: number;
	repoName: string | null;
	connection: ConnectionState;
	todosOpen: boolean;
	onPickModel(): void;
	onPickThinking(): void;
	onToggleTodos(): void;
	/** The active goal, or null/undefined when omp reports none: the chip is hidden then. */
	goal: StatusView["goal"];
	onGoal(): void;
}

export function StatusLine({
	status,
	subagentCount,
	queuedCount,
	repoName,
	connection,
	todosOpen,
	onPickModel,
	onPickThinking,
	onToggleTodos,
	goal,
	onGoal,
}: StatusLineProps) {
	const model = status.model ?? null;
	const thinking = status.thinkingLevel ?? null;
	const usage = status.contextUsage ?? null;
	// The plan, flattened, because the chip wants one number for the work left.
	const tasks = (status.todos ?? []).flatMap((phase) => phase.tasks);
	const openTodos = tasks.filter((task) => CLOSED_TODO[task.status] !== true).length;
	// omp names most models, but a name is not guaranteed, and a chip that reads
	// "provider/id" still beats a chip that reads nothing.
	const modelLabel = model === null ? "pick model" : model.name === "" ? `${model.provider}/${model.id}` : model.name;

	const segments: ComponentChildren[] = [
		<button
			type="button"
			class={model === null ? "sl-chip sl-model is-unknown" : "sl-chip sl-model"}
			title={model === null ? "Model: omp has not reported one; tap to choose" : `Model: ${model.provider}/${model.id}`}
			onClick={onPickModel}
		>
			<Symbol k="seg.model" />
			{modelLabel}
		</button>,
		<button
			type="button"
			class={thinking === null ? "sl-chip sl-thinking is-unknown" : "sl-chip sl-thinking"}
			title={thinking === null ? "Thinking level: omp has not reported one; tap to choose" : `Thinking level: ${thinking}`}
			onClick={onPickThinking}
		>
			<Symbol k="seg.thinking" />
			{thinking === null ? "thinking" : thinking}
		</button>,
	];

	if (usage !== null) {
		segments.push(
			<span
				class={usage.percent > CONTEXT_WARN_PERCENT ? "sl-chip sl-context is-high" : "sl-chip sl-context"}
				title={`Context: ${usage.tokens} of ${usage.contextWindow} tokens`}
			>
				<Symbol k="seg.context" />
				{Math.round(usage.percent)}%
			</span>,
		);
	}

	// No todos at all means there is nothing to open; a plan whose tasks are all
	// closed still shows, because the panel is worth a tap to read.
	if (tasks.length > 0) {
		segments.push(
			<button
				type="button"
				class={todosOpen ? "sl-chip sl-todos is-open" : "sl-chip sl-todos"}
				aria-pressed={todosOpen}
				title={`Todos: ${openTodos} of ${tasks.length} open`}
				onClick={onToggleTodos}
			>
				<Symbol k="seg.todos" />
				{openTodos}
			</button>,
		);
	}

	if (subagentCount > 0) {
		segments.push(
			<span class="sl-chip sl-agents" title={`${subagentCount} subagents`}>
				<Symbol k="seg.subagents" />
				{subagentCount}
			</span>,
		);
	}

	if (queuedCount > 0) {
		segments.push(
			<span class="sl-chip sl-queue" title={`${queuedCount} queued messages`}>
				<Symbol k="seg.queue" />
				{queuedCount}
			</span>,
		);
	}

	if (repoName !== null && repoName !== "") {
		segments.push(
			<span class="chip chip-repo ellipsis sl-repo" title={`Repository: ${repoName}`}>
				{repoName}
			</span>,
		);
	}

	// Hidden when omp reports no goal: an empty chip would read as a broken one,
	// and the sheet behind it has nothing to show either.
	if (goal !== null && goal !== undefined) {
		const objective = goal.objective.trim().replace(/\s+/g, " ");
		segments.push(
			<button
				type="button"
				class="sl-chip sl-goal"
				title={`Goal: ${goal.state}`}
				onClick={onGoal}
			>
				<Symbol k="seg.goal" />
				<span class="sl-goal-text ellipsis">
					{objective.length > GOAL_CHIP_CHARS ? `${objective.slice(0, GOAL_CHIP_CHARS)}…` : objective}
				</span>
			</button>,
		);
	}

	return (
		<div class="status-line" role="group" aria-label="Session status">
			<StatusWord status={status.status} />
			{segments.map((segment, index) => (
				// The separators are positional, so the index is the identity here.
				<Fragment key={index}>
					<Sep />
					{segment}
				</Fragment>
			))}
			<Sep />
			<ConnMark connection={connection} />
		</div>
	);
}
