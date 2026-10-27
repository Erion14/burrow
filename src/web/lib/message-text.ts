// What a long press on a transcript bubble puts on the clipboard. Pure, because
// the shapes omp reports decide this: a card with no output yet, a notice nobody
// wants pasted, an assistant turn whose thinking the phone may be hiding.

import type { TranscriptItem } from "../../shared/types";

/** Blank fields are dropped so an empty thinking block never pastes as a gap. */
function join(parts: readonly (string | undefined)[]): string | null {
	const present = parts.filter((part): part is string => part !== undefined && part.trim() !== "");
	return present.length === 0 ? null : present.join("\n\n");
}

/**
 * The text worth putting on the clipboard for one transcript item, or null when
 * the item carries nothing a paste should carry.
 */
export function copyTextFor(item: TranscriptItem): string | null {
	switch (item.kind) {
		case "user":
			return join([item.text]);
		case "assistant":
			// Thinking is part of what the turn produced, so a paste that dropped it
			// would lose reasoning the phone chose not to show.
			return join([item.text, item.thinking]);
		case "tool": {
			// The card's own summary line, the tool and its arguments, then whatever
			// output the server bounded for it.
			const tool = item.tool;
			if (tool === undefined) return null;
			return join([tool.args === "" ? tool.name : `${tool.name} ${tool.args}`, tool.output]);
		}
		case "bash":
			// `text` is the output tail; it is empty while the command still runs.
			return item.bash === undefined ? null : join([item.bash.command, item.text]);
		case "notice":
			return null;
	}
}
