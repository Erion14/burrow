import { useEffect, useState } from "preact/hooks";
import type { ApiErrorBody } from "../../shared/protocol";
import type { DiffFile, DiffResponse } from "../../shared/types";
import { diffLineClass } from "../lib/format";
import { BackIcon, RefreshIcon } from "./icons";
import type { ScreenProps } from "./props";
import { Sep } from "./status-glyph";

type Load = { phase: "loading" } | { phase: "error"; message: string } | { phase: "ready"; diff: DiffResponse };

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

function FileDiff({ file }: { file: DiffFile }) {
	const [open, setOpen] = useState(true);
	return (
		<section class="diff-file">
			<button type="button" class="diff-head" aria-expanded={open} onClick={() => setOpen(!open)}>
				<span class="chev" aria-hidden="true" />
				<span class="diff-path">{file.path}</span>
				<span class={`chip chip-${file.status}`}>{file.status}</span>
				<span class="diff-add-count">+{file.additions}</span>
				<span class="diff-del-count">-{file.deletions}</span>
			</button>
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
		</section>
	);
}

export function DiffScreen({ state, actions }: ScreenProps) {
	const [load, setLoad] = useState<Load>({ phase: "loading" });
	const sessionId = state.sessionId;

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

	const files = load.phase === "ready" ? load.diff.files : [];
	const additions = files.reduce((sum, file) => sum + file.additions, 0);
	const deletions = files.reduce((sum, file) => sum + file.deletions, 0);

	return (
		<main class="screen diff-screen">
			<header class="bar">
				<div class="bar-row">
					<button type="button" class="btn btn-bar btn-icon" aria-label="Back" onClick={() => actions.showScreen("chat")}>
						<BackIcon />
					</button>
					<h1 class="bar-title ellipsis">changes</h1>
					<button type="button" class="btn btn-bar btn-icon" aria-label="Refresh" title="Refresh" disabled={load.phase === "loading"} onClick={() => void refresh()}>
						<RefreshIcon />
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
			{files.map((file) => <FileDiff key={file.path} file={file} />)}
			{load.phase === "ready" && load.diff.truncated ? <p class="banner">diff truncated · showing the first part only</p> : null}
		</main>
	);
}
