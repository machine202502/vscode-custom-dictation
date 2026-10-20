import assert from 'node:assert/strict';
import Module from 'node:module';
import { describe, it, before, beforeEach } from 'node:test';
import type { PcmSource } from '../capture';
import type { DictationConfig, InsertTarget } from '../configTypes';
import type { Logger } from '../log';
import type { DictationEndInfo, DictationState } from '../dictation/session';

const SAMPLE_RATE = 16000;

const state = {
	clipboard: '',
	writes: [] as string[],
	pasted: 0,
	failingCommands: [] as string[],
};

function installVscodeStub(): void {
	const stub = {
		env: {
			clipboard: {
				readText: async () => state.clipboard,
				writeText: async (text: string) => {
					state.clipboard = text;
					state.writes.push(text);
				},
			},
		},
		commands: {
			executeCommand: async (command: string) => {
				if (state.failingCommands.includes(command)) {
					throw new Error(`command ${command} failed`);
				}
				if (command === 'editor.action.clipboardPasteAction') {
					state.pasted++;
				}
			},
		},
		window: { get activeTextEditor() { return undefined; } },
		workspace: { getConfiguration: () => ({ get: (_key: string, fallback?: unknown) => fallback }) },
		Position: class {
			constructor(readonly line: number, readonly character: number) { }
			translate() { return this; }
		},
		Selection: class {
			constructor(readonly anchor: unknown, readonly active: unknown) { }
		},
	};

	const moduleWithLoad = Module as unknown as { _load: (request: string, ...rest: unknown[]) => unknown };
	const original = moduleWithLoad._load;
	moduleWithLoad._load = function (request: string, ...rest: unknown[]) {
		if (request === 'vscode') {
			return stub;
		}
		return original.call(Module, request, ...rest);
	};
}

class FakeSource implements PcmSource {
	onData: (chunk: Buffer) => void = () => undefined;
	onError: (error: Error) => void = () => undefined;
	onExit: (code: number | null, stderr: string) => void = () => undefined;
	started = false;

	async start(): Promise<void> {
		this.started = true;
	}

	async stop(): Promise<void> {
		this.started = false;
	}

