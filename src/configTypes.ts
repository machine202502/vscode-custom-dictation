import type { CaptureFormat } from './capture/devices';

export type ProviderId = 'openai-compatible' | 'local-whisper' | 'local-onnx' | 'salute' | 'command';
export type OnnxMode = 'auto' | 'server' | 'cli';
export type InsertTarget = 'chat' | 'editor' | 'clipboard';
export type ChatInsertMode = 'paste' | 'replace';

export interface DictationConfig {
	readonly provider: ProviderId;
	/** Normalized recognition language, `undefined` lets the backend auto-detect. */
	readonly language: string | undefined;
	readonly insert: {
		readonly target: InsertTarget;
		readonly chatMode: ChatInsertMode;
		/** Copy the whole transcript when insertion failed, so nothing is lost. */
		readonly fallbackToClipboard: boolean;
	};
	readonly audio: {
		readonly ffmpegPath: string;
		readonly format: CaptureFormat;
		readonly device: string;
		/** Short cues when the recording starts and stops. */
		readonly cues: {
			readonly start: boolean;
			readonly end: boolean;
			/** Playback volume in percent. */
			readonly volume: number;
		};
		readonly silenceMs: number;
		readonly minSegmentMs: number;
		readonly maxSegmentMs: number;
		readonly noiseThreshold: number;
		/** Stop recording automatically after this much silence; 0 disables it. */
		readonly autoStopSilenceMs: number;
	};
	readonly openai: {
		readonly baseUrl: string;
		readonly model: string;
		readonly apiKey?: string;
		readonly extraFields: Record<string, unknown>;
		readonly prompt: string;
		readonly sendContextPrompt: boolean;
		readonly timeoutMs: number;
	};
	readonly salute: {
		readonly tokenUrl: string;
		readonly recognizeUrl: string;
		readonly scope: string;
		readonly clientId: string;
		readonly clientSecret?: string;
		readonly authorizationKey?: string;
		readonly insecureTLS: boolean;
	};
	readonly command: {
		readonly capture: string;
		readonly transcribe: string;
	};
	readonly local: {
		/** `.bin` model file or a folder full of whisper.cpp models. */
		readonly modelPath: string;
		/** `whisper-cli` binary; empty means auto-detect next to the model or on PATH. */
		readonly executablePath: string;
		readonly extraArgs: string;
	};
	readonly onnx: {
		/** sherpa-onnx model (GigaAM / NeMo CTC): `.onnx` file or a folder with `tokens.txt`. */
		readonly modelPath: string;
		/** `sherpa-onnx-offline` binary; empty means auto-detect. */
		readonly executablePath: string;
		/** `auto` (int8 first), `int8` or `fp32`. */
		readonly precision: string;
		/** `auto` keeps a warm local server when the websocket binary exists. */
		readonly mode: OnnxMode;
		readonly extraArgs: string;
	};
}
