import { useEffect, useState } from "preact/hooks";
import type { DialogAnswer } from "../../shared/protocol";
import type { DialogQuestion, DialogView } from "../../shared/types";
import { type QuestionSelection, askAnswer, confirmAnswer, selectAnswer, textAnswer } from "../lib/dialog-answers";
import { tapFeedback } from "../lib/haptics";
import { StatusMark } from "./status-glyph";

interface Props {
	dialog: DialogView;
	onAnswer: (answer: DialogAnswer) => void;
	onDiscard: () => void;
}

const EMPTY: QuestionSelection = { selected: [] };

function QuestionBlock({
	question,
	selection,
	done,
	onChange,
	onCommit,
}: {
	question: DialogQuestion;
	selection: QuestionSelection;
	done: boolean;
	onChange: (next: QuestionSelection) => void;
	onCommit: () => void;
}) {
	const multi = question.multi === true;
	const toggle = (label: string) => {
		const has = selection.selected.includes(label);
		if (multi) onChange({ ...selection, selected: has ? selection.selected.filter((l) => l !== label) : [...selection.selected, label] });
		// A single select never carries both an option and free text.
		else onChange({ selected: has ? [] : [label], custom: "" });
	};
	const setCustom = (custom: string) => onChange({ selected: multi ? selection.selected : [], custom });
	const check = askAnswer([question], { [question.id]: selection });

	return (
		<div class={`question ${done ? "question-done" : ""}`}>
			{question.header ? <p class="label question-header">{question.header}</p> : null}
			<p class="dialog-message">{question.question}</p>
			<div class="choices">
				{question.options.map((option, index) => {
					const on = selection.selected.includes(option.label);
					return (
						<button
							key={option.label}
							type="button"
							class={`btn btn-choice ${on ? "is-on" : ""}`}
							aria-pressed={on}
							disabled={done}
							onClick={() => toggle(option.label)}
						>
							<span class="choice-key" aria-hidden="true">{multi ? (on ? "[x]" : "[ ]") : on ? "❯" : `${index + 1}`}</span>
							<span class="choice-body">
								<span class="choice-label">
									{option.label}
									{question.recommended === index ? <em class="rec">recommended</em> : null}
								</span>
								{option.description ? <small>{option.description}</small> : null}
							</span>
						</button>
					);
				})}
			</div>
			<input
				type="text"
				placeholder="or type your own answer"
				value={selection.custom ?? ""}
				disabled={done}
				onInput={(event) => setCustom(event.currentTarget.value)}
			/>
			{check.ok ? null : <small class="dialog-hint">{done ? "" : check.error}</small>}
			<button type="button" class={`btn ${done ? "" : "btn-commit"}`} disabled={done || !check.ok} onClick={onCommit}>
				{done ? "Done" : multi ? "Confirm" : "Select"}
			</button>
		</div>
	);
}

function AskPanel({ dialog, onAnswer }: { dialog: Extract<DialogView, { kind: "ask" }>; onAnswer: Props["onAnswer"] }) {
	const [selections, setSelections] = useState<Record<string, QuestionSelection>>({});
	const [committed, setCommitted] = useState<Record<string, true>>({});

	const commit = (id: string) => {
		const next = { ...committed, [id]: true as const };
		setCommitted(next);
		if (!dialog.questions.every((question) => next[question.id])) return;
		const result = askAnswer(dialog.questions, selections);
		if (result.ok) onAnswer(result.answer);
	};

	return (
		<>
			{dialog.questions.map((question) => (
				<QuestionBlock
					key={question.id}
					question={question}
					selection={selections[question.id] ?? EMPTY}
					done={committed[question.id] === true}
					onChange={(next) => setSelections({ ...selections, [question.id]: next })}
					onCommit={() => commit(question.id)}
				/>
			))}
		</>
	);
}

function TextPanel({ dialog, onAnswer }: { dialog: Extract<DialogView, { kind: "input" | "editor" }>; onAnswer: Props["onAnswer"] }) {
	const [value, setValue] = useState(dialog.kind === "editor" ? dialog.text : "");
	const send = () => onAnswer(textAnswer(dialog.kind, value));
	return (
		<>
			{dialog.kind === "editor" ? (
				<textarea rows={8} value={value} onInput={(event) => setValue(event.currentTarget.value)} />
			) : (
				<input
					type="text"
					placeholder={dialog.placeholder}
					value={value}
					onInput={(event) => setValue(event.currentTarget.value)}
					onKeyDown={(event) => {
						if (event.key === "Enter") send();
					}}
				/>
			)}
			<button type="button" class="btn btn-primary" onClick={send}>Send</button>
		</>
	);
}

export function DialogPanel({ dialog, onAnswer, onDiscard }: Props) {
	const [answered, setAnswered] = useState(false);
	const answer = (value: DialogAnswer) => {
		if (answered) return;
		setAnswered(true);
		// One door for every kind of answer, and the buzz sits inside the guard so a
		// second tap on a question already answered cannot fire it again.
		tapFeedback();
		onAnswer(value);
	};
	const discard = () => {
		if (answered) return;
		setAnswered(true);
		onDiscard();
	};
	useEffect(() => setAnswered(false), [dialog.id]);
	const title = dialog.kind === "ask" ? "" : dialog.title;
	const message = dialog.kind === "ask" ? "" : dialog.message;
	return (
		<section class="dialog" role="dialog" aria-label="Agent question">
			<div class="dialog-head"><StatusMark status="needs_answer" />agent needs your answer</div>
			{title ? <h2 class="dialog-title">{title}</h2> : null}
			{message ? <p class="dialog-message">{message}</p> : null}
			{dialog.kind === "confirm" ? (
				<div class="choices choices-row">
					<button type="button" class="btn btn-choice btn-yes" onClick={() => answer(confirmAnswer(true))}>
						<span class="choice-key" aria-hidden="true">y</span>
						<span class="choice-label">Yes</span>
					</button>
					<button type="button" class="btn btn-choice" onClick={() => answer(confirmAnswer(false))}>
						<span class="choice-key" aria-hidden="true">n</span>
						<span class="choice-label">No</span>
					</button>
				</div>
			) : null}
			{dialog.kind === "select" ? (
				<div class="choices">
					{dialog.options.map((option, index) => (
						<button key={option} type="button" class="btn btn-choice" onClick={() => answer(selectAnswer(option))}>
							<span class="choice-key" aria-hidden="true">{index + 1}</span>
							<span class="choice-body">
								<span class="choice-label">{option}</span>
								{dialog.optionDetails[index] ? <small>{dialog.optionDetails[index]}</small> : null}
							</span>
						</button>
					))}
				</div>
			) : null}
			{dialog.kind === "input" || dialog.kind === "editor" ? <TextPanel dialog={dialog} onAnswer={answer} /> : null}
			{dialog.kind === "ask" ? <AskPanel dialog={dialog} onAnswer={answer} /> : null}
			<button type="button" class="btn btn-quiet" onClick={discard}>✕ Cancel</button>
		</section>
	);
}
