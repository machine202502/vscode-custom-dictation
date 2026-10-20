import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { DEFAULT_CUE_SETTINGS, DEFAULT_VOLUME, clampVolume, cueFile, playerCandidates, scaleWav, shouldPlayCue } from '../audio/cues';

const EXTENSION_PATH = join(__dirname, '..', '..');

interface Chunk {
	readonly id: string;
	/** Offset of the chunk body. */
	readonly offset: number;
	readonly size: number;
}

function walkChunks(wav: Buffer): Chunk[] {
	const chunks: Chunk[] = [];
	let offset = 12;
	while (offset + 8 <= wav.length) {
		const id = wav.subarray(offset, offset + 4).toString('ascii');
		const size = wav.readUInt32LE(offset + 4);
		chunks.push({ id, offset: offset + 8, size });
		offset += 8 + size + (size % 2);
	}
	return chunks;
}

describe('sound cues', () => {
	it('ships two different ready-made cues', () => {
		const start = join(EXTENSION_PATH, 'sounds', 'start.wav');
		const end = join(EXTENSION_PATH, 'sounds', 'end.wav');

		for (const file of [start, end]) {
			assert.ok(existsSync(file), `${file} is bundled`);
			assert.ok(statSync(file).size > 1000, `${file} is not empty`);
		}

		assert.notEqual(
			readFileSync(start).toString('base64'),
			readFileSync(end).toString('base64'),
			'the start and end cues are different sounds',
		);
	});

	it('bundles ordinary PCM WAV that every player can open', () => {
		for (const name of ['start.wav', 'end.wav']) {
			const wav = readFileSync(join(EXTENSION_PATH, 'sounds', name));

			assert.equal(wav.subarray(0, 4).toString('ascii'), 'RIFF', `${name} is RIFF`);
			assert.equal(wav.subarray(8, 12).toString('ascii'), 'WAVE', `${name} is WAVE`);

			const chunks = walkChunks(wav);
			const fmt = chunks.find(chunk => chunk.id === 'fmt ');
			const data = chunks.find(chunk => chunk.id === 'data');
			assert.ok(fmt, `${name} has a fmt chunk`);
			assert.ok(data, `${name} has a data chunk`);

			assert.equal(wav.readUInt16LE(fmt.offset), 1, `${name} is uncompressed PCM`);
			assert.equal(wav.readUInt16LE(fmt.offset + 2), 1, `${name} is mono`);
			assert.equal(wav.readUInt32LE(fmt.offset + 4), 44100, `${name} is 44.1 kHz`);
			assert.equal(wav.readUInt16LE(fmt.offset + 14), 16, `${name} is 16 bit`);

			const byteRate = wav.readUInt32LE(fmt.offset + 8);
			const seconds = data.size / byteRate;
			assert.ok(seconds > 0.05 && seconds < 2, `${name} stays short (${seconds.toFixed(2)} s)`);
		}
	});

	it('points each cue at its bundled file', () => {
		assert.equal(cueFile('start', 'C:/ext'), join('C:/ext', 'sounds', 'start.wav'));
		assert.equal(cueFile('end', 'C:/ext'), join('C:/ext', 'sounds', 'end.wav'));
	});

	it('honours the per-cue switches', () => {
		assert.equal(shouldPlayCue({ start: true, end: true, volume: 15 }, 'start'), true);
		assert.equal(shouldPlayCue({ start: true, end: true, volume: 15 }, 'end'), true);
		assert.equal(shouldPlayCue({ start: false, end: true, volume: 15 }, 'start'), false);
		assert.equal(shouldPlayCue({ start: true, end: false, volume: 15 }, 'end'), false);
		assert.equal(shouldPlayCue({ start: false, end: false, volume: 15 }, 'start'), false);
		assert.deepEqual(DEFAULT_CUE_SETTINGS, { start: true, end: true, volume: 15 }, 'both cues are on, quiet by default');
		assert.equal(DEFAULT_VOLUME, 15);
	});

	it('clamps the configured volume', () => {
		assert.equal(clampVolume(15), 15);
		assert.equal(clampVolume(0), 0);
		assert.equal(clampVolume(100), 100);
		assert.equal(clampVolume(-20), 0);
		assert.equal(clampVolume(250), 100);
		assert.equal(clampVolume(Number.NaN), DEFAULT_VOLUME);
	});

	it('bakes the volume into the samples so every player obeys it', () => {
		const wav = readFileSync(join(EXTENSION_PATH, 'sounds', 'start.wav'));
		const peakOf = (buffer: Buffer): number => {
			const data = walkChunks(buffer).find(chunk => chunk.id === 'data');
			assert.ok(data, 'the WAV has samples');
			let peak = 0;
			for (let i = data.offset; i + 1 < data.offset + data.size; i += 2) {
				peak = Math.max(peak, Math.abs(buffer.readInt16LE(i)));
			}
			return peak;
		};

		const full = peakOf(wav);
		const quiet = peakOf(scaleWav(wav, 15));
		const silent = peakOf(scaleWav(wav, 0));

		assert.ok(full > 1000, 'the bundled cue has audible samples');
		assert.equal(silent, 0, 'volume 0 is silence');
		assert.ok(quiet > 0, 'volume 15 still plays');
		assert.ok(
			Math.abs(quiet - full * 0.15) <= 2,
			`volume 15 scales the peak down to ~15 % (${quiet} of ${full})`,
		);
	});

	it('prefers ffplay next to the configured ffmpeg and always has a fallback', () => {
		const windows = playerCandidates('win32', 'C:\\tools\\ffmpeg\\bin\\ffmpeg.exe', 'C:\\tmp\\start.wav');
		assert.equal(windows[0].command, 'C:\\tools\\ffmpeg\\bin\\ffplay.exe');
		assert.ok(windows[0].args.includes('C:\\tmp\\start.wav'));
		assert.equal(windows[1].command, 'powershell');

		const mac = playerCandidates('darwin', '/opt/homebrew/bin/ffmpeg', '/tmp/start.wav');
		assert.equal(mac[0].command, '/opt/homebrew/bin/ffplay');
		assert.equal(mac[1].command, 'afplay');

		const linux = playerCandidates('linux', 'ffmpeg', '/tmp/start.wav');
		assert.equal(linux[0].command, 'ffplay', 'a bare ffmpeg means ffplay on PATH');
		assert.deepEqual(linux.slice(1).map(entry => entry.command), ['paplay', 'aplay']);
	});
});
