import * as vscode from 'vscode';
import { readConfig } from './config';
import { createPcmSource } from './capture';
import type { DictationConfig } from './configTypes';
import { RecognitionPipeline } from './dictation/recognition';
import { errorMessage, type Logger } from './log';
import { createTranscriber } from './stt/createTranscriber';
import type { Transcriber } from './stt/types';

const PROVIDER_ID = 'custom-dictation';

/** Values from the proposed `vscode.proposed.speech.d.ts`. */
const enum SpeechToTextStatus {
	Started = 1,
	Recognizing = 2,
	Recognized = 3,
	Stopped = 4,
	Error = 5,
}

interface SpeechToTextEvent {
	readonly status: SpeechToTextStatus;
	readonly text?: string;
}

interface SpeechToTextSession {
	readonly onDidChange: vscode.Event<SpeechToTextEvent>;
}

interface TextToSpeechSession {
	readonly onDidChange: vscode.Event<SpeechToTextEvent>;
	synthesize(text: string): void;
}

interface ProposedSpeechApi {
	registerSpeechProvider(id: string, provider: {
		provideSpeechToTextSession(token: vscode.CancellationToken, options?: { language?: string }): SpeechToTextSession;
		provideTextToSpeechSession(token: vscode.CancellationToken, options?: { language?: string }): TextToSpeechSession;
		provideKeywordRecognitionSession(token: vscode.CancellationToken): { onDidChange: vscode.Event<never> };
	}): vscode.Disposable;
}

/**
 * Bridges the extension into VS Code's own speech service (editor dictation,
 * terminal voice). Requires the proposed `speech` API.
 */
export class SpeechProviderBridge implements vscode.Disposable {
	private registration: vscode.Disposable | undefined;

	constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly logger: Logger,
	) { }

	get isRegistered(): boolean {
		return this.registration !== undefined;
	}

	register(): void {
		if (this.registration) {
			return;
		}

		const speech = (vscode as unknown as { speech?: ProposedSpeechApi }).speech;
		if (!speech?.registerSpeechProvider) {
			throw new Error(
				'The proposed "speech" API is not enabled. Start VS Code with '
				+ `"--enable-proposed-api ${this.context.extension.id}" and reload the window.`,
			);
		}

		this.registration = speech.registerSpeechProvider(PROVIDER_ID, {
			provideSpeechToTextSession: (token, options) => this.createSpeechToTextSession(token, options?.language),
			provideTextToSpeechSession: () => this.createTextToSpeechSession(),
			provideKeywordRecognitionSession: () => ({ onDidChange: new vscode.EventEmitter<never>().event }),
		});
		this.logger.info('Registered as VS Code speech provider.');
	}

	dispose(): void {
		this.registration?.dispose();
		this.registration = undefined;
	}

	private createSpeechToTextSession(token: vscode.CancellationToken, language: string | undefined): SpeechToTextSession {
		const emitter = new vscode.EventEmitter<SpeechToTextEvent>();

		let pipeline: RecognitionPipeline | undefined;
		let transcriber: Transcriber | undefined;
		let closed = false;

		const close = async () => {
			if (closed) {
				return;
			}
			closed = true;
			if (!pipeline) {
				return;
			}
			// VS Code cancels the token when dictation ends, so this is the normal "stop":
			// the mic is released and the phrases still in flight are recognized, not aborted.
			await pipeline.stop();
			transcriber?.dispose?.();
			emitter.fire({ status: SpeechToTextStatus.Stopped });
		};

		token.onCancellationRequested(() => {
			void close();
		});

		void (async () => {
			try {
				if (token.isCancellationRequested) {
					return;
				}
				const base = await readConfig(this.context.secrets);
				const config: DictationConfig = language ? { ...base, language } : base;
				transcriber = createTranscriber(config, this.logger);

				pipeline = new RecognitionPipeline(
					createPcmSource(config, this.logger),
					transcriber,
					{
						segmenter: {
							silenceMs: config.audio.silenceMs,
							minSegmentMs: config.audio.minSegmentMs,
							maxSegmentMs: config.audio.maxSegmentMs,
							noiseThreshold: config.audio.noiseThreshold,
						},
						promptPrefix: config.openai.prompt,
						sendContextPrompt: config.openai.sendContextPrompt,
						// The speech provider appends text phrase by phrase, so the order matters.
						concurrency: 1,
					},
					this.logger,
				);

				emitter.fire({ status: SpeechToTextStatus.Started });
				await pipeline.start({
					onPhrase: text => {
						emitter.fire({ status: SpeechToTextStatus.Recognizing });
						emitter.fire({ status: SpeechToTextStatus.Recognized, text });
					},
					onError: error => {
						emitter.fire({ status: SpeechToTextStatus.Error, text: error.message });
					},
				});
			} catch (error) {
				this.logger.error('Speech provider session failed', error);
				emitter.fire({ status: SpeechToTextStatus.Error, text: errorMessage(error) });
				emitter.fire({ status: SpeechToTextStatus.Stopped });
			}
		})();

		return { onDidChange: emitter.event };
	}

	/** Text to speech is not provided; report it instead of hanging the caller. */
	private createTextToSpeechSession(): TextToSpeechSession {
		const emitter = new vscode.EventEmitter<SpeechToTextEvent>();
		return {
			onDidChange: emitter.event,
			synthesize: () => {
				emitter.fire({ status: SpeechToTextStatus.Error, text: 'Custom Dictation does not implement text to speech.' });
				emitter.fire({ status: SpeechToTextStatus.Stopped });
			},
		};
	}
}
