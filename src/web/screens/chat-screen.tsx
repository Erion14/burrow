import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import type { TranscriptItem } from "../../shared/types";
import { isNearBottom } from "../lib/format";
import { DialogPanel } from "./dialog-panel";
import type { ScreenProps } from "./props";
import { StatusDot } from "./status-dot";
import { ToolCard } from "./tool-card";

function Bubble({ item }: { item: TranscriptItem }) {
	if (item.kind === "tool") return item.tool ? <ToolCard tool={item.tool} /> : null;
	if (item.kind === "notice") return <p class="notice">{item.text}</p>;
	return (
		<div class={`bubble bubble-${item.kind}`}>
			{item.thinking ? (
				<details class="thinking">
					<summary>Thinking</summary>
					<p>{item.thinking}</p>
				</details>
			) : null}
			{item.text ? <p class="bubble-text">{item.text}</p> : null}
		</div>
	);
}

export function ChatScreen({ state, actions }: ScreenProps) {
	const [text, setText] = useState("");
	const boxRef = useRef<HTMLDivElement>(null);
	const stick = useRef(true);
	const working = state.status.status === "working";
	const queued = [...state.queued.steering, ...state.queued.followUp];

	// Sample before the DOM grows so a long delta never flips "at the bottom" to false.
	const onScroll = () => {
		if (boxRef.current) stick.current = isNearBottom(boxRef.current);
	};

	useLayoutEffect(() => {
		const box = boxRef.current;
		if (box && stick.current) box.scrollTop = box.scrollHeight;
	}, [state.items, state.subagents, state.dialog]);

	useEffect(() => {
		const box = boxRef.current;
		if (box) box.scrollTop = box.scrollHeight;
	}, []);

	const send = () => {
		const trimmed = text.trim();
		if (trimmed === "" || state.connection !== "open") return;
		stick.current = true;
		actions.sendPrompt(trimmed);
		setText("");
	};

	const title = state.session?.title || state.session?.repoName || "Session";

	return (
		<main class="screen chat">
			<header class="bar">
				<button type="button" class="btn" onClick={() => actions.showSessions()}>Back</button>
				<StatusDot status={state.status.status} />
				<span class="bar-title">
					<h1 class="ellipsis">{title}</h1>
					{state.session ? <span class="row-sub">{state.session.repoName}</span> : null}
				</span>
				<span class="spacer" />
				<button type="button" class="btn" onClick={() => actions.showScreen("diff")}>Diff</button>
			</header>
			<div class="bar bar-actions">
				{working ? <button type="button" class="btn btn-danger" onClick={() => actions.abort()}>Stop</button> : null}
				<button type="button" class="btn" onClick={() => actions.handOffToLaptop()}>Hand off to laptop</button>
			</div>
			{state.connection !== "open" ? <p class="banner">{state.connection === "connecting" ? "Connecting..." : "Reconnecting..."}</p> : null}
			{state.error ? <p class="error" role="alert">{state.error}</p> : null}
			<div class="transcript" ref={boxRef} onScroll={onScroll}>
				{state.items.length === 0 && state.connection === "connecting" ? <p class="muted center">Loading session...</p> : null}
				{state.items.length === 0 && state.connection !== "connecting" ? <p class="muted center">No messages yet. Say something.</p> : null}
				{state.items.map((item) => <Bubble key={item.id} item={item} />)}
				{state.subagents.length > 0 ? (
					<ul class="subagents">
						{state.subagents.map((agent) => (
							<li key={agent.id} class="ellipsis">
								<strong>{agent.label}</strong> <span class="muted">{agent.status}</span>
								{agent.detail ? <span class="muted"> {agent.detail}</span> : null}
							</li>
						))}
					</ul>
				) : null}
			</div>
			{queued.length > 0 ? (
				<ul class="queued" aria-label="Queued messages">
					{queued.map((message, index) => (
						<li key={`${index}:${message}`} class="chip ellipsis">{message}</li>
					))}
				</ul>
			) : null}
			{state.dialog ? (
				<DialogPanel
					key={state.dialog.id}
					dialog={state.dialog}
					onAnswer={(answer) => actions.answerDialog(state.dialog!.id, answer)}
					onDiscard={() => actions.discardDialog(state.dialog!.id)}
				/>
			) : null}
			<footer class="composer">
				<textarea
					rows={2}
					placeholder="Message the agent"
					value={text}
					onInput={(event) => setText(event.currentTarget.value)}
				/>
				<button type="button" class="btn btn-primary" disabled={state.connection !== "open"} onClick={send}>Send</button>
			</footer>
		</main>
	);
}
