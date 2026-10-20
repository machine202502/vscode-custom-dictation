import { spawn } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { asError } from '../util/errors';
import type { Logger } from '../log';

export type CueKind = 'start' | 'end';

/** `customDictation.audio.cues.*`: both cues are on, quiet by default. */
export interface CueSettings {
	readonly start: boolean;
	readonly end: boolean;
	/** Playback volume in percent (0..100). */
	readonly volume: number;
}

export const DEFAULT_VOLUME = 15;

export const DEFAULT_CUE_SETTINGS: CueSettings = { start: true, end: true, volume: DEFAULT_VOLUME };

export interface CueCommand {
	readonly command: string;
	readonly args: readonly string[];
}

export function shouldPlayCue(settings: CueSettings, kind: CueKind): boolean {
	return kind === 'start' ? settings.start : settings.end;
}

export function clampVolume(volume: number): number {
	if (!Number.isFinite(volume)) {
		return DEFAULT_VOLUME;
	}
	return Math.max(0, Math.min(100, Math.round(volume)));
}

/** The bundled recording that belongs to the cue. */
export function cueFile(kind: CueKind, extensionPath: string): string {
	return join(extensionPath, 'sounds', `${kind}.wav`);
}

/**
 * Scales the PCM payload of a 16 bit WAV in place.
 *
 * The volume is baked into the samples instead of being passed to a player: `ffplay` and
 * `afplay` accept a volume flag, but Windows' `SoundPlayer` and `aplay` do not, and the cue
 * must sound the same whichever player happens to be available.
 */
export function scaleWav(wav: Buffer, volume: number): Buffer {
	const factor = clampVolume(volume) / 100;
	const scaled = Buffer.from(wav);

	let offset = 12;
	while (offset + 8 <= scaled.length) {
		const id = scaled.subarray(offset, offset + 4).toString('ascii');
		const size = scaled.readUInt32LE(offset + 4);
		if (id === 'data') {
			const from = offset + 8;
			const to = Math.min(scaled.length, from + size);
			for (let i = from; i + 1 < to; i += 2) {
				scaled.writeInt16LE(Math.round(scaled.readInt16LE(i) * factor), i);
			}
			return scaled;
		}
		offset += 8 + size + (size % 2);
	}
	return scaled;
}

/**
 * Players tried in order: `ffplay` (ships with ffmpeg, which dictation needs anyway), then the
 * platform's own player. `spawn` reports a missing binary as an error, so the order is safe.
 */
export function playerCandidates(platform: NodeJS.Platform, ffmpegPath: string, soundPath: string): CueCommand[] {
	const candidates: CueCommand[] = [
		{
			command: siblingExecutable(ffmpegPath, 'ffplay'),
			args: ['-nodisp', '-autoexit', '-loglevel', 'quiet', soundPath],
		},
	];

	if (platform === 'win32') {
		candidates.push({
			command: 'powershell',
			args: [
				'-NoProfile',
				'-NonInteractive',
				'-WindowStyle',
				'Hidden',
				'-Command',
				`(New-Object System.Media.SoundPlayer '${soundPath.replace(/'/g, "''")}').PlaySync()`,
			],
		});
	} else if (platform === 'darwin') {
		candidates.push({ command: 'afplay', args: [soundPath] });
	} else {
		candidates.push({ command: 'paplay', args: [soundPath] });
		candidates.push({ command: 'aplay', args: ['-q', soundPath] });
	}

	return candidates;
}

/**
 * Short cues for "recording started" and "recording stopped".
 *
 * VS Code has no audio API, so a bundled WAV is handed to an external player. When the volume
 * is not 100 % a scaled copy is written to a temp folder once and reused.
 * Everything is fire-and-forget: a missing player or file never delays or breaks dictation.
 */
export class SoundCues {
	private readonly warned = new Set<string>();
	private directory: string | undefined;
	private readonly scaled = new Map<string, string>();

	constructor(
		private readonly extensionPath: string,
		private readonly logger: Logger,
	) { }

	/** Never throws, never blocks the caller. */
	play(kind: CueKind, ffmpegPath: string, volume = DEFAULT_VOLUME): void {
		void this.playAsync(kind, ffmpegPath, clampVolume(volume)).catch(() => undefined);
	}

	dispose(): void {
		const directory = this.directory;
		this.directory = undefined;
		this.scaled.clear();
		if (!directory) {
			return;
		}
		try {
			// Synchronous on purpose: the extension host may not get another tick before exit.
			rmSync(directory, { recursive: true, force: true });
		} catch {
			// already gone
		}
	}

	private async playAsync(kind: CueKind, ffmpegPath: string, volume: number): Promise<void> {
		if (volume <= 0) {
			return;
		}

		let file: string | undefined;
		try {
			file = await this.resolvedFile(kind, volume);
		} catch (error) {
			this.warnOnce('write', `Could not prepare the sound cue: ${asError(error).message}`);
			return;
		}
		if (!file) {
			return;
		}

		try {
			await playFile(file, ffmpegPath);
		} catch (error) {
			this.warnOnce('player', `Sound cue is unavailable: ${asError(error).message}`);
		}
	}

	/** Returns the file to play, or `undefined` when the bundled cue is missing. */
	private async resolvedFile(kind: CueKind, volume: number): Promise<string | undefined> {
		const source = cueFile(kind, this.extensionPath);
		if (!existsSync(source)) {
			this.warnOnce(source, `Sound cue file not found: ${source}`);
			return undefined;
		}
		if (volume === 100) {
			return source;
		}

		const key = `${kind}-${volume}`;
		const cached = this.scaled.get(key);
		if (cached) {
			return cached;
		}

		this.directory ??= await mkdtemp(join(tmpdir(), 'custom-dictation-cues-'));
		const target = join(this.directory, `${key}.wav`);
		await writeFile(target, scaleWav(readFileSync(source), volume));
		this.scaled.set(key, target);
		return target;
	}

	private warnOnce(key: string, message: string): void {
		if (this.warned.has(key)) {
			return;
		}
		this.warned.add(key);
		this.logger.warn(message);
	}
}

/** `...\ffmpeg.exe` -> `...\ffplay.exe`; a bare `ffmpeg` stays a bare `ffplay` (found on PATH). */
function siblingExecutable(ffmpegPath: string, name: string): string {
	// String surgery instead of `path.join`: Windows would turn `/opt/bin/ffmpeg` into `\opt`.
	const separator = Math.max(ffmpegPath.lastIndexOf('/'), ffmpegPath.lastIndexOf('\\'));
	if (separator < 0) {
		return name;
	}
	const directory = ffmpegPath.slice(0, separator + 1);
	const base = ffmpegPath.slice(separator + 1);
	const dot = base.lastIndexOf('.');
	const extension = dot > 0 ? base.slice(dot) : '';
	return `${directory}${name}${extension}`;
}

async function playFile(soundPath: string, ffmpegPath: string): Promise<void> {
	let lastError: Error | undefined;
	for (const candidate of playerCandidates(process.platform, ffmpegPath, soundPath)) {
		try {
			await spawnOnce(candidate);
			return;
		} catch (error) {
			lastError = asError(error);
		}
	}
	throw lastError ?? new Error('no audio player was found');
}

function spawnOnce(candidate: CueCommand): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		const child = spawn(candidate.command, [...candidate.args], {
			windowsHide: true,
			stdio: 'ignore',
		});
		child.once('error', reject);
		child.once('spawn', () => {
			child.unref();
			resolve();
		});
	});
}
