import type { DictationConfig } from '../configTypes';
import type { PcmSource } from '../capture';
import { Inserter } from '../insert/inserter';
import { t } from '../i18n';
import type { Logger } from '../log';
import type { Transcriber } from '../stt/types';
import { asError } from '../util/errors';
import { RecognitionPipeline } from './recognition';

export type DictationState = 'listening' | 'working';

export interface DictationHooks {
	update(state: DictationState, transcript: string, elapsedMs: number, level: number): void;
	error(error: Error): void;
	end(info: DictationEndInfo): void;
}

export interface DictationEndInfo {
	readonly transcript: string;
	readonly cancelled: boolean;
	/** True when the user asked to finish by putting the text on the clipboard. */
	readonly copied: boolean;
	/** Set when recognized text could not be inserted into the target surface. */
	readonly insertFailure?: string;
	/** True when the full transcript was copied to the clipboard as a fallback. */
	readonly copiedAsFallback: boolean;
}

/**
 * One dictation run. Recognition runs in parallel with the recording, but the recognized text
 * is inserted only when the user stops, so the chat input receives one complete message.
 *
 * Stopping releases the microphone at once; the run is not over until every phrase still in
 * flight has been recognized, which is when the controller lets the microphone be used again.
 */
export class DictationSession {
	private readonly inserter: Inserter;
	private readonly pipeline: RecognitionPipeline;
	private startedAt = Date.now();
	private ticker: NodeJS.Timeout | undefined;
	private runPromise: Promise<void> | undefined;
	private level = 0;
	private copyOnFinish = false;
	private insertFailure: string | undefined;
	private transcript = '';
	private ended = false;

	constructor(
		private readonly config: DictationConfig,
		private readonly transcriber: Transcriber,
		source: PcmSource,
		logger: Logger,
		private readonly hooks: DictationHooks,
	) {
		this.inserter = new Inserter(config.insert, logger);
		this.pipeline = new RecognitionPipeline(source, transcriber, {
			segmenter: {
				silenceMs: config.audio.silenceMs,
				minSegmentMs: config.audio.minSegmentMs,
				maxSegmentMs: config.audio.maxSegmentMs,
				noiseThreshold: config.audio.noiseThreshold,
			},
			promptPrefix: config.openai.prompt,
			sendContextPrompt: config.openai.sendContextPrompt,
		}, logger);
	}

	async start(): Promise<void> {
		this.startedAt = Date.now();
		this.hooks.update('listening', '', 0, 0);
		await this.inserter.prepare();
		await this.pipeline.start({
			onLevel: level => {
				this.level = level;
			},
			onTranscript: text => {
				this.transcript = text;
			},
			onError: error => this.hooks.error(error),
			onRecorderEnded: () => {
				void this.finish();
			},
		});

		if (this.runPromise) {
			return;
		}
		this.ticker = setInterval(() => {
			this.hooks.update('listening', this.transcript, this.elapsed(), this.level);
		}, 100);
	}

	/** Mic off right away, then wait for the phrases still in flight and insert the whole text. */
	async stop(): Promise<void> {
		await this.finish();
	}

	/** Same, but the text goes to the clipboard instead of the target surface. */
	async stopAndCopy(): Promise<void> {
		if (!this.runPromise) {
			this.copyOnFinish = true;
		}
		await this.finish();
	}

	async cancel(): Promise<void> {
		if (this.runPromise) {
			// Already finishing: the audio is on its way to the model and must not be dropped.
			await this.runPromise;
			return;
		}
		this.runPromise = this.doCancel();
		await this.runPromise;
	}

	private finish(): Promise<void> {
		this.runPromise ??= this.doFinish();
		return this.runPromise;
	}

	private async doFinish(): Promise<void> {
		this.stopTicker();
		this.hooks.update('working', this.transcript, this.elapsed(), 0);

		try {
			// The microphone is already released; this waits for the tail of the recording.
			const text = await this.pipeline.stop();
			this.transcript = text;

			if (text) {
				if (this.copyOnFinish) {
					const copied = await this.inserter.copyTranscript(text);
					if (copied) {
						this.inserter.replaceTranscript(text);
					} else {
						this.insertFailure ??= this.inserter.failureMessage;
					}
				} else {
					const outcome = await this.inserter.append(text);
					if (outcome === 'failed') {
						this.insertFailure ??= this.inserter.failureMessage ?? t('Could not insert the text.');
					}
				}
			}
		} catch (error) {
			this.hooks.error(asError(error));
		} finally {
			await this.complete(false);
		}
	}

	private async doCancel(): Promise<void> {
		this.stopTicker();
		try {
			await this.pipeline.cancel();
		} finally {
			await this.complete(true);
		}
	}

	private async complete(cancelled: boolean): Promise<void> {
		if (this.ended) {
			return;
		}
		this.ended = true;
		this.stopTicker();

		let copiedAsFallback = false;

		if (!cancelled) {
			await this.inserter.finish();
			this.insertFailure ??= this.inserter.failureMessage;
			if (this.insertFailure && !this.copyOnFinish && this.config.insert.fallbackToClipboard) {
				copiedAsFallback = await this.inserter.copyTranscript(this.transcript);
			}
		}

		this.transcriber.dispose?.();
		this.hooks.end({
			transcript: this.inserter.text || this.transcript,
			cancelled,
			copied: this.copyOnFinish,
			insertFailure: this.insertFailure,
			copiedAsFallback,
		});
	}

	private stopTicker(): void {
		if (this.ticker) {
			clearInterval(this.ticker);
			this.ticker = undefined;
		}
	}

	private elapsed(): number {
		return Date.now() - this.startedAt;
	}
}
