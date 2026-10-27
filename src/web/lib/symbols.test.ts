import { describe, expect, test } from "bun:test";
import { fileSymbol, toolSymbol } from "./symbols";

describe("toolSymbol", () => {
	test("maps omp tool names to the mark their card wears", () => {
		expect(toolSymbol("bash")).toBe("item.bash");
		expect(toolSymbol("grep")).toBe("ui.search");
	});

	test("a tool the table does not know gets the generic code mark", () => {
		expect(toolSymbol("hologram")).toBe("ui.code");
	});
});

describe("fileSymbol", () => {
	test("a directory is a folder whatever its extension suggests", () => {
		expect(fileSymbol("src/web", true)).toBe("item.folder");
	});

	test("a dotfile counts as having no extension, so it keeps the plain file mark", () => {
		expect(fileSymbol(".gitignore", false)).toBe("item.file");
		expect(fileSymbol("src/.gitignore", false)).toBe("item.file");
	});

	test("only the basename decides the extension, so a dot in a directory name means nothing", () => {
		expect(fileSymbol("src/burrow.io/notes", false)).toBe("item.file");
		expect(fileSymbol("v1.2/main", false)).toBe("item.file");
	});

	test("an unknown extension falls back to the plain file mark", () => {
		expect(fileSymbol("notes.xyz", false)).toBe("item.file");
	});

	test("a known extension picks its file type", () => {
		expect(fileSymbol("src/web/screens/tool-card.tsx", false)).toBe("file.react");
		expect(fileSymbol("README.md", false)).toBe("item.markdown");
		expect(fileSymbol("prod.env", false)).toBe("file.config");
	});
});
