// A runnable stand-in for `omp --mode rpc-ui`, started by the same spawn path as
// the real thing. It speaks the RPC protocol over stdio: ready frame, responses
// by id, canned events, and `rpc_chunk` frames. Control commands (`__emit`,
// `__chunked`, `__script`, `__exit`, `__stderr`, `__hold`) let tests drive it.
//
// Flags: --script <json file> (steps played after each `prompt`), --log <path>,
// --session-id, --session-file, --hold-file <path>, --crash-after-ready,
// --body-file <path>, --resume=<file> (as passed by the client).

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
	else if (arg.startsWith("--resume=")) options.resume = arg.slice("--resume=".length);
}

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

function stateData() {
	const sessionFile = options.sessionFile ?? options.resume;
	return {
		isStreaming: false,
		isSettled: true,
		hasPendingAsyncWork: false,
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
		case "abort":
		case "set_event_filter":
		case "set_ask_dialog":
		case "set_subagent_subscription":
			await emit(success(id, type, {}));
			return;
		case "extension_ui_response":
			// A reply frame: logged above, never answered, like omp.
			return;
		case "__hold":
			// Never answered, so a test can answer the id itself with a forged frame.
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
