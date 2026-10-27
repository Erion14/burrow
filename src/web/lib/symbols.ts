// One table for every glyph the phone draws, mirroring omp's "nerd" symbol
// preset: codicons for chrome and status, devicons and seti icons for tool
// cards and the file menu, braille frames for the working spinner. The bundled
// font (src/web/fonts, JetBrainsMono Nerd Font Mono subset) carries exactly
// these codepoints, so a glyph here always renders on the phone. Screens read
// symbols through this module only, never with a raw literal, so a swap to
// omp's unicode preset would be a one file change.

export const SYMBOLS = {
	// session and tool state
	"status.working": "\u280B", // braille frame 1; the CSS spin animation cycles the frames
	"status.idle": "\uEB8A", // cod-circle_small_filled
	"status.needs_answer": "\uEAA2", // cod-bell
	"status.stopped": "\uEC07", // cod-circle_small
	"status.done": "\uEAB2", // cod-check
	"status.error": "\uEA87", // cod-error
	"status.warning": "\uEA6C", // cod-warning
	"status.info": "\uEA74", // cod-info

	// chrome
	"ui.back": "\uEA9B", // cod-arrow_left
	"ui.collapsed": "\uEAB6", // cod-chevron_right
	"ui.expanded": "\uEAB4", // cod-chevron_down
	"ui.up": "\uEAB7", // cod-chevron_up
	"ui.down": "\uEA9A", // cod-arrow_down
	"ui.laptop": "\uF109", // fa-laptop
	"ui.power": "\uF011", // fa-power_off
	"ui.refresh": "\uEB37", // cod-refresh
	"ui.send": "\uEC0F", // cod-send
	"ui.copy": "\uEBCC", // cod-copy
	"ui.menu": "\uEB10", // cod-kebab_vertical
	"ui.close": "\uEA76", // cod-close
	"ui.add": "\uEA60", // cod-add
	"ui.remove": "\uEB3B", // cod-remove
	"ui.search": "\uEA6D", // cod-search
	"ui.sort": "\uEB55", // cod-sort_precedence
	"ui.filter": "\uEAF1", // cod-filter
	"ui.list": "\uEB17", // cod-list_unordered
	"ui.globe": "\uEB01", // cod-globe
	"ui.link": "\uEB36", // cod-references
	"ui.clock": "\uEC75", // cod-clockface
	"ui.history": "\uEA82", // cod-history
	"ui.star": "\uF005", // fa-star
	"ui.sparkle": "\uEC10", // cod-sparkle
	"ui.guard": "\uEB53", // cod-shield
	"ui.law": "\uEB12", // cod-law
	"ui.pulse": "\uEB31", // cod-pulse
	"ui.fire": "\uF06D", // fa-fire
	"ui.eye": "\uEA70", // cod-eye
	"ui.eye_closed": "\uEAE7", // cod-eye_closed
	"ui.lock": "\uEA75", // cod-lock
	"ui.code": "\uEAC4", // cod-code
	"ui.edit": "\uEA73", // cod-edit
	"ui.image": "\uEAEA", // cod-file_media
	"ui.browser": "\uEAAE", // cod-browser

	// status line segments
	"seg.model": "\uF2DB", // fa-microchip
	"seg.thinking": "\uEA61", // cod-lightbulb
	"seg.context": "\uEACE", // cod-database
	"seg.subagents": "\uEB08", // cod-hubot
	"seg.repo": "\uEA62", // cod-repo
	"seg.branch": "\uEC6F", // cod-git_branch
	"seg.goal": "\uEBF8", // cod-target
	"seg.todos": "\uEAB3", // cod-checklist
	"seg.queue": "\uEB67", // cod-tasklist
	"seg.session": "\uEA6B", // cod-comment

	// transcript items
	"item.file": "\uEA7B", // cod-file
	"item.folder": "\uEA83", // cod-folder
	"item.folder_open": "\uEAF7", // cod-folder_opened
	"item.markdown": "\uEB1D", // cod-markdown
	"item.json": "\uEB0F", // cod-json
	"item.bash": "\uEA85", // cod-terminal
	"item.agents": "\uEA7E", // cod-organization
	"item.todos": "\uEB67", // cod-tasklist
	"item.diff": "\uEAE1", // cod-diff
	"item.diff_added": "\uEADC", // cod-diff_added
	"item.diff_modified": "\uEADE", // cod-diff_modified
	"item.diff_removed": "\uEADF", // cod-diff_removed
	"item.diff_renamed": "\uEAE0", // cod-diff_renamed
	"item.diff_ignored": "\uEADD", // cod-diff_ignored

	// file types for the file menu and tool cards
	"file.typescript": "\uE8CA", // dev-typescript
	"file.react": "\uE7BA", // dev-react
	"file.python": "\uE73C", // dev-python
	"file.rust": "\uE7A8", // dev-rust
	"file.go": "\uE724", // dev-go
	"file.java": "\uE738", // dev-java
	"file.csharp": "\uE7B2", // dev-csharp
	"file.shell": "\uE691", // seti-shell
	"file.css": "\uE614", // seti-css
	"file.html": "\uE60E", // seti-html
	"file.config": "\uE615", // seti-config

	// key bar
	"key.keyboard": "\uEC3C", // cod-keyboard_tab
} as const;

