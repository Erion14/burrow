// The chord table is the phone's whole mapping from a key press to an omp
// action, and the key bar is the only way to send the chords and characters the
// on screen keyboard hides. The bar is presentation only, so these tests pin
// what a tap reports; the parent decides what the chord then does.

import { describe, expect, test } from "bun:test";
import { KeyBar } from "../screens/key-bar";
import { type ChordAction, type ChordModifier, chordAction } from "./keys";

/** Every chord of the phase 1.5 table, in the order the plan lists them. */
const SPEC_CHORDS: readonly (readonly [ChordModifier | null, string, ChordAction])[] = [
	["ctrl", "c", "abort"],
	["ctrl", "p", "models"],
	["ctrl", "t", "thinking_blocks"],
	["ctrl", "o", "tools_expand"],
	["ctrl", "a", "caret_start"],
	["ctrl", "e", "caret_end"],
	["ctrl", "k", "kill_to_end"],
	["ctrl", "u", "clear"],
	["ctrl", "l", "clear"],
	["ctrl", "w", "delete_word"],
	["shift", "Tab", "thinking_cycle"],
	["alt", "ArrowUp", "dequeue"],
	[null, "Tab", "accept_completion"],
	[null, "ArrowUp", "completion_up"],
	[null, "ArrowDown", "completion_down"],
	[null, "Escape", "escape"],
];

/** The symbol row exists for the characters the Samsung keyboard buries. */
const SPEC_SYMBOLS: readonly string[] = [
	"`", "~", "|", "$", "&", "*", "%", "^", "_", "=", "+", "-",
	"[", "]", "{", "}", "(", ")", "<", ">", "/", "\\", "@", "#",
	"!", "?", ":", ";", "'", '"', ".", ",",
];

