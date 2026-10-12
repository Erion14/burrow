// The port Burrow uses to talk to one omp process over RPC stdio.
// `startOmpProcess` owns framing (JSONL, protocol v2 reassembly), the ready
// frame handshake, response matching by id, and draining stdout after stdin
// closes. Everything above this file works with commands, responses and events.

export type RpcResult<T = unknown> = { ok: true; data: T } | { ok: false; error: string; code?: string };

export interface OmpCommand {
	type: string;
	[id: string]: unknown;
}

export interface OmpEvent {
	type: string;
	[id: string]: unknown;
}

export interface OmpExitInfo {
	code: number | null;
	signal: string | null;
	stderr: string;
}

export interface OmpProcess {
	readonly pid: number;
	/** From `get_state` right after the handshake; null when the process had none yet. */
	readonly sessionId: string | null;
	readonly sessionFile: string | null;
	readonly exited: boolean;
	/** Sends one command and resolves when its response frame arrives. */
	send<T = unknown>(command: OmpCommand): Promise<RpcResult<T>>;
	/** Every session event frame, in order. Returns an unsubscribe function. */
	onEvent(handler: (event: OmpEvent) => void): () => void;
	/** Process exit, after the streams are drained. Returns an unsubscribe function. */
	onExit(handler: (info: OmpExitInfo) => void): () => void;
	/** Closes stdin, keeps draining stdout, resolves once the process exits. */
	close(): Promise<OmpExitInfo>;
	/** Last resort: SIGKILL. */
	kill(): void;
}

export interface StartOmpProcessOptions {
	command: string[];
	cwd: string;
	env: Record<string, string>;
	/** Adds --resume=<file>; the session file is never opened by two processes. */
	resumeFile?: string;
	/** Defaults to 20_000 ms. */
	readyTimeoutMs?: number;
}

export interface OmpProcessModule {
	startOmpProcess(options: StartOmpProcessOptions): Promise<OmpProcess>;
}
