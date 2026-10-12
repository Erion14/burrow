import { BurrowMark, PowerIcon } from "./icons";

export function RemoteOffView({ onTurnOn, error, busy }: { onTurnOn: () => void; error: string | null; busy: boolean }) {
	return (
		<main class="screen center-screen">
			<section class="panel off-panel">
				<p class="panel-title">burrow</p>
				<BurrowMark class="off-mark" />
				<h1 class="off-state">remote is <span class="off-word">OFF</span></h1>
				<p class="panel-detail">Burrow is not running on the laptop. Turn ON wakes it up, then your sessions and agents show up here.</p>
				{error ? <p class="error" role="alert">{error}</p> : null}
				<button type="button" class="btn btn-primary big-btn" disabled={busy} onClick={onTurnOn}>
					{busy ? <><span class="spin" aria-hidden="true" /> turning on…</> : <><PowerIcon />Turn ON</>}
				</button>
			</section>
		</main>
	);
}
