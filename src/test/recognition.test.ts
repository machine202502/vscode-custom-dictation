import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { PcmSource } from '../capture';
import type { Logger } from '../log';
import type { TranscribeRequest, Transcriber } from '../stt/types';
import { RecognitionPipeline } from '../dictation/recognition';

const SAMPLE_RATE = 16000;

const logger = { info: () => undefined, warn: () => undefined, error: () => undefined } as unknown as Logger;

class FakeSource implements PcmSource {
	onData: (chunk: Buffer) => void = () => undefined;
	onError: (error: Error) => void = () => undefined;
	onExit: (code: number | null, stderr: string) => void = () => undefined;
	stopped = false;

	async start(): Promise<void> {
		this.stopped = false;
	}

	async stop(): Promise<void> {
		this.stopped = true;
	}

	emit(pcm: Int16Array): void {
		this.onData(Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength));
	}

	die(message: string): void {
		this.onExit(1, message);
	}
}

interface Call {
	readonly pcm: Int16Array;
	resolve: (text: string) => void;
	reject: (error: Error) => void;
}

/** Transcriber whose requests are settled by the test, so timing can be inspected. */
class ControlledTranscriber implements Transcriber {
	readonly label = 'fake';
	readonly calls: Call[] = [];

	transcribe(request: TranscribeRequest): Promise<string> {
		return new Promise<string>((resolve, reject) => {
			request.signal?.addEventListener('abort', () => reject(new Error('aborted')));
			this.calls.push({ pcm: request.pcm, resolve, reject });
		});
	}

	settle(index: number, text: string): void {
		this.calls[index].resolve(text);
	}
}

function tone(ms: number): Int16Array {
	const samples = Math.round((SAMPLE_RATE * ms) / 1000);
	const result = new Int16Array(samples);
	for (let i = 0; i < samples; i++) {
		result[i] = Math.round(Math.sin((2 * Math.PI * 300 * i) / SAMPLE_RATE) * 0.4 * 32767);
	}
	return result;
}

function silence(ms: number): Int16Array {
	return new Int16Array(Math.round((SAMPLE_RATE * ms) / 1000));
}

const tick = () => new Promise<void>(resolve => setTimeout(resolve, 5));

function pipelineFor(source: PcmSource, transcriber: Transcriber, concurrency = 2): RecognitionPipeline {
	return new RecognitionPipeline(source, transcriber, {
		segmenter: { silenceMs: 300, minSegmentMs: 200, maxSegmentMs: 5000, noiseThreshold: 0 },
		concurrency,
	}, logger);
}

describe('RecognitionPipeline', () => {
	it('recognizes phrases while the user is still speaking', async () => {
		const source = new FakeSource();
		const transcriber = new ControlledTranscriber();
		const pipeline = pipelineFor(source, transcriber);

		await pipeline.start({ onError: () => undefined });
		source.emit(tone(400));
		source.emit(silence(350));

		assert.equal(transcriber.calls.length, 1, 'the first phrase is already on its way to the model');
		assert.equal(source.stopped, false, 'the microphone is still recording');

		source.emit(tone(400));
		source.emit(silence(350));
		assert.equal(transcriber.calls.length, 2);
	});

	it('waits for the phrases in flight on stop and returns them in order', async () => {
		const source = new FakeSource();
		const transcriber = new ControlledTranscriber();
		const pipeline = pipelineFor(source, transcriber);

		await pipeline.start({ onError: () => undefined });
		source.emit(tone(400));
		source.emit(silence(350));
		source.emit(tone(400));
		source.emit(silence(350));

		let settled = false;
		const stopped = pipeline.stop().then(text => {
			settled = true;
			return text;
		});
		await tick();

		assert.equal(source.stopped, true, 'stopping releases the microphone at once');
		assert.equal(settled, false, 'stop does not resolve while the model is still working');

		// Answered out of order: the text is still assembled by phrase position.
		transcriber.settle(1, 'вторая');
		transcriber.settle(0, 'первая');

		assert.equal(await stopped, 'первая вторая');
	});

	it('sends the tail that never got a pause instead of dropping it', async () => {
		const source = new FakeSource();
		const transcriber = new ControlledTranscriber();
		const pipeline = pipelineFor(source, transcriber);

		await pipeline.start({ onError: () => undefined });
		source.emit(tone(120));

		const stopped = pipeline.stop();
		await tick();
		assert.equal(transcriber.calls.length, 1, 'a short last phrase is still sent to the model');
		assert.ok(transcriber.calls[0].pcm.length > 0);

		transcriber.settle(0, 'да');
		assert.equal(await stopped, 'да');
	});

	it('keeps the recording when the recorder dies', async () => {
		const source = new FakeSource();
		const transcriber = new ControlledTranscriber();
		const pipeline = pipelineFor(source, transcriber);
		const errors: Error[] = [];

		await pipeline.start({ onError: error => errors.push(error) });
		source.emit(tone(400));
		source.die('device lost');

		const stopped = pipeline.stop();
		await tick();
		transcriber.settle(0, 'фраза');

		assert.equal(await stopped, 'фраза');
		assert.equal(errors.length, 1);
	});

	it('aborts everything on cancel', async () => {
		const source = new FakeSource();
		const transcriber = new ControlledTranscriber();
		const pipeline = pipelineFor(source, transcriber);

		await pipeline.start({ onError: () => undefined });
		source.emit(tone(400));
		source.emit(silence(350));
		assert.equal(transcriber.calls.length, 1);

		await pipeline.cancel();

		assert.equal(await pipeline.stop(), '');
	});
});
