import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { encodeWav, int16FromBuffer, int16ToPcmBuffer, rmsOf } from '../audio/wav';

describe('wav helpers', () => {
	it('writes a valid RIFF/WAVE header for 16 kHz mono PCM16', () => {
		const pcm = new Int16Array([0, 1000, -1000, 32767, -32768]);
		const wav = encodeWav(pcm);

		assert.equal(wav.length, 44 + pcm.length * 2);
		assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
		assert.equal(wav.readUInt32LE(4), 36 + pcm.length * 2);
		assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
		assert.equal(wav.toString('ascii', 12, 16), 'fmt ');
		assert.equal(wav.readUInt16LE(20), 1, 'PCM format');
		assert.equal(wav.readUInt16LE(22), 1, 'mono');
		assert.equal(wav.readUInt32LE(24), 16000, 'sample rate');
		assert.equal(wav.readUInt32LE(28), 32000, 'byte rate');
		assert.equal(wav.readUInt16LE(32), 2, 'block align');
		assert.equal(wav.readUInt16LE(34), 16, 'bits per sample');
		assert.equal(wav.toString('ascii', 36, 40), 'data');
		assert.equal(wav.readUInt32LE(40), pcm.length * 2);
		assert.equal(wav.readInt16LE(44 + 2), 1000);
	});

	it('round-trips buffers and Int16 samples', () => {
		const pcm = new Int16Array([-1, 0, 1, 12345]);
		const buffer = int16ToPcmBuffer(pcm);

		assert.equal(buffer.length, pcm.length * 2);
		assert.deepEqual(Array.from(int16FromBuffer(buffer)), Array.from(pcm));
	});

	it('computes normalized RMS', () => {
		const silence = new Int16Array(1600);
		assert.equal(rmsOf(silence), 0);

		const full = new Int16Array(100).fill(32767);
		assert.ok(Math.abs(rmsOf(full) - 1) < 0.001);
	});
});
