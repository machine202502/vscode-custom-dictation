import * as vscode from 'vscode';
import { resolveCaptureFormat } from './capture/devices';
import type { ChatInsertMode, DictationConfig, InsertTarget, OnnxMode, ProviderId } from './configTypes';
import { resolveConfiguredLanguage } from './stt/language';

export const SECRET_KEYS = {
	openAiApiKey: 'customDictation.openAiApiKey',
	saluteClientSecret: 'customDictation.saluteClientSecret',
	saluteAuthorizationKey: 'customDictation.saluteAuthorizationKey',
} as const;

const SECTION = 'customDictation';

export async function readConfig(secrets: vscode.SecretStorage): Promise<DictationConfig> {
	const config = vscode.workspace.getConfiguration(SECTION);
	const accessibility = vscode.workspace.getConfiguration('accessibility');

	const language = resolveConfiguredLanguage(
		config.get<string>('language', 'auto'),
		accessibility.get<string>('voice.speechLanguage'),
		Intl.DateTimeFormat().resolvedOptions().locale,
	);

	const apiKey = await secrets.get(SECRET_KEYS.openAiApiKey);
	const saluteClientSecret = await secrets.get(SECRET_KEYS.saluteClientSecret);
	const saluteAuthorizationKey = await secrets.get(SECRET_KEYS.saluteAuthorizationKey);

	return {
		provider: config.get<ProviderId>('provider', 'openai-compatible'),
		language,
		insert: {
			target: config.get<InsertTarget>('insert.target', 'chat'),
			chatMode: config.get<ChatInsertMode>('insert.chatMode', 'paste'),
			fallbackToClipboard: config.get<boolean>('insert.fallbackToClipboard', true),
		},
		audio: {
			ffmpegPath: config.get<string>('audio.ffmpegPath', 'ffmpeg') || 'ffmpeg',
			format: resolveCaptureFormat(config.get<string>('audio.inputFormat', 'auto')),
			device: config.get<string>('audio.device', ''),
			cues: {
				start: config.get<boolean>('audio.cues.start', true),
				end: config.get<boolean>('audio.cues.end', true),
				volume: config.get<number>('audio.cues.volume', 15),
			},
			silenceMs: config.get<number>('audio.silenceMs', 600),
			minSegmentMs: config.get<number>('audio.minSegmentMs', 400),
			maxSegmentMs: config.get<number>('audio.maxSegmentMs', 15000),
			noiseThreshold: config.get<number>('audio.noiseThreshold', 0),
			autoStopSilenceMs: config.get<number>('audio.autoStopSilenceMs', 60000),
		},
		openai: {
			baseUrl: config.get<string>('openai.baseUrl', 'http://127.0.0.1:8000/v1'),
			model: config.get<string>('openai.model', 'whisper-1'),
			apiKey: apiKey || undefined,
			extraFields: config.get<Record<string, unknown>>('openai.extraBody', {}) ?? {},
			prompt: config.get<string>('openai.prompt', ''),
			sendContextPrompt: config.get<boolean>('openai.sendContextPrompt', true),
			timeoutMs: config.get<number>('openai.requestTimeoutMs', 60000),
		},
		salute: {
			tokenUrl: config.get<string>('salute.tokenUrl', 'https://ngw.devices.sberbank.ru:9443/api/v2/oauth'),
			recognizeUrl: config.get<string>('salute.recognizeUrl', 'https://smartspeech.sber.ru/rest/v1/speech:recognize'),
			scope: config.get<string>('salute.scope', 'SALUTE_SPEECH_PERS'),
			clientId: config.get<string>('salute.clientId', ''),
			clientSecret: saluteClientSecret || undefined,
			authorizationKey: saluteAuthorizationKey || undefined,
			insecureTLS: config.get<boolean>('salute.insecureTLS', false),
		},
		command: {
			capture: config.get<string>('command.capture', ''),
			transcribe: config.get<string>('command.transcribe', ''),
		},
		local: {
			modelPath: config.get<string>('local.modelPath', ''),
			executablePath: config.get<string>('local.executablePath', ''),
			extraArgs: config.get<string>('local.extraArgs', ''),
		},
		onnx: {
			modelPath: config.get<string>('onnx.modelPath', ''),
			executablePath: config.get<string>('onnx.executablePath', ''),
			precision: config.get<string>('onnx.precision', 'auto'),
			mode: config.get<OnnxMode>('onnx.mode', 'auto'),
			extraArgs: config.get<string>('onnx.extraArgs', ''),
		},
	};
}

export async function updateSetting(key: string, value: unknown): Promise<void> {
	await vscode.workspace.getConfiguration(SECTION).update(key, value, vscode.ConfigurationTarget.Global);
}
