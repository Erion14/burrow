import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import type { BashCard, ModelView, SessionSummary, TranscriptItem } from "../../shared/types";
import { applyCompletion, commandItems, completionAt, fileItems, type CompletionItem, type TokenRange } from "../lib/completion";
import { bashCommand, bashMode, type EditAction, editDraft, insertText } from "../lib/composer";
import { type DraftStorage, readDraft, writeDraft } from "../lib/drafts";
import { fetchFiles } from "../lib/files-api";
import { inlineSpans, isNearBottom, markdownBlocks, relativeTime, subagentTone } from "../lib/format";
import { successFeedback, tapFeedback } from "../lib/haptics";
import { chordAction, type ChordAction, type ChordModifier } from "../lib/keys";
import { copyTextFor } from "../lib/message-text";
import type { PickerItem } from "../lib/picker";
import { CompletionMenu } from "./completion-menu";
import { DialogPanel } from "./dialog-panel";
import { KeyBar } from "./key-bar";
import { PickerSheet } from "./picker-sheet";
import type { ScreenProps } from "./props";
import { StatusGlyph, StatusWord, ToneMark } from "./status-glyph";
import { StatusLine } from "./status-line";
import { Symbol } from "./symbol";
import { TodosPanel } from "./todos-panel";
import { ToolCard } from "./tool-card";

/** How long the file menu waits for the typing to pause before it asks the repo index. */
const FILE_FETCH_DEBOUNCE_MS = 120;

/** A long press on a queued chip promotes it; a shorter one removes it. */
const LONG_PRESS_MS = 500;

/** How long the bubble's copied chip stays up; the same beat the diff screen uses. */
const COPIED_MS = 1000;

/** The goal sheet's three actions; a goal has no list of its own to pick from. */
const GOAL_ITEMS: readonly PickerItem[] = [
	{ id: "pause", label: "Pause goal", detail: "keep the objective, stop the work", group: "" },
	{ id: "resume", label: "Resume goal", detail: "keep working toward the objective", group: "" },
	{ id: "drop", label: "Drop goal", detail: "abandon the objective", group: "" },
];

/**
 * `localStorage` is absent or refused in some phone browsers; a draft is not
 * worth a crash, so the screen asks for it through one guarded door.
 */
function draftStorage(): DraftStorage | null {
	try {
		return window.localStorage ?? null;
	} catch {
		return null;
	}
}

/** 200000 tokens of window reads as "200k", which is all a chip has room for. */
function contextLabel(tokens: number): string {
	if (tokens < 1000) return `${tokens}`;
	const thousands = tokens / 1000;
	return Number.isInteger(thousands) ? `${thousands}k` : `${thousands.toFixed(1)}k`;
}

/** The `provider/id` a model is named by, on the wire and in the sheet. */
function modelId(model: { provider: string; id: string }): string {
	return `${model.provider}/${model.id}`;
}

function modelRows(models: readonly ModelView[]): PickerItem[] {
	return models.map((model) => ({
		id: modelId(model),
		// A model omp does not name is still pickable, and its id is its name then.
		label: model.name === "" ? modelId(model) : model.name,
		detail: model.contextWindow === null ? modelId(model) : `${modelId(model)} · ${contextLabel(model.contextWindow)}`,
		group: model.provider,
	}));
}

/** How a `!command` ended, for the chip beside its command line. */
function bashExitLabel(card: BashCard | undefined): string {
	if (card === undefined) return "done";
	if (card.cancelled === true) return "cancelled";
	if (card.exitCode === null) return "no exit code";
	return `exit ${card.exitCode}`;
}

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

/** A `!command` as the terminal card: the command line, how it ended, the output tail. */
function BashBubble({ item }: { item: TranscriptItem }) {
	const card = item.bash;
	const status = card?.status ?? "done";
	return (
		<div class={`bash bash-${status}`}>
			<p class="bash-line">
				<span class="bash-prompt" aria-hidden="true">$</span>
				<span class="bash-command ellipsis">{card?.command ?? ""}</span>
				{status === "running" ? (
					<span class="bash-exit bash-exit-running"><span class="spin" aria-hidden="true" />running</span>
				) : (
					<span class="bash-exit">{bashExitLabel(card)}</span>
				)}
			</p>
			{item.text === "" ? null : <pre class="bash-out">{item.text}</pre>}
		</div>
	);
}

