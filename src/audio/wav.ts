/** Audio format used everywhere inside the extension: 16 kHz, mono, signed 16-bit little endian. */
export const PCM_SAMPLE_RATE = 16000;
export const PCM_BYTES_PER_SAMPLE = 2;

export function int16FromBuffer(buf: Buffer): Int16Array {
	const count = Math.floor(buf.length / PCM_BYTES_PER_SAMPLE);
	const samples = new Int16Array(count);
	for (let i = 0; i < count; i++) {
		samples[i] = buf.readInt16LE(i * PCM_BYTES_PER_SAMPLE);
	}
	return samples;
}

export function concatInt16(chunks: readonly Int16Array[]): Int16Array {
	let total = 0;
	for (const chunk of chunks) {
		total += chunk.length;
	}
	const result = new Int16Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		result.set(chunk, offset);
		offset += chunk.length;
	}
	return result;
}

/** Normalized RMS in the 0..1 range (1 = full scale). */
export function rmsOf(pcm: Int16Array, start = 0, end = pcm.length): number {
	const from = Math.max(0, start);
	const to = Math.min(pcm.length, end);
	if (to <= from) {
		return 0;
	}
	let sum = 0;
	for (let i = from; i < to; i++) {
		const value = pcm[i] / 32768;
		sum += value * value;
	}
	return Math.sqrt(sum / (to - from));
}

/** Wraps raw PCM into a canonical 44 byte RIFF/WAVE container. */
export function encodeWav(pcm: Int16Array, sampleRate = PCM_SAMPLE_RATE): Buffer {
	const dataLength = pcm.length * PCM_BYTES_PER_SAMPLE;
	const buffer = Buffer.alloc(44 + dataLength);

	buffer.write('RIFF', 0, 'ascii');
	buffer.writeUInt32LE(36 + dataLength, 4);
	buffer.write('WAVE', 8, 'ascii');

	buffer.write('fmt ', 12, 'ascii');
	buffer.writeUInt32LE(16, 16);
	buffer.writeUInt16LE(1, 20); // PCM
	buffer.writeUInt16LE(1, 22); // mono
	buffer.writeUInt32LE(sampleRate, 24);
	buffer.writeUInt32LE(sampleRate * PCM_BYTES_PER_SAMPLE, 28);
	buffer.writeUInt16LE(PCM_BYTES_PER_SAMPLE, 32);
	buffer.writeUInt16LE(16, 34);

	buffer.write('data', 36, 'ascii');
	buffer.writeUInt32LE(dataLength, 40);

	for (let i = 0; i < pcm.length; i++) {
		buffer.writeInt16LE(pcm[i], 44 + i * PCM_BYTES_PER_SAMPLE);
	}

	return buffer;
}

/** Raw little endian PCM bytes, as expected by streaming APIs such as SaluteSpeech. */
export function int16ToPcmBuffer(pcm: Int16Array): Buffer {
	const buffer = Buffer.alloc(pcm.length * PCM_BYTES_PER_SAMPLE);
	for (let i = 0; i < pcm.length; i++) {
		buffer.writeInt16LE(pcm[i], i * PCM_BYTES_PER_SAMPLE);
	}
	return buffer;
}
