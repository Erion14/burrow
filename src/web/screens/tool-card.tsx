import type { ToolCard as ToolCardData } from "../../shared/types";
import { toolDuration, toolStatusLabel } from "../lib/format";

/** Output is already a bounded tail from the server; the card scrolls it instead of growing the page. */
export function ToolCard({ tool }: { tool: ToolCardData }) {
	const duration = toolDuration(tool.durationMs);
	return (
		<details class={`tool tool-${tool.status}`}>
			<summary>
				<span class={`tool-mark tone-${tool.status}`} role="img" aria-label={toolStatusLabel(tool.status)} title={toolStatusLabel(tool.status)} />
				<strong class="tool-name">{tool.name}</strong>
				<span class="tool-args">{tool.args}</span>
				{duration ? <span class="tool-time">{duration}</span> : null}
				<span class="chev" aria-hidden="true" />
			</summary>
			<pre class="tool-out">{tool.output || "(no output)"}</pre>
		</details>
	);
}
