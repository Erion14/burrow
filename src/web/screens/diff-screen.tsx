import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import type { ApiErrorBody } from "../../shared/protocol";
import type { DiffFile, DiffResponse } from "../../shared/types";
import { diffLineClass } from "../lib/format";
import type { PickerItem } from "../lib/picker";
import { PickerSheet } from "./picker-sheet";
import type { ScreenProps } from "./props";
import { Sep } from "./status-glyph";
import { Symbol } from "./symbol";
import "./diff-screen.css";

type Load = { phase: "loading" } | { phase: "error"; message: string } | { phase: "ready"; diff: DiffResponse };

/** Past this many files the list is longer than a thumb wants to swipe, so the screen offers the jump list. */
const JUMP_THRESHOLD = 8;

/** How long the copy button holds its "copied" state. */
const COPIED_MS = 1000;

async function fetchDiff(sessionId: string): Promise<Load> {
	try {
		const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/diff`);
		if (!response.ok) {
			const body = (await response.json().catch(() => null)) as ApiErrorBody | null;
			return { phase: "error", message: body?.error?.message ?? `Diff failed (${response.status})` };
		}
		return { phase: "ready", diff: (await response.json()) as DiffResponse };
	} catch (err) {
		return { phase: "error", message: err instanceof Error ? err.message : "Could not load the diff" };
	}
}

/** The one line the jump list shows under a path. */
function fileDetail(file: DiffFile): string {
	return `${file.status} +${file.additions} -${file.deletions}`;
}

function CopyPath({ path }: { path: string }) {
	const [copied, setCopied] = useState(false);

	useEffect(() => {
		if (!copied) return;
		const timer = setTimeout(() => setCopied(false), COPIED_MS);
		return () => clearTimeout(timer);
	}, [copied]);

	const copy = async () => {
		try {
			await navigator.clipboard.writeText(path);
			setCopied(true);
		} catch {
			// A clipboard the phone refuses (no permission, no secure origin, no
			// clipboard API at all) is nothing this button can fix, so it says
			// nothing rather than claim a copy that never happened.
		}
	};

	return (
		<button
			type="button"
			class={copied ? "diff-copy is-copied" : "diff-copy"}
			title={copied ? "copied" : "Copy path"}
			aria-label={copied ? "Path copied" : `Copy path ${path}`}
			onClick={(event) => {
				// The button sits inside the summary, so without this the tap would
				// fold the very file whose path it is copying.
				event.preventDefault();
				event.stopPropagation();
				void copy();
			}}
		>
			{copied ? "copied" : <Symbol k="ui.copy" />}
		</button>
	);
}

function FileDiff({
	file,
	open,
	onOpenChange,
	register,
}: {
	file: DiffFile;
	open: boolean;
	onOpenChange(open: boolean): void;
	register(path: string, node: HTMLDetailsElement | null): void;
}) {
	return (
		<details
			class="diff-file"
			open={open}
			ref={(node) => register(file.path, node)}
			onToggle={(event) => onOpenChange(event.currentTarget.open)}
		>
			<summary class="diff-head">
				<Symbol k="ui.collapsed" class="chev" />
				<span class="diff-path">{file.path}</span>
				<CopyPath path={file.path} />
				<span class={`chip chip-${file.status}`}>{file.status}</span>
				<span class="diff-add-count">+{file.additions}</span>
				<span class="diff-del-count">-{file.deletions}</span>
			</summary>
			{/* A folded file keeps its body out of the DOM: a long diff is thousands of
			    line spans, and the open attribute already records that it is folded. */}
			{open ? (
				file.binary ? (
					<p class="diff-note">binary file changed</p>
				) : file.unified === "" ? (
					<p class="diff-note">no textual changes</p>
				) : (
					<pre class="diff-body">
						{file.unified.split("\n").map((line, index) => {
							const kind = diffLineClass(line);
							const hunk = kind === "diff-hunk";
							return (
								<span key={index} class={`diff-line ${kind}`}>
									<span class="diff-gutter">{hunk ? "" : line.slice(0, 1)}</span>
									<span class="diff-code">{(hunk ? line : line.slice(1)) || " "}</span>
								</span>
							);
						})}
					</pre>
				)
			) : null}
		</details>
	);
}

export function DiffScreen({ state, actions }: ScreenProps) {
	const [load, setLoad] = useState<Load>({ phase: "loading" });
	// The folded files, not the open ones: a diff arrives expanded as it always
	// did, and a refresh leaves the files you folded shut folded.
	const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set<string>());
	const [jumping, setJumping] = useState(false);
	const [scrollTo, setScrollTo] = useState<string | null>(null);
	const sessionId = state.sessionId;
	const nodes = useRef(new Map<string, HTMLDetailsElement>());
	const files = load.phase === "ready" ? load.diff.files : [];
	const additions = files.reduce((sum, file) => sum + file.additions, 0);
	const deletions = files.reduce((sum, file) => sum + file.deletions, 0);
	const jumpItems: PickerItem[] = files.map((file) => ({
		id: file.path,
		label: file.path,
		detail: fileDetail(file),
		group: file.status,
	}));

	const refresh = async () => {
		if (sessionId === null) return;
		setLoad({ phase: "loading" });
		setLoad(await fetchDiff(sessionId));
	};

	useEffect(() => {
		let cancelled = false;
		if (sessionId === null) return;
		void fetchDiff(sessionId).then((next) => {
			if (!cancelled) setLoad(next);
		});
		return () => {
			cancelled = true;
		};
	}, [sessionId]);

	useEffect(() => {
		if (scrollTo === null) return;
		// The picked file was expanded in the same commit as this effect, so the
		// scroll lands with its diff open and does not move again afterwards.
		nodes.current.get(scrollTo)?.scrollIntoView({ block: "start" });
		setScrollTo(null);
	}, [scrollTo]);

	const register = useCallback((path: string, node: HTMLDetailsElement | null) => {
		if (node === null) nodes.current.delete(path);
		else nodes.current.set(path, node);
	}, []);

	const setFileOpen = (path: string, open: boolean) => {
		setCollapsed((prev) => {
			if (prev.has(path) === !open) return prev;
			const next = new Set(prev);
			if (open) next.delete(path);
			else next.add(path);
			return next;
		});
	};

	// A bulk button keeps the state it already has when it has nothing to do: a few
	// hundred files is tens of thousands of line spans, and re-rendering all of
	// them for a tap that changes nothing is a stall you can feel.
	const setAllOpen = (open: boolean) => {
		setCollapsed((prev) => {
			if (open) return prev.size === 0 ? prev : new Set<string>();
			if (files.every((file) => prev.has(file.path))) return prev;
			return new Set(files.map((file) => file.path));
		});
	};

	const jumpTo = (item: PickerItem) => {
		setFileOpen(item.id, true);
		setScrollTo(item.id);
		setJumping(false);
	};

	return (
		<main class="screen diff-screen">
			<header class="bar">
				<div class="bar-row">
					<button type="button" class="btn btn-bar btn-icon" aria-label="Back" onClick={() => actions.showScreen("chat")}>
						<Symbol k="ui.back" />
					</button>
					<h1 class="bar-title ellipsis">changes</h1>
					<button type="button" class="btn btn-bar btn-icon" aria-label="Refresh" title="Refresh" disabled={load.phase === "loading"} onClick={() => void refresh()}>
						<Symbol k="ui.refresh" />
					</button>
				</div>
				<div class="statusline">
					{load.phase === "loading" && sessionId !== null ? <span class="seg-count"><span class="spin" aria-hidden="true" /> loading</span> : null}
					{load.phase === "ready" ? (
						<>
							<span class="seg-count">{files.length} {files.length === 1 ? "file" : "files"}</span>
							<Sep />
							<span class="diff-add-count">+{additions}</span>
							<span class="diff-del-count">-{deletions}</span>
						</>
					) : null}
					{state.session ? <span class="chip chip-repo ellipsis">{state.session.repoName}</span> : null}
				</div>
			</header>
			{files.length > 0 ? (
				<div class="diff-controls">
					<button type="button" class="diff-control" onClick={() => setAllOpen(true)}>expand all</button>
					<button type="button" class="diff-control" onClick={() => setAllOpen(false)}>collapse all</button>
					{/* The jump list is the one control a narrow row can push off, so it takes
					    the free space and trails the pair. */}
					{files.length > JUMP_THRESHOLD ? (
						<button type="button" class="diff-control diff-jump" onClick={() => setJumping(true)}>
							<Symbol k="ui.list" />
							jump to file
						</button>
					) : null}
				</div>
			) : null}
			{sessionId === null ? <p class="placeholder">no session selected</p> : null}
			{load.phase === "loading" && sessionId !== null ? <p class="placeholder"><span class="spin" aria-hidden="true" /> loading diff…</p> : null}
			{load.phase === "error" ? <p class="error" role="alert">{load.message}</p> : null}
			{load.phase === "ready" && load.diff.notice ? (
				<section class="diff-notice">
					<p class="label">notice</p>
					<p>{load.diff.notice}</p>
				</section>
			) : null}
			{load.phase === "ready" && load.diff.files.length === 0 ? <p class="placeholder">✓ no changes · the working tree is clean</p> : null}
			{files.map((file) => (
				<FileDiff
					key={file.path}
					file={file}
					open={!collapsed.has(file.path)}
					register={register}
					onOpenChange={(open) => setFileOpen(file.path, open)}
				/>
			))}
			{load.phase === "ready" && load.diff.truncated ? <p class="banner">diff truncated · showing the first part only</p> : null}
			{jumping ? (
				<PickerSheet
					title="jump to file"
					items={jumpItems}
					activeId={null}
					search={false}
					empty="no files"
					onPick={jumpTo}
					onClose={() => setJumping(false)}
				/>
			) : null}
		</main>
	);
}
