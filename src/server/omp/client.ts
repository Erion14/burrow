// omp RPC transport: spawn, ready handshake, protocol v2 negotiation, response
// matching by id, event fan-out, and orderly shutdown. See port.ts.

import { createFrameDecoder } from "./frames";
import type {
	OmpCommand,
	OmpEvent,
	OmpExitInfo,
	OmpProcess,
	RpcResult,
	StartOmpProcessOptions,
} from "./port";

const DEFAULT_READY_TIMEOUT_MS = 20_000;
const CLOSE_KILL_AFTER_MS = 10_000;
// The ready frame advertises this limit as maxReassembledFrameBytes.
const MAX_REASSEMBLED_BYTES = 64 * 1024 * 1024;

type Frame = Record<string, unknown>;

function isFrame(value: unknown): value is Frame {
	return typeof value === "object" && value !== null;
}

function describeExit(info: OmpExitInfo): string {
	const text = info.stderr.trim();
	if (text) return text;
	return `omp exited before it was ready (code ${info.code}, signal ${info.signal})`;
}

export async function startOmpProcess(options: StartOmpProcessOptions): Promise<OmpProcess> {
	const argv = [...options.command];
	if (options.resumeFile) argv.push(`--resume=${options.resumeFile}`);
	const child = Bun.spawn(argv, {
		cwd: options.cwd,
		env: { ...process.env, ...options.env },
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
	});

	const decoder = createFrameDecoder({ maxReassembledBytes: MAX_REASSEMBLED_BYTES });
	const pending = new Map<string, (result: RpcResult) => void>();
	const eventHandlers = new Set<(event: OmpEvent) => void>();
	const exitHandlers = new Set<(info: OmpExitInfo) => void>();
	// Events that arrive before the first subscriber (handshake gap) are replayed to it.
	let backlog: OmpEvent[] | null = [];
	let stderr = "";
	let nextId = 1;
	let exited = false;
	let exitInfo: OmpExitInfo | null = null;
	let sessionId: string | null = null;
	let sessionFile: string | null = null;
	let killTimer: NodeJS.Timeout | undefined;
	let onReady: ((frame: Frame) => void) | null = null;

	function dispatch(frame: Frame): void {
		if (frame.type === "ready" && onReady) {
			const resolve = onReady;
			onReady = null;
			resolve(frame);
			return;
		}
		if (frame.type === "response") {
			const id = frame.id;
			if (typeof id !== "string") return;
			const resolve = pending.get(id);
			if (!resolve) return;
			pending.delete(id);
			if (frame.success === true) resolve({ ok: true, data: frame.data });
			else {
				const code = typeof frame.code === "string" ? frame.code : undefined;
				resolve({ ok: false, error: typeof frame.error === "string" ? frame.error : "command failed", ...(code ? { code } : {}) });
			}
			return;
		}
		const event = frame as OmpEvent;
		if (typeof event.type !== "string") return;
		if (backlog) {
			backlog.push(event);
			return;
		}
		for (const handler of [...eventHandlers]) handler(event);
	}

	async function drainStdout(): Promise<void> {
		const reader = child.stdout.getReader();
		for (;;) {
			const { done, value } = await reader.read();
			if (done) return;
			for (const result of decoder.push(value)) {
				if (result.kind === "frame" && isFrame(result.value)) dispatch(result.value);
			}
		}
	}

	async function drainStderr(): Promise<void> {
		const text = new TextDecoder();
		const reader = child.stderr.getReader();
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			stderr += text.decode(value, { stream: true });
		}
		stderr += text.decode();
	}

	// Reading starts immediately and continues after stdin closes, or omp cannot exit.
	const drained = Promise.all([drainStdout().catch(() => {}), drainStderr().catch(() => {})]);

	const exitPromise: Promise<OmpExitInfo> = (async () => {
		const code = await child.exited;
		await drained;
		clearTimeout(killTimer);
		const info: OmpExitInfo = {
			code,
			signal: child.signalCode == null ? null : String(child.signalCode),
			stderr,
		};
		exited = true;
		exitInfo = info;
		for (const resolve of [...pending.values()]) resolve({ ok: false, error: "omp process exited" });
		pending.clear();
		for (const handler of [...exitHandlers]) handler(info);
		return info;
	})();

	function write(frame: unknown): void {
		child.stdin.write(`${JSON.stringify(frame)}\n`);
		// A broken pipe surfaces here or on the exit path, which fails pending sends.
		void Promise.resolve(child.stdin.flush()).catch(() => {});
	}

	function send<T = unknown>(command: OmpCommand): Promise<RpcResult<T>> {
		if (exited) return Promise.resolve({ ok: false, error: "omp process exited" });
		// A dialog reply is a reply frame: omp never answers it and matches it by
		// the dialog's own id, which must stay as the caller set it.
		if (command.type === "extension_ui_response") {
			try {
				write(command);
			} catch (error) {
				return Promise.resolve({ ok: false, error: error instanceof Error ? error.message : String(error) });
			}
			return Promise.resolve({ ok: true, data: null as T });
		}
		const id = `req_${nextId++}`;
		const { promise, resolve } = Promise.withResolvers<RpcResult<T>>();
		pending.set(id, resolve as (result: RpcResult) => void);
		try {
			write({ ...command, id });
		} catch (error) {
			pending.delete(id);
			resolve({ ok: false, error: error instanceof Error ? error.message : String(error) });
		}
		return promise;
	}

	// Handshake (ready frame, v2 negotiation, get_state) shares one deadline.
	// Any failure kills the child before rejecting.
	const timeoutMs = options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
	const ready = Promise.withResolvers<Frame>();
	onReady = ready.resolve;
	let timer: NodeJS.Timeout | undefined;
	const timedOut = new Promise<"timeout">((resolve) => {
		timer = setTimeout(() => resolve("timeout"), timeoutMs);
	});
	const early = exitPromise.then((info) => ({ exit: info }));

	async function fail(message: string): Promise<never> {
		child.kill("SIGKILL");
		await exitPromise;
		throw new Error(message);
	}

	function timeoutMessage(): string {
		return `omp did not finish its handshake within ${timeoutMs} ms${stderr.trim() ? `: ${stderr.trim()}` : ""}`;
	}

	try {
		const first = await Promise.race([ready.promise.then((frame) => ({ frame })), early, timedOut]);
		if (first === "timeout") return await fail(timeoutMessage());
		if ("exit" in first) throw new Error(describeExit(first.exit));
		const advertised = first.frame.supportedProtocolVersions;
		if (Array.isArray(advertised) && advertised.includes(2)) {
			const negotiated = await Promise.race([send({ type: "negotiate_protocol", protocolVersion: 2 }), timedOut]);
			if (negotiated === "timeout") return await fail(timeoutMessage());
			if (!negotiated.ok) {
				if (exitInfo) throw new Error(describeExit(exitInfo));
				return await fail(`omp refused protocol v2: ${negotiated.error}`);
			}
		}
		const state = await Promise.race([send<{ sessionId?: unknown; sessionFile?: unknown }>({ type: "get_state" }), timedOut]);
		if (state === "timeout") return await fail(timeoutMessage());
		if (state.ok && isFrame(state.data)) {
			if (typeof state.data.sessionId === "string") sessionId = state.data.sessionId;
			if (typeof state.data.sessionFile === "string") sessionFile = state.data.sessionFile;
		} else if (exitInfo) {
			throw new Error(describeExit(exitInfo));
		}
	} finally {
		clearTimeout(timer);
	}

	return {
		pid: child.pid,
		get sessionId() {
			return sessionId;
		},
		get sessionFile() {
			return sessionFile;
		},
		get exited() {
			return exited;
		},
		send,
		onEvent(handler) {
			eventHandlers.add(handler);
			if (backlog) {
				const replay = backlog;
				backlog = null;
				for (const event of replay) handler(event);
			}
			return () => {
				eventHandlers.delete(handler);
			};
		},
		onExit(handler) {
			exitHandlers.add(handler);
			return () => {
				exitHandlers.delete(handler);
			};
		},
		close() {
			if (exited) return Promise.resolve(exitInfo as OmpExitInfo);
			if (!killTimer) killTimer = setTimeout(() => child.kill("SIGKILL"), CLOSE_KILL_AFTER_MS);
			try {
				void Promise.resolve(child.stdin.end()).catch(() => {});
			} catch {
				// stdin already closed.
			}
			return exitPromise;
		},
		kill() {
			child.kill("SIGKILL");
		},
	};
}
