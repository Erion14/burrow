// A runnable stand-in for `omp --mode rpc-ui`, started by the same spawn path as
// the real thing. It speaks the RPC protocol over stdio: ready frame, responses
// by id, canned events, and `rpc_chunk` frames. Control commands (`__emit`,
// `__chunked`, `__script`, `__exit`, `__stderr`, `__hold`, `__state`, `__bash`,
// `__queue`) let tests drive it.
//
// Flags: --script <json file> (steps played after each `prompt`), --log <path>,
// --session-id, --session-file, --hold-file <path>, --crash-after-ready,
// --body-file <path>, --no-commands-frame, --resume=<file> (as passed by the client).

import { appendFileSync, openSync, readFileSync } from "node:fs";

interface ScriptStep {
	delayMs?: number;
	frame: unknown;
}

const options = {
	script: null as string | null,
	log: null as string | null,
	sessionId: null as string | null,
	sessionFile: null as string | null,
	holdFile: null as string | null,
	crashAfterReady: false,
	bodyFile: null as string | null,
	resume: null as string | null,
	noCommandsFrame: false,
	/** Replaces the get_state fields below the run flags; `__state` sets it. */
	state: null as Record<string, unknown> | null,
	/** What `bash` answers; `__bash` sets it. */
	bash: {} as Record<string, unknown>,
	/** What `abort_and_restore_queue` answers; `__queue` sets it. */
	queue: {} as Record<string, unknown>,
};

const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
	const arg = argv[i]!;
	if (arg === "--script") options.script = argv[++i] ?? null;
	else if (arg === "--log") options.log = argv[++i] ?? null;
	else if (arg === "--session-id") options.sessionId = argv[++i] ?? null;
	else if (arg === "--session-file") options.sessionFile = argv[++i] ?? null;
	else if (arg === "--hold-file") options.holdFile = argv[++i] ?? null;
	else if (arg === "--crash-after-ready") options.crashAfterReady = true;
	else if (arg === "--body-file") options.bodyFile = argv[++i] ?? null;
	else if (arg === "--no-commands-frame") options.noCommandsFrame = true;
	else if (arg.startsWith("--resume=")) options.resume = arg.slice("--resume=".length);
}

/** The slash commands both the startup frame and `get_available_commands` report. */
const COMMANDS = [
	{
		name: "security",
		description: "Review code for vulnerabilities",
		input: { hint: "<path or scope>" },
		subcommands: [{ name: "audit", description: "Audit dependencies" }],
	},
	{ name: "clear", description: "Clear the conversation" },
];

const MODELS = [
	{ provider: "anthropic", id: "claude-sonnet-4-5", name: "Sonnet 4.5", contextWindow: 200000, reasoning: true },
	{ provider: "anthropic", id: "claude-haiku-4-5", name: "Haiku 4.5", contextWindow: 200000, reasoning: false },
];

const THINKING_LEVELS = ["off", "low", "medium", "high"];

/** What `get_state` reports besides the run flags; `__state` replaces the whole set. */
const DEFAULT_STATE = {
	model: { provider: "anthropic", id: "claude-sonnet-4-5", name: "Sonnet 4.5" },
	thinkingLevel: "medium",
	contextUsage: { tokens: 1200, contextWindow: 200000, percent: 0.6 },
	todoPhases: [],
	goal: null,
};

// Keeps the descriptor open for the life of the process, like omp does with its session file.
if (options.holdFile) openSync(options.holdFile, "a");

const encoder = new TextEncoder();
const inflight = new Set<Promise<unknown>>();
let chunkSeq = 0;

function writeOut(text: string): Promise<void> {
	return new Promise((resolve) => process.stdout.write(text, () => resolve()));
}

function emit(frame: unknown): Promise<void> {
	return writeOut(`${JSON.stringify(frame)}\n`);
}

function writeErr(text: string): Promise<void> {
	return new Promise((resolve) => process.stderr.write(text, () => resolve()));
}

async function exitAfterFlush(code: number): Promise<never> {
	await Promise.all([...inflight]);
	await Promise.all([writeOut(""), writeErr("")]);
	process.exit(code);
}

async function playScript(steps: ScriptStep[]): Promise<void> {
	for (const step of steps) {
		if (step.delayMs) await Bun.sleep(step.delayMs);
		await emit(step.frame);
	}
}

function background(work: Promise<unknown>): void {
	inflight.add(work);
	void work.finally(() => inflight.delete(work));
}