/** The copy that a long press just made, said once, on the bubble it came from. */
function CopiedChip() {
	return <span class="copied-chip" role="status">copied</span>;
}

/**
 * Only the user's and the assistant's bubbles are worth copying, which is why
 * the press handlers live on those two branches. The handlers are passive: a tap
 * and a selection drag must keep working exactly as they did, so nothing here
 * calls `preventDefault` and the copy waits for the 500 ms hold.
 */
function Bubble({
	item,
	thinkingVisible,
	toolsOpen,
	copied,
	onPressStart,
	onPressEnd,
}: {
	item: TranscriptItem;
	thinkingVisible: boolean;
	toolsOpen: boolean | null;
	copied: boolean;
	onPressStart: (item: TranscriptItem) => void;
	onPressEnd: () => void;
}) {
	if (item.kind === "tool") return item.tool ? <ToolCard tool={item.tool} open={toolsOpen ?? undefined} /> : null;
	if (item.kind === "bash") return <BashBubble item={item} />;
	if (item.kind === "notice") return <p class="notice"><span>{item.text}</span></p>;
	const press = {
		onPointerDown: () => onPressStart(item),
		onPointerUp: () => onPressEnd(),
		onPointerCancel: () => onPressEnd(),
		onPointerLeave: () => onPressEnd(),
	};
	if (item.kind === "user") {
		return (
			<div class={copied ? "msg msg-user is-copied" : "msg msg-user"} {...press}>
				<p class="msg-text">{item.text}</p>
				{copied ? <CopiedChip /> : null}
			</div>
		);
	}
	// The thinking block is drawn only while the phone is showing thinking at all;
	// the text omp streamed stays in the item either way.
	return (
		<div class={copied ? "msg msg-assistant is-copied" : "msg msg-assistant"} {...press}>
			{item.thinking !== "" && thinkingVisible ? (
				<details class="thinking">
					<summary><Symbol k="ui.collapsed" class="chev" />thinking</summary>
					<p>{item.thinking}</p>
				</details>
			) : null}
			{item.text ? <Markdown text={item.text} /> : null}
			{copied ? <CopiedChip /> : null}
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

	const follow = async () => {
		const file = summary?.sessionFile ?? null;
		if (busy || file === null) return;
		setBusy(true);
		try {
			await actions.watchSession(file);
		} finally {
			setBusy(false);
		}
	};

	return (
		<main class="screen">
			<header class="bar">
				<div class="bar-row">
					<button type="button" class="btn btn-bar btn-icon" aria-label="Back" onClick={() => actions.showSessions()}>
						<Symbol k="ui.back" />
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
					) : summary.openElsewhere ? (
						<>
							<p class="panel-state panel-elsewhere"><Symbol k="ui.laptop" />in use at the host</p>
							<h2 class="panel-heading">{summary.title || "(untitled)"}</h2>
							<p class="panel-meta"><span class="chip chip-repo">{summary.repoName}</span>{relativeTime(summary.updatedAt)}</p>
							<p class="panel-detail">It is open in another omp. Follow it read only, and take it over from there when you want to write.</p>
							<button type="button" class="btn btn-primary big-btn" disabled={busy} onClick={() => void follow()}>
								{busy ? "opening…" : "Follow it"}
							</button>
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

/**
 * What stands in the composer's place while following a session another process writes:
 * nothing typed here could reach it, so there is no box to type into, and taking the
 * session over (which stops that process) is the way to get one back.
 */
function ReadOnlyBar({ session, onTakeOver }: { session: SessionSummary | null; onTakeOver: () => Promise<void> }) {
	const [asking, setAsking] = useState(false);
	const [busy, setBusy] = useState(false);
	const takeOver = async () => {
		if (busy) return;
		setBusy(true);
		try {
			await onTakeOver();
		} finally {
			setBusy(false);
			setAsking(false);
		}
	};

	return (
		<footer class="read-only-bar">
			<p class="read-only-note">
				<Symbol k="ui.laptop" />Following the copy on the laptop. Nothing typed here would reach it.
			</p>
			{session?.canTakeOver !== true ? null : asking ? (
				<div class="take-over-ask" role="group" aria-label="Take over this session">
					<p class="take-over-text">Stops the omp running on the laptop and continues the session here.</p>
					<div class="take-over-actions">
						<button type="button" class="btn btn-quiet take-over-cancel" onClick={() => setAsking(false)}>
							Cancel
						</button>
						<button type="button" class="btn btn-danger take-over-confirm" disabled={busy} onClick={() => void takeOver()}>
							{busy ? "taking over…" : "Take over"}
						</button>
					</div>
				</div>
			) : (
				<button type="button" class="btn btn-danger btn-take-over" onClick={() => setAsking(true)}>
					Take over
				</button>
			)}
		</footer>
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
	// Queued messages keep the queue they came from: removing one names both.
	const queued = [
		...state.queued.steering.map((message) => ({ message, queue: "steering" as const })),
		...state.queued.followUp.map((message) => ({ message, queue: "followUp" as const })),
	];

	const textarea = useRef<HTMLTextAreaElement>(null);
	const renameBox = useRef<HTMLInputElement>(null);
	const steerBox = useRef<HTMLInputElement>(null);
	const [modifiers, setModifiers] = useState<readonly ChordModifier[]>([]);
	const [caret, setCaret] = useState(0);
	const [menu, setMenu] = useState<{ token: TokenRange; items: CompletionItem[]; active: number } | null>(null);
	const [renaming, setRenaming] = useState<string | null>(null);
	const [steering, setSteering] = useState<string | null>(null);
	const [steerText, setSteerText] = useState("");
	const [modelsPending, setModelsPending] = useState(false);
	// The caret the keyboard work wants back once the DOM holds the new text.
	const caretMove = useRef<number | null>(null);
	const [caretTick, setCaretTick] = useState(0);
	// The message and caret a pick already resolved, so the file menu does not
	// reopen on the path it just inserted.
	const picked = useRef<string | null>(null);
	const renameDone = useRef(false);
	const press = useRef<{ timer: number; fired: boolean } | null>(null);
	// The bubble hold's own handle: a chip and a bubble are two different presses,
	// so the queue's ref cannot time this one.
	const copyPress = useRef<number | null>(null);
	const [copiedId, setCopiedId] = useState<string | null>(null);
	const draftSession = useRef<string | null>(null);

	useEffect(() => {
		if (copiedId === null) return;
		const timer = setTimeout(() => setCopiedId(null), COPIED_MS);
		return () => clearTimeout(timer);
	}, [copiedId]);

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

	// Saving first and loading second is what keeps a session switch honest: this
	// render still carries the previous session's text, and writing that under the
	// new id would clobber the draft being read.
	useEffect(() => {
		const sessionId = state.sessionId;
		if (sessionId !== null && draftSession.current === sessionId) writeDraft(draftStorage(), sessionId, text);
	}, [state.sessionId, text]);

	useEffect(() => {
		const sessionId = state.sessionId;
		if (sessionId === null || draftSession.current === sessionId) return;
		draftSession.current = sessionId;
		const draft = readDraft(draftStorage(), sessionId);
		setText(draft);
		// The caret waits at the end of the restored draft, and the box is left
		// alone: moving the selection of an unfocused textarea raises the phone
		// keyboard, which opening a session must not do.
		setCaret(draft.length);
	}, [state.sessionId, setText]);

	// The models read reports either way, which is what ends the "loading" text.
	useEffect(() => {
		setModelsPending(false);
	}, [state.models, state.modelsError]);

	useEffect(() => {
		if (renaming !== null) {
			renameBox.current?.focus();
			renameBox.current?.select();
		}
	}, [renaming !== null]);

	useEffect(() => {
		if (steering !== null) steerBox.current?.focus();
	}, [steering]);

	/**
	 * The caret after an edit: the box is written once the DOM has the new text,
	 * because a selection set on the same tick would address the old value.
	 */
	const moveCaret = (next: number) => {
		caretMove.current = next;
		setCaret(next);
		setCaretTick((tick) => tick + 1);
	};

	useLayoutEffect(() => {
		const next = caretMove.current;
		if (next === null) return;
		caretMove.current = null;
		const box = textarea.current;
		if (box === null || document.activeElement !== box) return;
		box.setSelectionRange(next, next);
	}, [caretTick, text]);

	// The `@` and `/` menus: a slash token is answered from the command list the
	// server already sent, a file token from the repo index after a pause in the
	// typing, with the previous request dropped so a stale answer never lands.
	useEffect(() => {
		const guard = picked.current;
		picked.current = null;
		// A pick rewrote the token it came from, which would match that same file
		// again; skipping its own change keeps the menu closed until the next one.
		if (guard === `${caret}:${text}`) return;
		const token = completionAt(text, caret);
		if (token === null) {
			setMenu(null);
			return;
		}
		if (token.menu === "command") {
			const items = commandItems(state.commands, token);
			setMenu(items.length === 0 ? null : { token, items, active: 0 });
			return;
		}
		const sessionId = state.sessionId;
		if (sessionId === null) {
			setMenu(null);
			return;
		}
		const controller = new AbortController();
		const timer = setTimeout(() => {
			void fetchFiles(sessionId, token.query, controller.signal).then((answer) => {
				if (controller.signal.aborted) return;
				const items = fileItems(answer === null ? [] : answer.items);
				setMenu(items.length === 0 ? null : { token, items, active: 0 });
			});
		}, FILE_FETCH_DEBOUNCE_MS);
		return () => {
			clearTimeout(timer);
			controller.abort();
		};
	}, [text, caret, state.commands, state.sessionId]);

	const summary = state.sessions.find((session) => session.id === state.sessionId) ?? state.session;
	const missing = summary === null && (state.error !== null || state.connection === "closed");
	// Following another process's session is live even though Burrow runs no process for
	// it, so the read only flag wins over the "not running" panel.
	const readingOnly = state.readOnly && !missing;
	if (!readingOnly && ((summary !== null && !summary.running) || missing)) {
		return <NotRunning state={state} actions={actions} summary={summary} />;
	}

	const title = state.session?.title || state.session?.repoName || "session";
	const error = isUnknownSessionError(state.error) ? null : state.error;
	const drafting = text.trim() !== "";
	const bash = bashMode(text);
	const folder = state.session?.repoName ?? null;

	const openModels = () => {
		// An empty list means the phone has not read the models yet: asking is what
		// makes "loading models…" a state rather than an empty picker.
		if (state.models.length === 0) {
			setModelsPending(true);
			actions.listModels();
		}
		actions.openSheet("models");
	};

	const syncCaret = () => {
		const box = textarea.current;
		if (box) setCaret(box.selectionStart);
	};

	/**
	 * The selection the composer edits: the box's own while it holds the focus,
	 * and the tracked caret otherwise, because an unfocused textarea reports zero
	 * whatever the user last did with it.
	 */
	const composerSelection = () => {
		const box = textarea.current;
		if (box !== null && document.activeElement === box) return { start: box.selectionStart, end: box.selectionEnd };
		return { start: caret, end: caret };
	};

	const pick = (index: number) => {
		if (menu === null) return;
		const choice = menu.items[index];
		if (choice === undefined) return;
		const at = composerSelection().end;
		// Rows can be a keystroke old; the live caret is the fresher half of the
		// token, so the range is taken from it whenever the start still agrees.
		const live = completionAt(text, at);
		const token = live !== null && live.menu === menu.token.menu && live.start === menu.token.start ? live : menu.token;
		const next = applyCompletion(text, at, token, choice);
		setText(next.text);
		moveCaret(next.caret);
		// A file pick rewrites the token it came from, which would match that same
		// file again; one guard pair keeps the menu closed until the next change.
		if (token.menu === "file") picked.current = `${next.caret}:${next.text}`;
		setMenu(null);
	};

	const edit = (action: EditAction) => {
		const { start, end } = composerSelection();
		const next = editDraft(text, start, end, action);
		setText(next.text);
		moveCaret(next.caret);
	};

	const runAction = (resolved: ChordAction) => {
		switch (resolved) {
			case "abort":
				actions.abort();
				return;
			case "models":
				openModels();
				return;
			case "thinking_cycle":
				actions.cycleThinking();
				return;
			case "thinking_blocks":
				actions.toggleThinkingVisible();
				return;
			case "tools_expand":
				actions.toggleTools();
				return;
			case "dequeue": {
				// The newest queued message is the tail of the queue as the server
				// holds it: the steering messages, then the follow ups behind them.
				const newest = queued[queued.length - 1];
				if (newest) actions.removeQueued(newest.message, newest.queue);
				return;
			}
			case "accept_completion":
				if (menu !== null && menu.items.length > 0) pick(menu.active);
				return;
			case "completion_up":
			case "completion_down":
				if (menu === null || menu.items.length === 0) return;
				setMenu({ ...menu, active: Math.min(menu.items.length - 1, Math.max(0, menu.active + (resolved === "completion_up" ? -1 : 1))) });
				return;
			case "escape":
				// Escape unwinds one layer at a time: the menu, then the turn, then the
				// keyboard, which is what a phone expects from a back gesture.
				if (menu !== null) {
					setMenu(null);
					return;
				}
				if (working) {
					actions.abort();
					return;
				}
				textarea.current?.blur();
				return;
			case "kill_to_end":
			case "delete_word":
			case "clear":
			case "caret_start":
			case "caret_end":
				edit(resolved);
				return;
			default:
				return;
		}
	};

	const onKeyDown = (event: KeyboardEvent) => {
		const resolved = chordAction(modifiers, event.key);
		if (resolved === null) {
			// Nothing in the table claims this press, so the character types: the
			// armed modifier was for one chord and does not survive a key it misses.
			if (modifiers.length > 0) setModifiers([]);
			return;
		}
		// The chord took the key, so the phone needs to feel that the press was not
		// a typo: this is the one place a hardware key press buzzes.
		tapFeedback();
		event.preventDefault();
		setModifiers([]);
		runAction(resolved);
	};

	const onModifier = (modifier: ChordModifier) => {
		// A chord holds one modifier, so arming another replaces it, and a second
		// tap on the same one disarms.
		tapFeedback();
		setModifiers(modifiers.includes(modifier) ? [] : [modifier]);
	};

	const onBarKey = (key: string) => {
		const resolved = chordAction(modifiers, key);
		// Every bar key buzzes, chord or character: the strip has no travel under the
		// finger, so the tap is all the confirmation there is.
		tapFeedback();
		setModifiers([]);
		if (resolved !== null) runAction(resolved);
	};

	const onSymbol = (symbol: string) => {
		tapFeedback();
		setModifiers([]);
		const at = composerSelection().end;
		const next = insertText(text, at, symbol);
		setText(next.text);
		moveCaret(next.caret);
	};

	const send = () => {
		if (bash) {
			const command = bashCommand(text);
			if (command !== null) {
				successFeedback();
				actions.bash(command);
			}
			setText("");
			return;
		}
		const trimmed = text.trim();
		if (trimmed === "") return;
		// The turn is off: a double tick is the receipt a phone cannot otherwise give.
		successFeedback();
		stick.current = true;
		actions.sendPrompt(trimmed);
	};

	const finishRename = (commit: boolean) => {
		// Enter, Escape and blur can all land around the same unmount, so the rename
		// is claimed once.
		if (renameDone.current) return;
		renameDone.current = true;
		const name = (renaming ?? "").trim();
		if (commit && name !== "" && name !== title) actions.renameSession(name);
		setRenaming(null);
	};

	const startPress = (message: string) => {
		// The handle is the chip's own, so a second press replacing the ref cannot
		// mark this one as fired or clear its timer by mistake.
		const held = { fired: false, timer: 0 };
		held.timer = window.setTimeout(() => {
			held.fired = true;
			// The promote moves the chip out of the queue, so the phone should feel
			// it happen rather than guess which gesture landed.
			tapFeedback();
			actions.promoteQueued(message);
		}, LONG_PRESS_MS);
		press.current = held;
	};

	const endPress = (entry: { message: string; queue: "steering" | "followUp" }) => {
		const held = press.current;
		press.current = null;
		if (held === null) return;
		window.clearTimeout(held.timer);
		if (held.fired) return;
		actions.removeQueued(entry.message, entry.queue);
	};

	const cancelPress = () => {
		if (press.current === null) return;
		window.clearTimeout(press.current.timer);
		press.current = null;
	};

	// A tap, a scroll and a selection drag all end the hold without copying, which
	// is what keeps those gestures exactly as they are today.
	const cancelCopy = () => {
		if (copyPress.current === null) return;
		window.clearTimeout(copyPress.current);
		copyPress.current = null;
	};

	const copyItem = async (item: TranscriptItem) => {
		const text = copyTextFor(item);
		if (text === null) return;
		try {
			await navigator.clipboard.writeText(text);
		} catch {
			// A clipboard the phone refuses (no permission, no secure origin, no
			// clipboard API at all) is nothing a long press can fix, so the bubble
			// stays as it was: a chip would claim a copy that never happened.
			return;
		}
		successFeedback();
		setCopiedId(item.id);
	};

	const startCopy = (item: TranscriptItem) => {
		// A second press replaces the first handle, so a finger that moved to
		// another bubble copies that one rather than the one it left.
		cancelCopy();
		copyPress.current = window.setTimeout(() => {
			copyPress.current = null;
			void copyItem(item);
		}, LONG_PRESS_MS);
	};

	const submitSteer = (subagentId: string) => {
		const message = steerText.trim();
		if (message !== "") actions.steerSubagent(subagentId, message);
		setSteerText("");
		setSteering(null);
	};

	return (
		<main class="screen chat">
			<header class="bar">
				<div class="bar-row">
					<button type="button" class="btn btn-bar btn-icon" aria-label="Back" onClick={() => actions.showSessions()}>
						<Symbol k="ui.back" />
					</button>
					{renaming === null ? (
						<h1 class="bar-title ellipsis">
							<button
								type="button"
								class="bar-title-btn ellipsis"
								title="Rename the session"
								onClick={() => {
									renameDone.current = false;
									setRenaming(title);
								}}
							>
								{title}
							</button>
						</h1>
					) : (
						<input
							ref={renameBox}
							class="bar-title-input"
							type="text"
							aria-label="Session name"
							value={renaming}
							onInput={(event) => setRenaming(event.currentTarget.value)}
							onKeyDown={(event) => {
								if (event.key === "Enter") finishRename(true);
								else if (event.key === "Escape") finishRename(false);
							}}
							onBlur={() => finishRename(true)}
						/>
					)}
					<button type="button" class="btn btn-bar" onClick={() => actions.showScreen("diff")}>± Diff</button>
					{state.readOnly ? (
						<span class="chip chip-readonly" title="Following a session another omp at the host writes">
							read only
						</span>
					) : (
						<button type="button" class="btn btn-bar btn-icon" aria-label="Hand off" title="Hand off" onClick={() => actions.handOffToHost()}>
							<Symbol k="ui.laptop" />
						</button>
					)}
				</div>
				<StatusLine
					status={state.status}
					subagentCount={state.subagents.length}
					queuedCount={queued.length}
					repoName={folder}
					connection={state.connection}
					todosOpen={state.todosOpen}
					goal={state.status.goal ?? null}
					onPickModel={openModels}
					onPickThinking={() => actions.openSheet("thinking")}
					onToggleTodos={() => actions.toggleTodos()}
					onGoal={() => actions.openSheet("goal")}
				/>
			</header>
			{state.todosOpen ? <TodosPanel todos={state.status.todos ?? []} /> : null}
			{state.connection !== "open" ? <p class="banner">{state.connection === "connecting" ? "connecting…" : "reconnecting…"}</p> : null}
			{error ? <p class="error" role="alert">{error}</p> : null}
			<div class="transcript-wrap">
				<div class="transcript" ref={boxRef} onScroll={onScroll}>
					{state.items.length === 0 && state.connection === "connecting" ? <p class="placeholder"><span class="spin" aria-hidden="true" /> loading session…</p> : null}
					{state.items.length === 0 && state.connection !== "connecting" ? <p class="placeholder">no messages yet · say something below</p> : null}
					{state.items.map((item) => (
						<Bubble
							key={item.id}
							item={item}
							thinkingVisible={state.thinkingVisible}
							toolsOpen={state.toolsOpen}
							copied={copiedId === item.id}
							onPressStart={startCopy}
							onPressEnd={cancelCopy}
						/>
					))}
					{state.subagents.length > 0 ? (
						<section class="agents" aria-label="Subagents">
							<p class="label">agents · {state.subagents.length}</p>
							<ul>
								{state.subagents.map((agent) => (
									<li key={agent.id} class={steering === agent.id ? "agent is-steering" : "agent"}>
										<ToneMark tone={subagentTone(agent.status)} />
										<button
											type="button"
											class="agent-open"
											title={`Steer ${agent.label}`}
											onClick={() => setSteering(steering === agent.id ? null : agent.id)}
										>
											<strong class="agent-label">{agent.label}</strong>
											<span class="agent-status">{agent.status}</span>
											{agent.detail ? <span class="agent-detail">{agent.detail}</span> : null}
										</button>
										{agent.status === "running" ? (
											<button
												type="button"
												class="btn btn-icon agent-cancel"
												aria-label={`Cancel ${agent.label}`}
												title="Cancel this agent"
												onClick={() => actions.cancelSubagent(agent.id)}
											>
												<Symbol k="ui.close" />
											</button>
										) : null}
										{steering === agent.id ? (
											<input
												ref={steerBox}
												class="agent-steer"
												type="text"
												aria-label={`Steer ${agent.label}`}
												placeholder="steer this agent"
												value={steerText}
												onInput={(event) => setSteerText(event.currentTarget.value)}
												onKeyDown={(event) => {
													if (event.key === "Enter") submitSteer(agent.id);
													else if (event.key === "Escape") setSteering(null);
												}}
											/>
										) : null}
									</li>
								))}
							</ul>
						</section>
					) : null}
				</div>
				{atBottom ? null : (
					<button type="button" class="btn btn-icon scroll-down" aria-label="Scroll to latest" onClick={scrollToBottom}>
						<Symbol k="ui.down" />
					</button>
				)}
			</div>
			{queued.length > 0 ? (
				<div class="queued">
					<span class="label">queued</span>
					<ul aria-label="Queued messages">
						{queued.map((entry, index) => (
							// The same message can be queued twice, so the position is part of
							// the identity.
							<li key={`${index}:${entry.queue}:${entry.message}`}>
								<button
									type="button"
									class="chip ellipsis queued-chip"
									title="Tap to remove, hold to promote"
									onPointerDown={() => startPress(entry.message)}
									onPointerUp={() => endPress(entry)}
									onPointerCancel={cancelPress}
									onPointerLeave={cancelPress}
									onContextMenu={(event) => event.preventDefault()}
								>
									{entry.message}
								</button>
							</li>
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
			{state.readOnly ? (
				<ReadOnlyBar session={state.session} onTakeOver={async () => {
					const file = state.session?.sessionFile ?? null;
					if (file !== null) await actions.takeOver(file);
				}} />
			) : (
			<footer class={bash ? "composer is-bash" : "composer"}>
				<div class="prompt">
					<span class="prompt-glyph" aria-hidden="true">❯</span>
					<textarea
						ref={textarea}
						rows={1}
						placeholder="message the agent"
						aria-label="Message the agent"
						value={text}
						onInput={(event) => {
							setText(event.currentTarget.value);
							setCaret(event.currentTarget.selectionStart);
						}}
						onKeyDown={onKeyDown}
						onSelect={syncCaret}
						onClick={syncCaret}
					/>
				</div>
				<KeyBar armed={modifiers} onModifier={onModifier} onKey={onBarKey} onSymbol={onSymbol} />
				{menu !== null && menu.items.length > 0 ? (
					<CompletionMenu
						items={menu.items}
						active={menu.active}
						onPick={pick}
						onHighlight={(index) => setMenu((current) => (current === null ? null : { ...current, active: index }))}
					/>
				) : null}
				<div class="composer-actions">
					{queued.length > 0 ? (
						<button
							type="button"
							class="btn btn-quiet btn-restore"
							title="Put the queue back into the composer"
							onClick={() => actions.restoreQueue()}
						>
							<Symbol k="ui.history" />restore
						</button>
					) : null}
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
			)}
			{state.sheet === "models" ? (
				<PickerSheet
					title="Model"
					items={modelRows(state.models)}
					activeId={state.status.model ? modelId(state.status.model) : null}
					search
					empty={modelsPending ? "loading models…" : state.modelsError ?? "no models"}
					onPick={(item) => {
						const model = state.models.find((candidate) => modelId(candidate) === item.id);
						if (model !== undefined) actions.setModel(model.provider, model.id);
						actions.openSheet(null);
					}}
					onClose={() => actions.openSheet(null)}
				/>
			) : null}
			{state.sheet === "thinking" ? (
				<PickerSheet
					title="Thinking"
					items={state.thinkingLevels.map((level) => ({ id: level, label: level, detail: "", group: "" }))}
					activeId={state.status.thinkingLevel ?? null}
					search={false}
					empty="no thinking levels reported"
					onPick={(item) => {
						actions.setThinking(item.id);
						actions.openSheet(null);
					}}
					onClose={() => actions.openSheet(null)}
				/>
			) : null}
			{state.sheet === "goal" ? (
				<PickerSheet
					title="Goal"
					items={GOAL_ITEMS}
					activeId={null}
					search={false}
					empty="no goal"
					onPick={(item) => {
						if (item.id === "pause" || item.id === "resume" || item.id === "drop") actions.goalAction(item.id);
						actions.openSheet(null);
					}}
					onClose={() => actions.openSheet(null)}
				/>
			) : null}
		</main>
	);
}
