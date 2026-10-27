import { type Attributes, type ComponentType, h, render } from "preact";
import type { AppActions } from "../src/web/lib/app-state";

// Bun test ships no DOM and the repo forbids new dependencies, so the screen tests
// mount through a thumb-sized element shim: just enough of document and Element for
// preact to build a tree we can read text, classes and click handlers back out of.
export class Elm {
	nodeType = 1;
	nodeName = "";
	childNodes: Elm[] = [];
	parentNode: Elm | null = null;
	data = "";
	className = "";
	value = "";
	style: Record<string, string> = {};
	#attrs = new Map<string, string>();
	#listeners = new Map<string, ((event: { type: string; currentTarget: Elm; target: Elm }) => void)[]>();

	get firstChild(): Elm | null {
		return this.childNodes[0] ?? null;
	}

	get nextSibling(): Elm | null {
		const parent = this.parentNode;
		if (parent === null) return null;
		return parent.childNodes[parent.childNodes.indexOf(this) + 1] ?? null;
	}

	get textContent(): string {
		return this.nodeType === 3 ? this.data : this.childNodes.map((child) => child.textContent).join("");
	}

	appendChild<T extends Elm>(child: T): T {
		return this.insertBefore(child, null);
	}

	insertBefore<T extends Elm>(child: T, ref: Elm | null): T {
		if (child.parentNode !== null) child.parentNode.removeChild(child);
		child.parentNode = this;
		if (ref === null) this.childNodes.push(child);
		else {
			const at = this.childNodes.indexOf(ref);
			this.childNodes.splice(at < 0 ? this.childNodes.length : at, 0, child);
		}
		return child;
	}

	removeChild<T extends Elm>(child: T): T {
		const at = this.childNodes.indexOf(child);
		if (at >= 0) this.childNodes.splice(at, 1);
		child.parentNode = null;
		return child;
	}

	remove(): void {
		this.parentNode?.removeChild(this);
	}

	setAttribute(name: string, value: unknown): void {
		this.#attrs.set(name, String(value));
		if (name === "class") this.className = String(value);
	}

	removeAttribute(name: string): void {
		this.#attrs.delete(name);
	}

	getAttribute(name: string): string | null {
		return this.#attrs.get(name) ?? null;
	}

	addEventListener(type: string, listener: (event: { type: string; currentTarget: Elm; target: Elm }) => void): void {
		const listeners = this.#listeners.get(type) ?? [];
		listeners.push(listener);
		this.#listeners.set(type, listeners);
	}

	removeEventListener(type: string, listener: (event: { type: string; currentTarget: Elm; target: Elm }) => void): void {
		this.#listeners.set(type, (this.#listeners.get(type) ?? []).filter((existing) => existing !== listener));
	}

	dispatch(type: string): void {
		// Preact's listener wrapper reads the handler off `this` (the element), so the
		// element has to be the receiver, exactly as a real dispatch would make it.
		for (const listener of this.#listeners.get(type) ?? []) listener.call(this, { type, currentTarget: this, target: this });
	}
}

const dom = {
	createElement: (tag: string): Elm => {
		const el = new Elm();
		el.nodeName = tag.toUpperCase();
		return el;
	},
	createElementNS: (_namespace: string, tag: string): Elm => {
		const el = new Elm();
		el.nodeName = tag.toUpperCase();
		return el;
	},
	createTextNode: (data: string): Elm => {
		const el = new Elm();
		el.nodeType = 3;
		el.data = data;
		return el;
	},
};

/** Mounts one screen with the shim in place, and hands back the tree to read. */
export function mount<P>(view: ComponentType<P>, props: P): Elm {
	(globalThis as unknown as { document: unknown }).document = dom;
	const root = dom.createElement("div");
	// preact's h wants the attributes folded into the props; the screens take plain props.
	render(h(view, props as P & Attributes), root as unknown as Element);
	return root;
}

export function byClass(root: Elm, name: string): Elm[] {
	const found: Elm[] = [];
	const walk = (node: Elm): void => {
		if (node.className.split(/\s+/).includes(name)) found.push(node);
		for (const child of node.childNodes) walk(child);
	};
	walk(root);
	return found;
}

export function stubActions(over: Partial<AppActions> = {}): AppActions {
	// The screen only touches a handful of actions; the rest exist to satisfy the type.
	return new Proxy(over, { get: (target, key) => (key in target ? Reflect.get(target, key) : () => undefined) }) as unknown as AppActions;
}