async function emitChunked(frame: unknown, chunkSize: number): Promise<void> {
	const bytes = encoder.encode(JSON.stringify(frame));
	const count = Math.max(1, Math.ceil(bytes.length / chunkSize));
	const chunkId = `rpc-${++chunkSeq}`;
	for (let index = 0; index < count; index++) {
		await emit({
			type: "rpc_chunk",
			chunkId,
			index,
			count,
			byteLength: bytes.length,
			data: Buffer.from(bytes.subarray(index * chunkSize, (index + 1) * chunkSize)).toString("base64"),
		});
	}
}

function success(id: unknown, command: string, data?: unknown) {
	return { id, type: "response", command, success: true, ...(data === undefined ? {} : { data }) };
}

/** The get_state fields the run flags sit on: the `__state` replacement, or the defaults. */
function stateFields(): Record<string, unknown> {
	if (options.state === null) options.state = { ...DEFAULT_STATE };
	return options.state;
}

function stateData() {
	const sessionFile = options.sessionFile ?? options.resume;
	return {
		isStreaming: false,
		isSettled: true,
		hasPendingAsyncWork: false,
		...stateFields(),
		...(options.sessionId ? { sessionId: options.sessionId } : {}),
		...(sessionFile ? { sessionFile } : {}),
		...(options.resume ? { resume: options.resume } : {}),
		...(options.bodyFile ? { bodyFile: options.bodyFile } : {}),
	};
}