export type SymbolKey = keyof typeof SYMBOLS;

/** omp tool names to a symbol key; an unknown tool gets the generic code mark. */
const TOOL_SYMBOL: Record<string, SymbolKey> = {
	read: "item.file",
	write: "ui.add",
	edit: "ui.edit",
	ast_edit: "ui.edit",
	bash: "item.bash",
	grep: "ui.search",
	glob: "ui.filter",
	find: "ui.search",
	ast_grep: "ui.search",
	task: "seg.subagents",
	todo: "item.todos",
	web_search: "ui.globe",
	eval: "ui.code",
	python: "ui.code",
	browser: "ui.browser",
	memory_edit: "seg.context",
	recall: "seg.context",
	retain: "seg.context",
	reflect: "seg.context",
	lsp: "ui.code",
	debug: "ui.code",
	security_scan: "ui.guard",
	generate_image: "ui.image",
	manage_skill: "ui.sparkle",
	learn: "ui.sparkle",
	checkpoint: "ui.history",
	rewind: "ui.history",
	computer: "ui.laptop",
	github: "ui.link",
};

export function toolSymbol(name: string): SymbolKey {
	return TOOL_SYMBOL[name] ?? "ui.code";
}

/** The file menu's and tool cards' icon per extension; anything unknown gets the plain file mark. */
const EXTENSION_SYMBOL: Record<string, SymbolKey> = {
	ts: "file.typescript",
	tsx: "file.react",
	js: "file.typescript",
	jsx: "file.react",
	mjs: "file.typescript",
	cjs: "file.typescript",
	py: "file.python",
	rs: "file.rust",
	go: "file.go",
	java: "file.java",
	cs: "file.csharp",
	csproj: "file.csharp",
	sln: "file.csharp",
	sh: "file.shell",
	bash: "file.shell",
	zsh: "file.shell",
	css: "file.css",
	scss: "file.css",
	sass: "file.css",
	html: "file.html",
	htm: "file.html",
	md: "item.markdown",
	json: "item.json",
	yaml: "file.config",
	yml: "file.config",
	toml: "file.config",
	ini: "file.config",
	conf: "file.config",
	env: "file.config",
	sql: "seg.context",
	png: "ui.image",
	jpg: "ui.image",
	jpeg: "ui.image",
	gif: "ui.image",
	svg: "ui.image",
	webp: "ui.image",
};

export function fileSymbol(path: string, isDir: boolean): SymbolKey {
	if (isDir) return "item.folder";
	const name = path.slice(path.lastIndexOf("/") + 1);
	const dot = name.lastIndexOf(".");
	if (dot <= 0) return "item.file";
	return EXTENSION_SYMBOL[name.slice(dot + 1).toLowerCase()] ?? "item.file";
}
