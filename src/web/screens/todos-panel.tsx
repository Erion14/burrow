// The plan omp is working through, as a panel: one section per phase, one row
// per task. The marks come from the same table the status line reads, so a
// phase here reads like the state word above the composer. Presentation only:
// nothing is tappable, omp owns the plan.

import type { TodoPhaseView } from "../../shared/types";
import type { SymbolKey } from "../lib/symbols";
import { Symbol } from "./symbol";
import "./todos-panel.css";

/** omp words the task state; the mark for each word comes from the shared table. */
const TODO_MARK: Record<string, SymbolKey> = {
	pending: "status.stopped",
	in_progress: "status.working",
	completed: "status.done",
	cancelled: "status.warning",
};

/** An unknown word is still a task, so it gets a neutral mark rather than none. */
const TODO_FALLBACK: SymbolKey = "status.info";

export function TodosPanel({ todos }: { todos: readonly TodoPhaseView[] }) {
	if (todos.length === 0) return null;
	// A phase omp has emptied is noise on a phone width, and the phone shows this
	// panel between the transcript and the composer, so it is dropped here.
	const phases = todos.filter((phase) => phase.tasks.length > 0);
	if (phases.length === 0) return null;
	return (
		<div class="todos-panel">
			{phases.map((phase) => (
				<section key={phase.name} class="todos-phase">
					<p class="todos-phase-head">
						<span class="todos-phase-name">{phase.name}</span>
						<span class="todos-count">
							{phase.tasks.filter((task) => task.status === "completed").length}/{phase.tasks.length}
						</span>
					</p>
					<ul class="todos-tasks">
						{phase.tasks.map((task, index) => (
							// Tasks carry no id from omp and their text may repeat, so the
							// position in the phase is the identity.
							<li key={index} class={`todo todo-${task.status.replace(/_/g, "-")}`}>
								<Symbol k={TODO_MARK[task.status] ?? TODO_FALLBACK} class="todo-mark" />
								<span class="todo-content">{task.content}</span>
								<span class="todo-status">{task.status.replace(/_/g, " ")}</span>
							</li>
						))}
					</ul>
				</section>
			))}
		</div>
	);
}
