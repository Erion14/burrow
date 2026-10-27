// One sheet for every picker on the phone (models, thinking levels, commands).
// It is presentation only: the rows, the group headers and the match rule come
// from lib/picker.ts, and every tap is reported to the parent. The sheet holds
// the query, because a query belongs to the sheet that is open, not to the
// screen: closing a picker and opening another starts from the full list.

import { Fragment } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { type PickerItem, filterPickerItems, groupPickerItems } from "../lib/picker";
import { Symbol } from "./symbol";
import "./picker-sheet.css";

export interface PickerSheetProps {
	title: string;
	items: readonly PickerItem[];
	/** The row the picker is currently on, marked with a check. */
	activeId: string | null;
	/** Whether the list is long enough to want a filter field. */
	search: boolean;
	/** Shown in place of the rows when the query matches nothing. */
	empty: string;
	onPick(item: PickerItem): void;
	onClose(): void;
}

export function PickerSheet({ title, items, activeId, search, empty, onPick, onClose }: PickerSheetProps) {
	const [query, setQuery] = useState("");
	const panel = useRef<HTMLDivElement>(null);
	const searchBox = useRef<HTMLInputElement>(null);
	const groups = groupPickerItems(filterPickerItems(items, query));

	useEffect(() => {
		// A search sheet wants the field: focusing it raises the phone keyboard and
		// the list narrows as you type. A list sheet takes focus on the panel, so
		// Escape closes the sheet instead of reaching the composer's chord table.
		if (search) searchBox.current?.focus();
		else panel.current?.focus();
	}, [search]);

	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") onClose();
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [onClose]);

	return (
		<div class="picker-backdrop" onClick={onClose}>
			<div
				class="picker-sheet"
				role="dialog"
				aria-modal="true"
				aria-label={title}
				tabIndex={-1}
				ref={panel}
				// A tap inside the sheet, including on the scrollbar of its list, is
				// not a tap on the backdrop and must not close it.
				onClick={(event) => event.stopPropagation()}
			>
				<div class="picker-head">
					<h2 class="picker-title">{title}</h2>
					<button type="button" class="picker-close" title="Close" aria-label="Close" onClick={onClose}>
						<Symbol k="ui.close" />
					</button>
				</div>
				{search ? (
					<div class="picker-search">
						<Symbol k="ui.search" />
						<input
							ref={searchBox}
							class="picker-input"
							type="text"
							value={query}
							placeholder="Filter"
							aria-label={`Filter ${title}`}
							autocapitalize="off"
							autocomplete="off"
							autocorrect="off"
							spellcheck={false}
							onInput={(event) => setQuery(event.currentTarget.value)}
						/>
					</div>
				) : null}
				{groups.length === 0 ? (
					<p class="picker-empty">{empty}</p>
				) : (
					<div class="picker-list">
						{groups.map((part) => (
							<Fragment key={part.group}>
								{/* An ungrouped item reports an empty group, which is not a header. */}
								{part.group === "" ? null : <p class="picker-group">{part.group}</p>}
								{part.items.map((item) => (
									<button
										key={item.id}
										type="button"
										class={item.id === activeId ? "picker-row is-active" : "picker-row"}
										aria-current={item.id === activeId ? "true" : undefined}
										onClick={() => onPick(item)}
									>
										<Symbol k="status.done" class="picker-check" />
										<span class="picker-label ellipsis">{item.label}</span>
										{item.detail === "" ? null : <span class="picker-detail ellipsis">{item.detail}</span>}
									</button>
								))}
							</Fragment>
						))}
					</div>
				)}
			</div>
		</div>
	);
}
