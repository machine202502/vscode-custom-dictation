import { spawn, type ChildProcess } from 'node:child_process';
import { t } from '../i18n';
import type { Logger } from '../log';
import { listAudioDevices, resolveDevice, type CaptureFormat } from './devices';

export interface PcmSource {
	/** Raw s16le, 16 kHz, mono chunks. */
	onData: (chunk: Buffer) => void;
	onError: (error: Error) => void;
	/** Called when the recorder exits. `stderr` carries ffmpeg's diagnostics. */
	onExit: (code: number | null, stderr: string) => void;
	start(): Promise<void>;
	stop(): Promise<void>;
}

export function buildFfmpegArgs(format: CaptureFormat, device: string): string[] {
	const base = ['-hide_banner', '-nostdin', '-loglevel', 'error'];
	const output = ['-ac', '1', '-ar', '16000', '-f', 's16le', 'pipe:1'];

	switch (format) {
		case 'dshow':
			// 100 ms buffers keep dictation responsive without dropping samples.
			return [...base, '-f', 'dshow', '-audio_buffer_size', '100', '-i', `audio=${device}`, ...output];
		case 'avfoundation':
			return [...base, '-f', 'avfoundation', '-i', `:${device}`, ...output];
		case 'pulse':
			return [...base, '-f', 'pulse', '-i', device || 'default', ...output];
		case 'alsa':
			return [...base, '-f', 'alsa', '-i', device || 'default', ...output];
	}
}

interface PreparedCommand {
	readonly command: string;
	readonly args: string[];
	readonly shell: boolean;
}

abstract class ProcessPcmSource implements PcmSource {
	onData: (chunk: Buffer) => void = () => undefined;
	onError: (error: Error) => void = () => undefined;
	onExit: (code: number | null, stderr: string) => void = () => undefined;

	protected stopping = false;
	private child: ChildProcess | undefined;
	private stderrTail = '';

	constructor(protected readonly logger: Logger) { }

	protected abstract prepare(): Promise<PreparedCommand>;

	async start(): Promise<void> {
		if (this.child) {
			return;
		}

		const prepared = await this.prepare();
		await new Promise<void>((resolve, reject) => {
			let started = false;
			const child = spawn(prepared.command, prepared.args, {
				windowsHide: true,
				shell: prepared.shell,
				stdio: ['ignore', 'pipe', 'pipe'],
			});
			this.child = child;
			this.stderrTail = '';

			child.once('error', error => {
				const decorated = this.decorate(error);
				if (!started) {
					started = true;
					this.child = undefined;
					reject(decorated);
				} else {
					this.onError(decorated);
				}
			});

			child.once('spawn', () => {
				started = true;
				resolve();
			});

			child.stdout?.on('data', (chunk: Buffer) => {
				if (!this.stopping) {
					this.onData(chunk);
				}
			});

			child.stderr?.on('data', (chunk: Buffer) => {
				this.stderrTail = (this.stderrTail + chunk.toString()).slice(-8000);
			});

			child.once('close', code => {
				if (this.child === child) {
					this.child = undefined;
				}
				this.onExit(code, this.stderrTail.trim());
			});
		});

		this.logger.info(`Recorder started: ${prepared.command} ${prepared.args.join(' ')}`);
	}

	async stop(): Promise<void> {
		const child = this.child;
		if (!child) {
			return;
		}
		this.stopping = true;

		await new Promise<void>(resolve => {
			let settled = false;
			const finish = () => {
				if (settled) {
					return;
				}
				settled = true;
				clearTimeout(timer);
				resolve();
			};
			const timer = setTimeout(() => {
				try {
					child.kill('SIGKILL');
				} catch {
					// already gone
				}
				finish();
			}, 1500);

			child.once('close', finish);
			try {
				child.kill();
			} catch {
				finish();
			}
		});

		this.child = undefined;
		this.stopping = false;
	}

	private decorate(error: NodeJS.ErrnoException): Error {
		if (error.code === 'ENOENT') {
			return new Error(t(
				'Cannot start "{0}": executable not found. '
				+ 'Install ffmpeg (https://ffmpeg.org/download.html) or set "customDictation.audio.ffmpegPath".',
				error.path ?? 'the recorder',
			));
		}
		return error instanceof Error ? error : new Error(String(error));
	}
}

export interface FfmpegSourceOptions {
	readonly ffmpegPath: string;
	readonly format: CaptureFormat;
	readonly device: string;
}

export class FfmpegSource extends ProcessPcmSource {
	constructor(private readonly options: FfmpegSourceOptions, logger: Logger) {
		super(logger);
	}

	protected async prepare(): Promise<PreparedCommand> {
		const devices = await listAudioDevices(this.options.ffmpegPath, this.options.format).catch(() => []);
		const device = resolveDevice(devices, this.options.device);

		if (devices.length > 0) {
			this.logger.info(`Audio devices (${this.options.format}): ${devices.map(entry => `${entry.name} [${entry.id}]`).join(' | ')}`);
		}
		if (!device) {
			this.logger.warn('No audio input device was detected; starting ffmpeg with an empty device name.');
		}

		return {
			command: this.options.ffmpegPath,
			args: buildFfmpegArgs(this.options.format, device),
			shell: false,
		};
	}
}

/** Runs a user supplied recorder that writes raw s16le/16 kHz/mono PCM to stdout. */
export class CommandSource extends ProcessPcmSource {
	constructor(private readonly commandLine: string, logger: Logger) {
		super(logger);
	}

	protected async prepare(): Promise<PreparedCommand> {
		return { command: this.commandLine, args: [], shell: true };
	}
}
