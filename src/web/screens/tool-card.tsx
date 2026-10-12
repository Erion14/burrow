import type { ToolCard as ToolCardData } from "../../shared/types";
import { toolStatusLabel } from "../lib/format";

/** Output is already a bounded tail from the server; the card scrolls it instead of growing the page. */
export function ToolCard({ tool }: { tool: ToolCardData }) {
	return (
		<details class={`tool tool-${tool.status}`}>
			<summary>
				<strong>{tool.name}</strong>
				<span class="tool-args">{tool.args}</span>
				<span class={`tool-status tool-status-${tool.status}`}>{toolStatusLabel(tool.status)}</span>
			</summary>
			<pre class="mono">{tool.output || "(no output)"}</pre>
		</details>
	);
}
