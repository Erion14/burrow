// The picker sheet (models, thinking levels, commands) is presentation only, so
// the two decisions worth testing live here: how a query narrows the rows and
// how rows fold under group headers. Both preserve the order omp reported the
// items in, because that order is the ranking (the server already sorted the
// file menu, and a model list reads best in the order the provider registry has
// it), and a client side re-sort would silently drop that ranking.

export interface PickerItem {
	id: string;
	label: string;
	detail: string;
	/** Empty when the source has no grouping; the sheet then draws no header. */
	group: string;
}

export interface PickerGroup {
	group: string;
	items: PickerItem[];
}

/** Case-insensitive over the label and the detail line. An empty query keeps the list. */
export function filterPickerItems(items: readonly PickerItem[], query: string): PickerItem[] {
	const needle = query.trim().toLowerCase();
	if (needle === "") return [...items];
	return items.filter(
		(item) => item.label.toLowerCase().includes(needle) || item.detail.toLowerCase().includes(needle),
	);
}

/**
 * Folds the rows under their group headers. The groups keep first appearance
 * order, so filtering a list does not reshuffle the headers, and an interleaved
 * list groups without reordering the rows inside a group.
 */
export function groupPickerItems(items: readonly PickerItem[]): PickerGroup[] {
	// A Map, not an object: group names come from omp (provider names, phases), so
	// "constructor" is a legal header, and Map's insertion order is the guarantee
	// this function sells.
	const groups = new Map<string, PickerItem[]>();
	for (const item of items) {
		const bucket = groups.get(item.group);
		if (bucket === undefined) groups.set(item.group, [item]);
		else bucket.push(item);
	}
	return [...groups].map(([group, groupItems]) => ({ group, items: groupItems }));
}
