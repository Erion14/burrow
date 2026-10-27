import type { ToolCard as ToolCardData } from "../../shared/types";
import { toolDuration, toolStatusLabel } from "../lib/format";
import { toolSymbol } from "../lib/symbols";
import { ToneMark } from "./status-glyph";
import { Symbol } from "./symbol";

/**
 * Output is already a bounded tail from the server; the card scrolls it instead
 * of growing the page. `open` is the composer's expand-all switch: undefined
 * leaves the card to the user's own taps, which is why it is not a boolean.
 */
export function ToolCard({ tool, open }: { tool: ToolCardData; open?: boolean }) {
	const duration = toolDuration(tool.durationMs);
	return (
		<details class={`tool tool-${tool.status}`} open={open}>
			<summary>
				<Symbol k={toolSymbol(tool.name)} />
				<strong class="tool-name">{tool.name}</strong>
				<span class="tool-args">{tool.args}</span>
				{duration ? <span class="tool-time">{duration}</span> : null}
				<ToneMark tone={tool.status} label={toolStatusLabel(tool.status)} />
				<Symbol k="ui.collapsed" class="chev" />
			</summary>
			<pre class="tool-out">{tool.output || "(no output)"}</pre>
		</details>
	);
}
