import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { encodeWav } from '../audio/wav';
import type { DictationConfig } from '../configTypes';
import { t } from '../i18n';
import type { Logger } from '../log';
import { toBcp47, toShortLanguage } from './language';
import { transcribeWithCommand } from './commandTranscriber';
import { buildLocalWhisperCommand, findWhisperExecutable, resolveModelFile } from './localModel';
import { buildSherpaCommand, extractSherpaText, findSherpaExecutable, resolveOnnxModel, websocketServerBinary } from './sherpaOnnx';
import { SherpaServer } from './sherpaServer';
import { transcribeWavOpenAiCompatible } from './openaiCompatible';
import { SaluteTranscriber } from './salute';
import type { TranscribeRequest, Transcriber } from './types';

const noopLogger = { info: () => undefined, warn: () => undefined, error: () => undefined } as unknown as Logger;

export function createTranscriber(config: DictationConfig, logger: Logger = noopLogger): Transcriber {
	switch (config.provider) {
		case 'local-onnx': {
			const model = resolveOnnxModel(config.onnx.modelPath, { precision: config.onnx.precision });
			if (!model) {
				throw new Error(
					t(
					'No sherpa-onnx model found at "{0}". '
					+ 'Point "customDictation.onnx.modelPath" at a folder that has model.onnx + tokens.txt (GigaAM-v3, '
					+ 'or any NeMo CTC export) or at the .onnx file itself.',
					config.onnx.modelPath,
				),
				);
			}

			const executable = findSherpaExecutable({
				explicit: config.onnx.executablePath,
				modelFile: model.modelFile,
			});
			if (!executable) {
				throw new Error(
					t('sherpa-onnx was not found. Download sherpa-onnx-offline for your platform, unpack it and set '
					+ '"customDictation.onnx.executablePath" (or keep it next to the model / on PATH).'),
				);
			}

			const serverBinary = websocketServerBinary(executable);
			const wantsServer = config.onnx.mode !== 'cli' && serverBinary !== executable;
			const serverAvailable = wantsServer && existsSync(serverBinary);

			if (serverAvailable) {
				const server = new SherpaServer({
					executable: serverBinary,
					modelFile: model.modelFile,
					tokensFile: model.tokensFile,
					extraArgs: config.onnx.extraArgs,
				}, logger);
				logger.info(`Using warm sherpa-onnx server with ${join(model.modelFile)}`);
				return {
					label: `sherpa-onnx server (${model.modelFile})`,
					transcribe: (request: TranscribeRequest) => server.transcribe(request.pcm, request.signal),
					dispose: () => server.dispose(),
				};
			}

			const command = buildSherpaCommand({
				executable,
				modelFile: model.modelFile,
				tokensFile: model.tokensFile,
				extraArgs: config.onnx.extraArgs,
			});

			return {
				label: `sherpa-onnx CLI (${model.modelFile})`,
				transcribe: (request: TranscribeRequest) => transcribeWithCommand(request.pcm, {
					command,
					timeoutMs: config.openai.timeoutMs,
					parse: extractSherpaText,
				}, request.signal),
			};
		}
		case 'local-whisper': {
			const modelFile = resolveModelFile(config.local.modelPath);
			if (!modelFile) {
				throw new Error(
					t(
					'No whisper.cpp model found at "{0}". '
					+ 'Point "customDictation.local.modelPath" at a .bin model file or at a folder that contains ggml-*.bin models.',
					config.local.modelPath,
				),
				);
			}

			const executable = findWhisperExecutable({
				explicit: config.local.executablePath,
				modelFile,
			});
			if (!executable) {
				throw new Error(
					t('whisper-cli was not found. Set "customDictation.local.executablePath" to whisper-cli.exe '
					+ '(whisper.cpp release build) or put it next to the model / on PATH.'),
				);
			}

			const command = buildLocalWhisperCommand({
				executable,
				modelFile,
				language: toShortLanguage(config.language),
				extraArgs: config.local.extraArgs,
			});

			return {
				label: `local whisper.cpp (${modelFile})`,
				transcribe: (request: TranscribeRequest) => transcribeWithCommand(request.pcm, {
					command,
					timeoutMs: config.openai.timeoutMs,
				}, request.signal),
			};
		}
		case 'salute': {
			const client = new SaluteTranscriber({
				tokenUrl: config.salute.tokenUrl,
				recognizeUrl: config.salute.recognizeUrl,
				scope: config.salute.scope,
				clientId: config.salute.clientId,
				clientSecret: config.salute.clientSecret,
				authorizationKey: config.salute.authorizationKey,
				language: toBcp47(config.language),
				insecureTLS: config.salute.insecureTLS,
				timeoutMs: config.openai.timeoutMs,
			});
			return {
				label: 'SaluteSpeech',
				transcribe: (request: TranscribeRequest) => client.transcribePcm(request.pcm, request.signal),
			};
		}
		case 'command': {
			return {
				label: 'command',
				transcribe: (request: TranscribeRequest) => transcribeWithCommand(request.pcm, {
					command: config.command.transcribe,
					timeoutMs: config.openai.timeoutMs,
				}, request.signal),
			};
		}
		default: {
			return {
				label: `OpenAI-compatible ${config.openai.baseUrl} (${config.openai.model})`,
				transcribe: (request: TranscribeRequest) => transcribeWavOpenAiCompatible(encodeWav(request.pcm), {
					baseUrl: config.openai.baseUrl,
					model: config.openai.model,
					apiKey: config.openai.apiKey,
					language: toShortLanguage(config.language),
					prompt: request.prompt,
					extraFields: config.openai.extraFields,
					timeoutMs: config.openai.timeoutMs,
				}, request.signal),
			};
		}
	}
}
