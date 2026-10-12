import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import type { SessionSummary, TranscriptItem } from "../../shared/types";
import { inlineSpans, isNearBottom, markdownBlocks, relativeTime, subagentTone } from "../lib/format";
import { DialogPanel } from "./dialog-panel";
import { BackIcon, DownIcon, LaptopIcon } from "./icons";
import type { ScreenProps } from "./props";
import { ConnMark, Sep, StatusGlyph, StatusWord } from "./status-glyph";
import { ToolCard } from "./tool-card";

function Inline({ text }: { text: string }) {
	return (
		<>
			{inlineSpans(text).map((span, index) =>
				span.kind === "code" ? <code key={index}>{span.text}</code> : span.kind === "bold" ? <strong key={index}>{span.text}</strong> : span.text,
			)}
		</>
	);
}

function Markdown({ text }: { text: string }) {
	const blocks = useMemo(() => markdownBlocks(text), [text]);
	return (
		<div class="md">
			{blocks.map((block, index) => {
				switch (block.kind) {
					case "heading":
						return <p key={index} class="md-h"><Inline text={block.text} /></p>;
					case "item":
						return (
							<p key={index} class={`md-item md-indent-${block.indent}`}>
								<span class="md-bullet" aria-hidden="true">{block.marker}</span>
								<span><Inline text={block.text} /></span>
							</p>
						);
					case "quote":
						return <blockquote key={index} class="md-quote"><Inline text={block.text} /></blockquote>;
					case "code":
						return <pre key={index} class="md-code" data-lang={block.lang || undefined}>{block.text}</pre>;
					case "hr":
						return <hr key={index} class="md-hr" />;
					default:
						return <p key={index} class="md-p"><Inline text={block.text} /></p>;
				}
			})}
		</div>
	);
}

function Bubble({ item }: { item: TranscriptItem }) {
	if (item.kind === "tool") return item.tool ? <ToolCard tool={item.tool} /> : null;
	if (item.kind === "notice") return <p class="notice"><span>{item.text}</span></p>;
	if (item.kind === "user") return <div class="msg msg-user"><p class="msg-text">{item.text}</p></div>;
	return (
		<div class="msg msg-assistant">
			{item.thinking ? (
				<details class="thinking">
					<summary><span class="chev" aria-hidden="true" />thinking</summary>
					<p>{item.thinking}</p>
				</details>
			) : null}
			{item.text ? <Markdown text={item.text} /> : null}
		</div>
	);
}

/** The manager answers this for a session it is not running; that is a state, not a failure to show. */
function isUnknownSessionError(error: string | null): boolean {
	return error !== null && error.startsWith("Unknown session");
}

function NotRunning({ state, actions, summary }: ScreenProps & { summary: SessionSummary | null }) {
	const [busy, setBusy] = useState(false);
	const resume = async () => {
		if (busy || !summary) return;
		setBusy(true);
		try {
			await actions.newSession(summary.repo, summary.sessionFile ?? undefined);
		} finally {
			setBusy(false);
		}
	};

	return (
		<main class="screen">
			<header class="bar">
				<div class="bar-row">
					<button type="button" class="btn btn-bar btn-icon" aria-label="Back" onClick={() => actions.showSessions()}>
						<BackIcon />
					</button>
					<h1 class="bar-title ellipsis">{summary ? summary.title || "(untitled)" : "session"}</h1>
				</div>
			</header>
			<div class="center-screen">
				<section class="panel">
					<p class="panel-title">session</p>
					{summary === null ? (
						<>
							<p class="panel-state state-stopped">○ not in the list</p>
							<p class="panel-detail">It may have been removed, or it is outside the allowed repos.</p>
						</>
					) : summary.openAtLaptop ? (
						<>
							<p class="panel-state panel-laptop"><LaptopIcon />open at laptop</p>
							<h2 class="panel-heading">{summary.title || "(untitled)"}</h2>
							<p class="panel-meta"><span class="chip chip-repo">{summary.repoName}</span>{relativeTime(summary.updatedAt)}</p>
							<p class="panel-detail">It cannot be resumed from here until you quit it there.</p>
						</>
					) : (
						<>
							<p class="panel-state"><StatusWord status="stopped" /></p>
							<h2 class="panel-heading">{summary.title || "(untitled)"}</h2>
							<p class="panel-meta"><span class="chip chip-repo">{summary.repoName}</span>last active {relativeTime(summary.updatedAt)}</p>
							<p class="panel-detail">This session is stopped. Resume it to keep going from your phone.</p>
							{state.error && !isUnknownSessionError(state.error) ? <p class="error" role="alert">{state.error}</p> : null}
							<button type="button" class="btn btn-primary big-btn" disabled={busy} onClick={() => void resume()}>
								{busy ? "resuming…" : "▶ Resume"}
							</button>
						</>
					)}
				</section>
				<button type="button" class="btn btn-quiet" onClick={() => actions.showSessions()}>‹ back to sessions</button>
			</div>
		</main>
	);
}

function composerHint(state: ScreenProps["state"], working: boolean, drafting: boolean): string {
	if (state.connection === "connecting") return "connecting… sending waits for the link";
	if (state.connection === "closed") return "offline · sending waits for the link";
	if (state.dialog) return "the agent is waiting on the question above";
	if (working) return drafting ? "Send steers the running turn" : "Stop ends the turn · type to steer";
	return "idle · ready for a prompt";
}

