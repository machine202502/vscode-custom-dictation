import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Logger } from '../log';
import { PCM_SAMPLE_RATE } from '../audio/wav';
import { extractSherpaText } from './sherpaOnnx';
import { WebSocketClient } from '../util/websocket';

const PAYLOAD_CHUNK = 10240;
const START_TIMEOUT_MS = 30000;
const REQUEST_TIMEOUT_MS = 60000;

export interface SherpaServerOptions {
	readonly executable: string;
	readonly modelFile: string;
	readonly tokensFile: string;
	readonly threads?: number;
	readonly extraArgs?: string;
}

export function buildSherpaServerArgs(options: SherpaServerOptions, port: number, logFile?: string): string[] {
	const args = [
		`--port=${port}`,
		'--num-work-threads=1',
		'--max-batch-size=1',
		`--tokens=${options.tokensFile}`,
		`--nemo-ctc-model=${options.modelFile}`,
		`--num-threads=${options.threads ?? 2}`,
	];

	if (logFile) {
		// Without an explicit log file the server drops log.txt into the current directory,
		// which would be the user's workspace.
		args.push(`--log-file=${logFile}`);
	}

	const extra = options.extraArgs?.trim();
	if (extra) {
		args.push(...splitArgs(extra));
	}
	return args;
}

/**
 * Keeps `sherpa-onnx-offline-websocket-server` warm so each phrase costs a forward pass
 * (~0.2 s) instead of reloading the model (~2 s).
 */
export class SherpaServer implements Disposable {
	private child: ChildProcess | undefined;
	private socket: WebSocketClient | undefined;
	private port = 0;
	private workDirectory: string | undefined;
	private ready: Promise<void> | undefined;
	private queue: Promise<unknown> = Promise.resolve();
	private stderrTail = '';

	constructor(
		private readonly options: SherpaServerOptions,
		private readonly logger: Logger,
	) { }

	get label(): string {
		return 'sherpa-onnx server';
	}

	async transcribe(pcm: Int16Array, signal?: AbortSignal): Promise<string> {
		const run = this.queue.then(() => this.doTranscribe(pcm, signal));
		this.queue = run.catch(() => undefined);
		return run;
	}

	private async doTranscribe(pcm: Int16Array, signal?: AbortSignal): Promise<string> {
		const socket = await this.ensureStarted();

		const payload = Buffer.allocUnsafe(8 + pcm.length * 4);
		payload.writeUInt32LE(PCM_SAMPLE_RATE, 0);
		payload.writeUInt32LE(pcm.length * 4, 4);
		for (let i = 0; i < pcm.length; i++) {
			payload.writeFloatLE(pcm[i] / 32768, 8 + i * 4);
		}

		const text = await new Promise<string>((resolve, reject) => {
			const timer = setTimeout(() => {
				cleanup();
				reject(new Error('sherpa-onnx server did not answer in time'));
			}, REQUEST_TIMEOUT_MS);

			const onAbort = () => {
				cleanup();
				reject(new Error('Request cancelled'));
			};

			const cleanup = () => {
				clearTimeout(timer);
				socket.onMessage = () => undefined;
				socket.onClose = () => undefined;
				signal?.removeEventListener('abort', onAbort);
			};

			socket.onMessage = data => {
				cleanup();
				resolve(extractSherpaText(data.toString('utf8')));
			};
			socket.onClose = error => {
				cleanup();
				this.reset();
				reject(error ?? new Error('sherpa-onnx server closed the connection'));
			};
			signal?.addEventListener('abort', onAbort);

			if (signal?.aborted) {
				onAbort();
				return;
			}

			for (let offset = 0; offset < payload.length; offset += PAYLOAD_CHUNK) {
				socket.sendBinary(payload.subarray(offset, Math.min(offset + PAYLOAD_CHUNK, payload.length)));
			}
		});

		return text.trim();
	}

	async ensureStarted(): Promise<WebSocketClient> {
		if (this.socket) {
			return this.socket;
		}
		this.ready ??= this.start();
		await this.ready;
		if (!this.socket) {
			throw new Error('sherpa-onnx server failed to start');
		}
		return this.socket;
	}

	private async start(): Promise<void> {
		this.port = await freePort();
		const workDirectory = await mkdtemp(join(tmpdir(), 'custom-dictation-sherpa-'));
		this.workDirectory = workDirectory;
		const args = buildSherpaServerArgs(this.options, this.port, join(workDirectory, 'sherpa.log'));

		this.logger.info(`Starting sherpa-onnx server: ${this.options.executable} ${args.join(' ')}`);
		const child = spawn(this.options.executable, args, {
			windowsHide: true,
			cwd: workDirectory,
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		this.child = child;
		this.stderrTail = '';

		child.stdout?.on('data', () => undefined);
		child.stderr?.on('data', (chunk: Buffer) => {
			this.stderrTail = (this.stderrTail + chunk.toString()).slice(-4000);
		});
		child.once('exit', code => {
			if (this.child === child) {
				this.child = undefined;
				this.socket = undefined;
				this.ready = undefined;
			}
			if (code !== 0 && code !== null) {
				this.logger.warn(`sherpa-onnx server exited with code ${code}: ${this.stderrTail.slice(-400)}`);
			}
		});

		const deadline = Date.now() + START_TIMEOUT_MS;
		for (; ;) {
			if (child.exitCode !== null) {
				throw new Error(`sherpa-onnx server exited during startup: ${this.stderrTail.slice(-400) || `code ${child.exitCode}`}`);
			}
			try {
				this.socket = await WebSocketClient.connect('127.0.0.1', this.port);
				break;
			} catch {
				if (Date.now() > deadline) {
					throw new Error(`sherpa-onnx server did not start within ${START_TIMEOUT_MS / 1000}s: ${this.stderrTail.slice(-400)}`);
				}
				await new Promise(resolve => setTimeout(resolve, 150));
			}
		}

		this.logger.info(`sherpa-onnx server is listening on 127.0.0.1:${this.port}`);
	}

	private reset(): void {
		this.socket = undefined;
		this.ready = undefined;
	}

	[Symbol.dispose](): void {
		this.dispose();
	}

	dispose(): void {
		this.socket?.close();
		this.socket = undefined;
		this.ready = undefined;

		const child = this.child;
		this.child = undefined;
		if (child && child.exitCode === null) {
			try {
				child.kill();
			} catch {
				// already gone
			}
		}

		const workDirectory = this.workDirectory;
		this.workDirectory = undefined;
		if (workDirectory) {
			void rm(workDirectory, { recursive: true, force: true }).catch(() => undefined);
		}
	}
}

async function freePort(): Promise<number> {
	return new Promise<number>((resolve, reject) => {
		const server = createServer();
		server.once('error', reject);
		server.listen(0, '127.0.0.1', () => {
			const address = server.address();
			const port = typeof address === 'object' && address ? address.port : 0;
			server.close(() => resolve(port));
		});
	});
}

/** Splits extra CLI arguments, honouring double quotes. */
export function splitArgs(value: string): string[] {
	const result: string[] = [];
	const pattern = /"([^"]*)"|(\S+)/g;
	let match: RegExpExecArray | null;
	while ((match = pattern.exec(value)) !== null) {
		result.push(match[1] ?? match[2]);
	}
	return result;
}