async function handle(command: Record<string, unknown>): Promise<void> {
	if (options.log) appendFileSync(options.log, `${JSON.stringify(command)}\n`);
	const type = String(command.type);
	const { id } = command;
	switch (type) {
		case "negotiate_protocol":
			await emit(success(id, type, { protocolVersion: command.protocolVersion }));
			return;
		case "get_state":
			await emit(success(id, type, stateData()));
			return;
		case "prompt":
			await emit(success(id, type, { agentInvoked: true }));
			if (options.script) {
				const steps = JSON.parse(readFileSync(options.script, "utf8")) as ScriptStep[];
				background(playScript(steps));
			}
			return;
		case "get_messages_page":
			await emit(success(id, type, { messages: [], totalMessages: 0 }));
			return;
		case "get_subagents":
			await emit(success(id, type, { subagents: [] }));
			return;
		case "get_available_commands":
			await emit(success(id, type, { commands: COMMANDS }));
			return;
		case "get_available_models":
			await emit(success(id, type, { models: MODELS }));
			return;
		case "get_available_thinking_levels":
			await emit(success(id, type, { levels: THINKING_LEVELS }));
			return;
		case "abort":
		case "set_event_filter":
		case "set_ask_dialog":
		case "set_subagent_subscription":
			await emit(success(id, type, {}));
			return;
		case "set_model": {
			const provider = String(command.provider);
			const modelId = String(command.modelId);
			const model = MODELS.find((entry) => entry.provider === provider && entry.id === modelId);
			if (!model) {
				await emit({ id, type: "response", command: type, success: false, error: `Unknown model ${provider}/${modelId}` });
				return;
			}
			stateFields().model = { provider: model.provider, id: model.id, name: model.name };
			await emit(success(id, type, stateFields().model));
			return;
		}
		case "cycle_model": {
			const current = (stateFields().model as { id?: string } | null)?.id;
			const next = MODELS[(MODELS.findIndex((entry) => entry.id === current) + 1) % MODELS.length]!;
			stateFields().model = { provider: next.provider, id: next.id, name: next.name };
			await emit(success(id, type, { model: stateFields().model, isScoped: false }));
			return;
		}
		case "set_thinking_level":
			stateFields().thinkingLevel = String(command.level);
			await emit(success(id, type));
			return;
		case "cycle_thinking_level": {
			const level = THINKING_LEVELS[(THINKING_LEVELS.indexOf(String(stateFields().thinkingLevel)) + 1) % THINKING_LEVELS.length]!;
			stateFields().thinkingLevel = level;
			await emit(success(id, type, { level }));
			return;
		}
		case "compact":
			await emit(success(id, type, { summary: "", firstKeptEntryId: "", tokensBefore: 0 }));
			return;
		case "set_session_name":
			stateFields().sessionName = String(command.name);
			await emit(success(id, type, { name: stateFields().sessionName }));
			return;
		case "remove_queued_message":
			await emit(success(id, type, { removed: true }));
			return;
		case "promote_queued_message":
			await emit(success(id, type, { promoted: true }));
			return;
		case "abort_and_restore_queue":
			if (typeof options.queue.fail === "string") {
				await emit({ id, type: "response", command: type, success: false, error: options.queue.fail });
				return;
			}
			await emit(success(id, type, { steering: [], followUp: [], ...options.queue }));
			return;
		case "cancel_subagent":
			await emit(success(id, type, { cancelled: true }));
			return;
		case "steer_subagent":
			await emit(success(id, type, {}));
			return;
		case "goal": {
			const op = String(command.op);
			if (op === "drop") {
				stateFields().goal = null;
				await emit(success(id, type, { goal: null, state: null }));
				return;
			}
			const state = op === "pause" ? "paused" : "active";
			stateFields().goal = { objective: "ship phase 1.5", state };
			await emit(success(id, type, { goal: stateFields().goal, state }));
			return;
		}
		case "bash": {
			// `delayMs` keeps the reply open so a test can see the running card first; `hold`
			// never replies; `fail` rejects the command; anything else is the BashResult.
			if (typeof options.bash.delayMs === "number") await Bun.sleep(options.bash.delayMs);
			if (options.bash.hold === true) return;
			if (typeof options.bash.fail === "string") {
				await emit({ id, type: "response", command: type, success: false, error: options.bash.fail });
				return;
			}
			await emit(
				success(id, type, {
					output: "",
					exitCode: 0,
					cancelled: false,
					truncated: false,
					totalLines: 0,
					totalBytes: 0,
					workingDir: process.cwd(),
					...options.bash,
				}),
			);
			return;
		}
		case "extension_ui_response":
			// A reply frame: logged above, never answered, like omp.
			return;
		case "__hold":
			// Never answered, so a test can answer the id itself with a forged frame.
			return;
		case "__state":
			// Replaces the get_state fields wholesale, so a test can drop one and prove
			// the manager keeps the value the earlier read reported.
			options.state = (command.state as Record<string, unknown> | undefined) ?? {};
			await emit(success(id, type));
			return;
		case "__bash":
			// What the next `bash` answers: an exit code, `truncated`, `fail`, `hold`, `delayMs`.
			options.bash = (command.result as Record<string, unknown> | undefined) ?? {};
			await emit(success(id, type));
			return;
		case "__queue":
			// What the next `abort_and_restore_queue` answers, `fail` included.
			options.queue = (command.result as Record<string, unknown> | undefined) ?? {};
			await emit(success(id, type));
			return;
		case "__emit":
			for (const frame of (command.frames as unknown[]) ?? []) await emit(frame);
			await emit(success(id, type));
			return;
		case "__chunked":
			await emitChunked(command.frame, Number(command.chunkSize) || 1024);
			await emit(success(id, type));
			return;
		case "__script":
			background(playScript((command.steps as ScriptStep[]) ?? []));
			await emit(success(id, type));
			return;
		case "__stderr":
			await writeErr(String(command.text ?? ""));
			await emit(success(id, type));
			return;
		case "__exit":
			await exitAfterFlush(Number(command.code ?? 0));
			return;
		default:
			await emit({ id, type: "response", command: type, success: false, error: `Unknown command: ${type}` });
	}
}

await emit({
	type: "ready",
	protocolVersion: 1,
	supportedProtocolVersions: [1, 2],
	maxFrameBytes: 1048576,
	maxReassembledFrameBytes: 67108864,
});

if (options.crashAfterReady) {
	await writeErr("fake omp crashed after ready\n");
	process.exit(1);
}

// omp pushes the command list right after the ready frame; --no-commands-frame
// leaves the phone with nothing but the get_available_commands request.
if (!options.noCommandsFrame) await emit({ type: "available_commands_update", commands: COMMANDS });

const decoder = new TextDecoder();
let buffered = "";
for await (const chunk of Bun.stdin.stream()) {
	buffered += decoder.decode(chunk, { stream: true });
	let newline = buffered.indexOf("\n");
	while (newline !== -1) {
		const text = buffered.slice(0, newline).trim();
		buffered = buffered.slice(newline + 1);
		newline = buffered.indexOf("\n");
		if (!text) continue;
		let command: Record<string, unknown>;
		try {
			command = JSON.parse(text);
		} catch {
			await emit({ type: "response", command: "parse", success: false, error: "Failed to parse command" });
			continue;
		}
		await handle(command);
	}
}

// stdin closed: like omp, drain pending output, then exit 0.
await exitAfterFlush(0);