const SPEC_KEYS: readonly string[] = ["Escape", "Tab", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"];

const ARMED: readonly ChordModifier[] = ["ctrl", "alt", "shift"];

describe("chordAction", () => {
	for (const [modifier, key, action] of SPEC_CHORDS) {
		const name = modifier === null ? key : `${modifier}+${key}`;
		test(`${name} is ${action}`, () => {
			expect(chordAction(modifier === null ? [] : [modifier], key)).toBe(action);
		});
	}

	test("a letter chord resolves in either case", () => {
		for (const [modifier, key, action] of SPEC_CHORDS) {
			if (key.length !== 1 || key === "c") continue;
			expect(chordAction(modifier === null ? [] : [modifier], key.toUpperCase())).toBe(action);
		}
		expect(chordAction(["ctrl"], "C")).toBe("abort");
	});

	test("an extra modifier leaves the key press to the composer", () => {
		expect(chordAction(["ctrl", "shift"], "c")).toBeNull();
		expect(chordAction(["shift", "ctrl"], "c")).toBeNull();
		expect(chordAction(["ctrl", "alt"], "c")).toBeNull();
	});

	test("a modifier with an unlisted key leaves the key press to the composer", () => {
		expect(chordAction(["ctrl"], "h")).toBeNull();
		expect(chordAction(["ctrl"], "ArrowUp")).toBeNull();
		expect(chordAction(["alt"], "ArrowDown")).toBeNull();
		expect(chordAction(["shift"], "Tab")).toBe("thinking_cycle");
		expect(chordAction(["shift"], "ArrowUp")).toBeNull();
		expect(chordAction(["ctrl"], "Escape")).toBeNull();
	});

	test("a bare letter types normally", () => {
		expect(chordAction([], "a")).toBeNull();
		expect(chordAction([], "C")).toBeNull();
		expect(chordAction([], "1")).toBeNull();
		expect(chordAction([], "ArrowLeft")).toBeNull();
		expect(chordAction([], "Unidentified")).toBeNull();
	});

	test("a bare Tab and the completion arrows keep their actions", () => {
		expect(chordAction([], "Tab")).toBe("accept_completion");
		expect(chordAction([], "ArrowUp")).toBe("completion_up");
		expect(chordAction([], "ArrowDown")).toBe("completion_down");
	});
});

interface VNode {
	type: unknown;
	props: Record<string, unknown>;
}

/** Walks the vnode tree the component returns, so the test needs no DOM. */
function elementsOf(node: unknown, found: VNode[] = []): VNode[] {
	if (node === null || node === undefined || typeof node === "boolean") return found;
	if (typeof node === "string" || typeof node === "number") return found;
	if (Array.isArray(node)) {
		for (const child of node) elementsOf(child, found);
		return found;
	}
	const vnode = node as VNode;
	if (typeof vnode.type === "function") return elementsOf(vnode.type(vnode.props), found);
	if (vnode.type !== undefined) found.push(vnode);
	elementsOf(vnode.props.children, found);
	return found;
}

function tap(button: VNode): void {
	(button.props.onClick as () => void)();
}

function labelOf(button: VNode): string {
	return String(button.props.children);
}

function classOf(button: VNode): string {
	return String(button.props.class);
}

/** The vnodes that are actually <button>; the groups around them are divs. */
function keyButtons(elements: readonly VNode[]): VNode[] {
	return elements.filter((element) => element.type === "button");
}

function renderBar(armed: readonly ChordModifier[] = [], disabled = false) {
	const modifiers: ChordModifier[] = [];
	const keys: string[] = [];
	const symbols: string[] = [];
	const tree = KeyBar({
		armed,
		onModifier: (modifier) => modifiers.push(modifier),
		onKey: (key) => keys.push(key),
		onSymbol: (text) => symbols.push(text),
		disabled,
	});
	return { elements: elementsOf(tree), modifiers, keys, symbols };
}

const modButtons = (elements: readonly VNode[]): VNode[] => keyButtons(elements).filter((button) => classOf(button).includes("key-mod"));

describe("KeyBar", () => {
	test("every key is a real tap target", () => {
		const keys = keyButtons(renderBar().elements);
		expect(keys.length).toBe(ARMED.length + SPEC_KEYS.length + SPEC_SYMBOLS.length);
		for (const button of keys) {
			expect(button.props.type).toBe("button");
			expect(button.props.disabled).toBe(false);
		}
	});

	test("the modifiers latch and report their own modifier", () => {
		const { elements, modifiers } = renderBar(ARMED);
		const mods = modButtons(elements);
		expect(mods.map(labelOf)).toEqual(["Ctrl", "Alt", "Shift"]);
		expect(mods.map((button) => button.props["aria-pressed"])).toEqual([true, true, true]);
		for (const button of mods) tap(button);
		expect(modifiers).toEqual(["ctrl", "alt", "shift"]);

		const off = modButtons(renderBar(["shift"]).elements);
		expect(off.map((button) => button.props["aria-pressed"])).toEqual([false, false, true]);
	});

	test("a modifier title names every chord it arms", () => {
		const mods = modButtons(renderBar().elements).map((button) => String(button.props.title));
		const [ctrl, alt, shift] = mods;
		for (const chord of ["Ctrl+C abort", "Ctrl+P models", "Ctrl+T thinking blocks", "Ctrl+O tools expand", "Ctrl+A caret start", "Ctrl+E caret end", "Ctrl+K kill to end", "Ctrl+U clear", "Ctrl+L clear", "Ctrl+W delete word"]) {
			expect(ctrl).toContain(chord);
		}
		expect(shift).toBe("Shift+Tab thinking cycle");
		expect(alt).toBe("Alt+ArrowUp dequeue");
	});

	test("Esc, Tab, and the four arrows report their KeyboardEvent.key", () => {
		const { elements, keys } = renderBar();
		const fixed = keyButtons(elements).filter((button) => classOf(button).includes("key-fixed"));
		expect(fixed.map(labelOf)).toEqual(["Esc", "Tab", "\u2191", "\u2193", "\u2190", "\u2192"]);
		for (const button of fixed) tap(button);
		expect(keys).toEqual([...SPEC_KEYS]);
	});

	test("every symbol key reports exactly its character", () => {
		const { elements, symbols } = renderBar();
		const row = keyButtons(elements).filter((button) => classOf(button).includes("key-sym"));
		expect(row.map(labelOf)).toEqual([...SPEC_SYMBOLS]);
		for (const button of row) tap(button);
		expect(symbols).toEqual([...SPEC_SYMBOLS]);
	});

	test("disabled reaches every key", () => {
		for (const button of keyButtons(renderBar([], true).elements)) expect(button.props.disabled).toBe(true);
		for (const button of keyButtons(renderBar().elements)) expect(button.props.disabled).toBe(false);
	});
});
