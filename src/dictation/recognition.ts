import { Segmenter, type Segment, type SegmenterOptions } from '../audio/segmenter';
import { int16FromBuffer, PCM_SAMPLE_RATE, rmsOf } from '../audio/wav';
import type { PcmSource } from '../capture';
import { t } from '../i18n';
import type { Logger } from '../log';
import { joinTranscript } from '../stt/language';
import type { Transcriber } from '../stt/types';
import { asError } from '../util/errors';

export interface RecognitionHandlers {
	/** Live input level (RMS 0..1) for the recording indicator. */
	readonly onLevel?: (level: number) => void;
	/** Text recognized so far, updated while the user is still talking. */
	readonly onTranscript?: (transcript: string) => void;
	/**
	 * A single phrase was recognized. Only ordered when `concurrency` is 1 — used by the
	 * streaming speech provider, which appends text as it arrives.
	 */
	readonly onPhrase?: (text: string) => void;
	readonly onError: (error: Error) => void;
	/** The recorder stopped on its own (crash, device unplugged). */
	readonly onRecorderEnded?: () => void;
}

export interface RecognitionOptions {
	readonly segmenter: SegmenterOptions;
	/** Vocabulary hint sent to the backend. */
	readonly promptPrefix?: string;
	/** Append the tail of the recognized text to each prompt so names stay consistent. */
	readonly sendContextPrompt?: boolean;
	/** Phrases transcribed at the same time. */
	readonly concurrency?: number;
}

interface PendingPhrase {
	readonly index: number;
	readonly segment: Segment;
}

const DEFAULT_CONCURRENCY = 2;

/**
 * Capture -> voice activity segmentation -> recognition.
 *
 * Recognition runs **while** the user speaks: every finished phrase goes to the model right
 * away, so only the tail is left when the user presses stop. Stopping the recording never
 * cancels the work already in flight — the pipeline waits for every phrase and returns the
 * complete transcript, so nothing that was said can be lost.
 *
 * Phrases may finish out of order; the text is assembled by index, which keeps it ordered
 * without serializing the requests.
 */
export class RecognitionPipeline {
	private readonly segmenter: Segmenter;
	private readonly controller = new AbortController();
	private readonly concurrency: number;
	private readonly results: string[] = [];
	private readonly queue: PendingPhrase[] = [];
	private readonly inFlight = new Set<Promise<void>>();
	private handlers: RecognitionHandlers | undefined;
	private state: 'idle' | 'running' | 'stopping' = 'idle';
	private cancelled = false;
	private scheduled = 0;
	private stopPromise: Promise<string> | undefined;
	private sampleCount = 0;