export function ChatScreen({ state, actions }: ScreenProps) {
	const text = state.draft;
	const setText = actions.setDraft;
	const [atBottom, setAtBottom] = useState(true);
	const boxRef = useRef<HTMLDivElement>(null);
	const stick = useRef(true);
	const working = state.status.status === "working";
	const queued = [...state.queued.steering, ...state.queued.followUp];

	// Sample before the DOM grows so a long delta never flips "at the bottom" to false.
	const onScroll = () => {
		if (!boxRef.current) return;
		stick.current = isNearBottom(boxRef.current);
		setAtBottom(stick.current);
	};

	const scrollToBottom = () => {
		const box = boxRef.current;
		if (!box) return;
		stick.current = true;
		box.scrollTo({ top: box.scrollHeight, behavior: "smooth" });
		setAtBottom(true);
	};

	useLayoutEffect(() => {
		const box = boxRef.current;
		if (box && stick.current) box.scrollTop = box.scrollHeight;
	}, [state.items, state.subagents, state.dialog]);

	useEffect(() => {
		const box = boxRef.current;
		if (box) box.scrollTop = box.scrollHeight;
	}, []);

	const summary = state.sessions.find((session) => session.id === state.sessionId) ?? state.session;
	const missing = summary === null && (state.error !== null || state.connection === "closed");
	if ((summary !== null && !summary.running) || missing) return <NotRunning state={state} actions={actions} summary={summary} />;

	const send = () => {
		const trimmed = text.trim();
		if (trimmed === "") return;
		stick.current = true;
		actions.sendPrompt(trimmed);
	};

	const title = state.session?.title || state.session?.repoName || "session";
	const error = isUnknownSessionError(state.error) ? null : state.error;
	const drafting = text.trim() !== "";

	return (
		<main class="screen chat">
			<header class="bar">
				<div class="bar-row">
					<button type="button" class="btn btn-bar btn-icon" aria-label="Back" onClick={() => actions.showSessions()}>
						<BackIcon />
					</button>
					<h1 class="bar-title ellipsis">{title}</h1>
					<button type="button" class="btn btn-bar" onClick={() => actions.showScreen("diff")}>± Diff</button>
					<button type="button" class="btn btn-bar btn-icon" aria-label="Hand off to laptop" title="Hand off to laptop" onClick={() => actions.handOffToLaptop()}>
						<LaptopIcon />
					</button>
				</div>
				<div class="statusline">
					<StatusWord status={state.status.status} />
					{state.session ? <><Sep /><span class="chip chip-repo ellipsis">{state.session.repoName}</span></> : null}
					{state.subagents.length > 0 ? <><Sep /><span class="seg-agents">↳ {state.subagents.length}</span></> : null}
					<ConnMark connection={state.connection} />
				</div>
			</header>
			{state.connection !== "open" ? <p class="banner">{state.connection === "connecting" ? "connecting…" : "reconnecting…"}</p> : null}
			{error ? <p class="error" role="alert">{error}</p> : null}
			<div class="transcript-wrap">
				<div class="transcript" ref={boxRef} onScroll={onScroll}>
					{state.items.length === 0 && state.connection === "connecting" ? <p class="placeholder"><span class="spin" aria-hidden="true" /> loading session…</p> : null}
					{state.items.length === 0 && state.connection !== "connecting" ? <p class="placeholder">no messages yet · say something below</p> : null}
					{state.items.map((item) => <Bubble key={item.id} item={item} />)}
					{state.subagents.length > 0 ? (
						<section class="agents" aria-label="Subagents">
							<p class="label">agents · {state.subagents.length}</p>
							<ul>
								{state.subagents.map((agent) => (
									<li key={agent.id} class="agent">
										<span class={`tool-mark tone-${subagentTone(agent.status)}`} aria-hidden="true" />
										<strong class="agent-label">{agent.label}</strong>
										<span class="agent-status">{agent.status}</span>
										{agent.detail ? <span class="agent-detail">{agent.detail}</span> : null}
									</li>
								))}
							</ul>
						</section>
					) : null}
				</div>
				{atBottom ? null : (
					<button type="button" class="btn btn-icon scroll-down" aria-label="Scroll to latest" onClick={scrollToBottom}>
						<DownIcon />
					</button>
				)}
			</div>
			{queued.length > 0 ? (
				<div class="queued">
					<span class="label">queued</span>
					<ul aria-label="Queued messages">
						{queued.map((message, index) => (
							<li key={`${index}:${message}`} class="chip ellipsis">{message}</li>
						))}
					</ul>
				</div>
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
				<div class="prompt">
					<span class="prompt-glyph" aria-hidden="true">❯</span>
					<textarea
						rows={1}
						placeholder="message the agent"
						aria-label="Message the agent"
						value={text}
						onInput={(event) => setText(event.currentTarget.value)}
					/>
					{working ? (
						<button type="button" class="btn btn-stop" aria-label="Stop" onClick={() => actions.abort()}>
							<span class="stop-mark" aria-hidden="true" />{drafting ? null : "Stop"}
						</button>
					) : null}
					{!working || drafting ? (
						<button type="button" class="btn btn-primary btn-send" disabled={!drafting} onClick={send}>Send</button>
					) : null}
				</div>
				<p class="composer-hint">
					{working ? <StatusGlyph status="working" /> : null}
					<span class="ellipsis">{composerHint(state, working, drafting)}</span>
				</p>
			</footer>
		</main>
	);
}