	emit(pcm: Int16Array): void {
		this.onData(Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength));
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

const logger = { info: () => undefined, warn: () => undefined, error: () => undefined, show: () => undefined } as unknown as Logger;

const PHRASE = 'фраза';
const TRANSCRIPT = 'фраза фраза';

function config(options: { target?: InsertTarget; fallbackToClipboard?: boolean } = {}): DictationConfig {
	return {
		provider: 'openai-compatible',
		language: 'ru-RU',
		insert: {
			target: options.target ?? 'clipboard',
			chatMode: 'paste',
			fallbackToClipboard: options.fallbackToClipboard ?? true,
		},
		audio: {
			ffmpegPath: 'ffmpeg',
			format: 'dshow',
			device: '',
			cues: { start: true, end: true, volume: 15 },
			silenceMs: 300,
			minSegmentMs: 200,
			maxSegmentMs: 5000,
			noiseThreshold: 0,
			autoStopSilenceMs: 0,
		},
		openai: {
			baseUrl: 'http://127.0.0.1:1/v1',
			model: 'm',
			extraFields: {},
			prompt: '',
			sendContextPrompt: true,
			timeoutMs: 1000,
		},
		salute: { tokenUrl: '', recognizeUrl: '', scope: '', clientId: '', insecureTLS: false },
		command: { capture: '', transcribe: '' },
		local: { modelPath: '', executablePath: '', extraArgs: '' },
		onnx: { modelPath: '', executablePath: '', precision: 'auto', mode: 'auto', extraArgs: '' },
	};
}

const transcriber = {
	label: 'fake',
	transcribe: async () => PHRASE,
};

describe('DictationSession', () => {
	before(() => {
		installVscodeStub();
	});

	beforeEach(() => {
		state.clipboard = '';
		state.writes.length = 0;
		state.pasted = 0;
		state.failingCommands = [];
	});

	async function runSession(
		cfg: DictationConfig,
		finish: 'stop' | 'copy' | 'cancel' = 'stop',
		beforeStop?: () => void,
	): Promise<{ ends: DictationEndInfo[]; states: DictationState[] }> {
		const sessionModule = require('../dictation/session') as typeof import('../dictation/session');
		const source = new FakeSource();
		const ends: DictationEndInfo[] = [];
		const states: DictationState[] = [];

		const session = new sessionModule.DictationSession(cfg, transcriber, source, logger, {
			update: updateState => states.push(updateState),
			error: () => undefined,
			end: info => ends.push(info),
		});

		await session.start();
		source.emit(tone(400));
		source.emit(silence(350));
		source.emit(tone(400));
		source.emit(silence(350));
		beforeStop?.();

		if (finish === 'cancel') {
			await session.cancel();
		} else if (finish === 'copy') {
			await session.stopAndCopy();
		} else {
			await session.stop();
		}
		return { ends, states };
	}

	it('fills the clipboard once for the clipboard target', async () => {
		const { ends } = await runSession(config({ target: 'clipboard' }));

		assert.equal(ends.length, 1);
		assert.equal(ends[0].transcript, TRANSCRIPT);
		assert.equal(ends[0].cancelled, false);
		assert.deepEqual(state.writes, [TRANSCRIPT]);
		assert.equal(state.pasted, 0);
	});

	it('inserts nothing while the user is still speaking', async () => {
		let pastedWhileListening = -1;
		await runSession(config({ target: 'chat' }), 'stop', () => {
			pastedWhileListening = state.pasted;
		});

		assert.equal(pastedWhileListening, 0, 'phrases are not inserted as they are recognized');
		assert.equal(state.pasted, 1, 'the whole take is pasted once, after the stop');
	});

	it('marks the cooldown state while the model finishes the tail', async () => {
		const { states } = await runSession(config({ target: 'clipboard' }));

		assert.deepEqual(states.slice(0, 1), ['listening']);
		assert.ok(states.includes('working'), 'the session reports that it is still processing');
	});

	it('stop and copy puts the transcript on the clipboard and inserts nothing', async () => {
		const { ends } = await runSession(config({ target: 'chat' }), 'copy');

		assert.equal(state.pasted, 0, 'nothing is pasted while copying');
		assert.deepEqual(state.writes, [TRANSCRIPT]);
		assert.equal(ends[0].transcript, TRANSCRIPT);
		assert.equal(ends[0].copied, true);
		assert.equal(ends[0].insertFailure, undefined);
		assert.equal(ends[0].copiedAsFallback, false);
	});

	it('reports a failed chat insert and copies the text as a fallback', async () => {
		state.failingCommands = ['editor.action.clipboardPasteAction'];

		const { ends } = await runSession(config({ target: 'chat', fallbackToClipboard: true }));

		assert.ok(ends[0].insertFailure, 'the failure is surfaced to the user');
		assert.match(ends[0].insertFailure ?? '', /did not reach the chat input/);
		assert.equal(ends[0].copiedAsFallback, true);
		assert.ok(state.writes.includes(TRANSCRIPT), 'the full transcript lands on the clipboard');
	});

	it('does not copy the transcript when the fallback is disabled', async () => {
		state.failingCommands = ['editor.action.clipboardPasteAction'];

		const { ends } = await runSession(config({ target: 'chat', fallbackToClipboard: false }));

		assert.ok(ends[0].insertFailure);
		assert.equal(ends[0].copiedAsFallback, false);
		assert.deepEqual(state.writes.filter(text => text === TRANSCRIPT), [], 'the whole transcript is not copied');
	});

	it('reports a failure when the chat input cannot be opened', async () => {
		state.failingCommands = ['workbench.action.chat.open', 'workbench.action.chat.focusInput'];

		const { ends } = await runSession(config({ target: 'chat' }));

		assert.ok(ends[0].insertFailure);
		assert.match(ends[0].insertFailure ?? '', /Copilot Chat/);
	});

	it('drops the text on cancel', async () => {
		const { ends } = await runSession(config({ target: 'clipboard' }), 'cancel');

		assert.equal(ends[0].transcript, '');
		assert.equal(ends[0].cancelled, true);
		assert.deepEqual(state.writes, []);
	});

	it('ignores a repeated stop instead of inserting twice', async () => {
		const sessionModule = require('../dictation/session') as typeof import('../dictation/session');
		const source = new FakeSource();
		const ends: DictationEndInfo[] = [];
		const session = new sessionModule.DictationSession(config({ target: 'chat' }), transcriber, source, logger, {
			update: () => undefined,
			error: () => undefined,
			end: info => ends.push(info),
		});

		await session.start();
		source.emit(tone(400));
		source.emit(silence(350));

		await Promise.all([session.stop(), session.stop()]);
		await session.stop();

		assert.equal(ends.length, 1);
		assert.equal(state.pasted, 1, 'a second stop neither pastes again nor ends twice');
	});
});
