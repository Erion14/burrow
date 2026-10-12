import { useEffect, useState } from "preact/hooks";
import type { ApiErrorBody } from "../../shared/protocol";
import type { DiffFile, DiffResponse } from "../../shared/types";
import { diffLineClass } from "../lib/format";
import type { ScreenProps } from "./props";

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
				<span class="diff-path">{file.path}</span>
				<span class={`chip chip-${file.status}`}>{file.status}</span>
				<span class="diff-add-count">+{file.additions}</span>
				<span class="diff-del-count">-{file.deletions}</span>
			</button>
			{open ? (
				file.binary ? (
					<p class="muted diff-note">binary file changed</p>
				) : file.unified === "" ? (
					<p class="muted diff-note">No textual changes.</p>
				) : (
					<pre class="diff-body">
						{file.unified.split("\n").map((line, index) => (
							<span key={index} class={`diff-line ${diffLineClass(line)}`}>{line === "" ? " " : line}{"\n"}</span>
						))}
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

	return (
		<main class="screen">
			<header class="bar">
				<button type="button" class="btn" onClick={() => actions.showScreen("chat")}>Back</button>
				<h1 class="ellipsis">Changes{state.session ? ` · ${state.session.repoName}` : ""}</h1>
				<span class="spacer" />
				<button type="button" class="btn" disabled={load.phase === "loading"} onClick={() => void refresh()}>Refresh</button>
			</header>
			{sessionId === null ? <p class="muted center">No session selected.</p> : null}
			{load.phase === "loading" && sessionId !== null ? <p class="muted center">Loading diff...</p> : null}
			{load.phase === "error" ? <p class="error" role="alert">{load.message}</p> : null}
			{load.phase === "ready" && load.diff.files.length === 0 ? <p class="muted center">No changes.</p> : null}
			{load.phase === "ready" ? load.diff.files.map((file) => <FileDiff key={file.path} file={file} />) : null}
			{load.phase === "ready" && load.diff.truncated ? <p class="banner">Diff truncated. Showing the first part only.</p> : null}
		</main>
	);
}