	constructor(
		private readonly source: PcmSource,
		private readonly transcriber: Transcriber,
		private readonly options: RecognitionOptions,
		private readonly logger: Logger,
	) {
		this.segmenter = new Segmenter(options.segmenter);
		this.concurrency = Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY);
	}

	get durationMs(): number {
		return Math.round((this.sampleCount / PCM_SAMPLE_RATE) * 1000);
	}

	/** Text of the phrases recognized so far. */
	get text(): string {
		return joinAll(this.results);
	}

	async start(handlers: RecognitionHandlers): Promise<void> {
		if (this.state !== 'idle') {
			return;
		}
		this.handlers = handlers;
		this.state = 'running';

		this.source.onData = chunk => {
			if (this.state === 'idle' || this.cancelled) {
				return;
			}
			const pcm = int16FromBuffer(chunk);
			this.sampleCount += pcm.length;
			handlers.onLevel?.(rmsOf(pcm));
			for (const segment of this.segmenter.push(pcm)) {
				this.enqueue(segment);
			}
		};
		this.source.onError = error => {
			if (this.state === 'running') {
				this.logger.error('Capture failed', error);
				handlers.onError(error);
			}
		};
		this.source.onExit = (code, stderr) => {
			if (this.state !== 'running') {
				return;
			}
			this.logger.error(`Recorder exited unexpectedly (code ${code})`, stderr);
			handlers.onError(new Error(stderr || t('The audio recorder exited with code {0}.', code ?? '?')));
			handlers.onRecorderEnded?.();
		};

		try {
			await this.source.start();
		} catch (error) {
			this.state = 'idle';
			throw error;
		}
	}

	/**
	 * Releases the microphone and resolves with the transcript once every recorded phrase has
	 * been recognized. Idempotent: repeated calls share one run.
	 */
	async stop(): Promise<string> {
		this.stopPromise ??= this.doStop();
		return this.stopPromise;
	}

	/** Drops the audio and aborts the requests that are still running. */
	async cancel(): Promise<void> {
		this.cancelled = true;
		this.state = 'stopping';
		this.queue.length = 0;
		this.segmenter.reset();
		this.controller.abort();
		await this.source.stop().catch(() => undefined);
		await drainAll(this.inFlight);
		this.state = 'idle';
		this.logger.info('Dictation cancelled');
	}

	private async doStop(): Promise<string> {
		if (this.state === 'idle') {
			return this.text;
		}
		this.state = 'stopping';

		// The microphone is released first so nothing new arrives after the promise resolves.
		// Phrases already spoken are safe: they are queued or in flight, and both are awaited.
		await this.source.stop().catch(error => this.logger.warn(`Stopping the recorder failed: ${asError(error).message}`));
		for (const segment of this.segmenter.flush()) {
			this.enqueue(segment);
		}

		const pendingSince = Date.now();
		await drainAll(this.inFlight);
		const waited = Date.now() - pendingSince;
		this.state = 'idle';

		const transcript = this.text;
		this.logger.info(
			`Dictation stopped: ${this.scheduled} phrase(s), ${transcript.length} characters `
			+ `(waited ${waited} ms for the model)`,
		);
		return transcript;
	}

	private enqueue(segment: Segment): void {
		this.results.push('');
		this.queue.push({ index: this.scheduled++, segment });
		this.pump();
	}

	private pump(): void {
		while (this.inFlight.size < this.concurrency && this.queue.length > 0) {
			const task = this.queue.shift();
			if (!task) {
				return;
			}
			const job = this.runTask(task).finally(() => {
				this.inFlight.delete(job);
				this.pump();
			});
			this.inFlight.add(job);
		}
	}

	private buildPrompt(): string | undefined {
		const prefix = this.options.promptPrefix?.trim() ?? '';
		if (!this.options.sendContextPrompt) {
			return prefix || undefined;
		}
		const tail = this.text.slice(-200).trim();
		return [prefix, tail].filter(Boolean).join(' ').trim() || undefined;
	}

	private async runTask(task: PendingPhrase): Promise<void> {
		if (this.cancelled) {
			return;
		}
		try {
			const text = (await this.transcriber.transcribe({
				pcm: task.segment.pcm,
				prompt: this.buildPrompt(),
				signal: this.controller.signal,
			})).trim();

			if (this.cancelled || !text) {
				return;
			}

			this.results[task.index] = text;
			this.logger.info(`Phrase ${task.index + 1} (${task.segment.durationMs} ms): ${text}`);
			this.handlers?.onPhrase?.(text);
			this.handlers?.onTranscript?.(this.text);
		} catch (error) {
			if (this.cancelled) {
				return;
			}
			this.logger.error(`Transcription of phrase ${task.index + 1} failed`, error);
			this.handlers?.onError(asError(error));
		}
	}
}

/** Waits until no request is running, including the ones started while waiting. */
async function drainAll(inFlight: Set<Promise<void>>): Promise<void> {
	while (inFlight.size > 0) {
		await Promise.allSettled([...inFlight]);
	}
}

function joinAll(results: readonly string[]): string {
	let text = '';
	for (const part of results) {
		text = joinTranscript(text, part);
	}
	return text;
}
