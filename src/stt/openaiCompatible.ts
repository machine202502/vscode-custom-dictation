import { encodeWav } from '../audio/wav';
import { httpRequest, snippet } from '../util/http';
import { buildMultipartBody } from '../util/multipart';

export interface OpenAiCompatibleConfig {
	readonly baseUrl: string;
	readonly model: string;
	readonly apiKey?: string;
	readonly language?: string;
	readonly prompt?: string;
	/** Extra multipart fields, e.g. `{ vad_filter: 'true', hotwords: 'Copilot' }`. */
	readonly extraFields?: Readonly<Record<string, unknown>>;
	readonly timeoutMs?: number;
	readonly insecureTLS?: boolean;
}

export function transcriptionUrl(baseUrl: string): string {
	const trimmed = baseUrl.trim().replace(/\/+$/, '');
	if (/\/audio\/transcriptions$/i.test(trimmed)) {
		return trimmed;
	}
	return `${trimmed}/audio/transcriptions`;
}

/** Accepts `{ "text": ... }`, `[{ "text": ... }]`, a bare JSON string and plain text. */
export function parseTranscriptionResponse(text: string): string {
	const trimmed = text.trim();
	if (!trimmed) {
		return '';
	}
	try {
		const parsed: unknown = JSON.parse(trimmed);
		if (typeof parsed === 'string') {
			return parsed;
		}
		if (Array.isArray(parsed)) {
			return parsed
				.map(item => (item && typeof (item as { text?: unknown }).text === 'string' ? String((item as { text: string }).text) : ''))
				.filter(Boolean)
				.join(' ');
		}
		if (parsed && typeof parsed === 'object') {
			const record = parsed as Record<string, unknown>;
			if (typeof record.text === 'string') {
				return record.text;
			}
			if (typeof record.transcription === 'string') {
				return record.transcription;
			}
		}
	} catch {
		// Not JSON: some servers answer with plain text.
	}
	return trimmed;
}

export async function transcribeWavOpenAiCompatible(
	wav: Buffer,
	config: OpenAiCompatibleConfig,
	signal?: AbortSignal,
): Promise<string> {
	const fields: Record<string, string | number | boolean | undefined> = {
		model: config.model || 'whisper-1',
		language: config.language,
		prompt: config.prompt,
		response_format: 'json',
	};

	for (const [key, value] of Object.entries(config.extraFields ?? {})) {
		if (value === undefined || value === null) {
			continue;
		}
		fields[key] = typeof value === 'object' ? JSON.stringify(value) : (value as string | number | boolean);
	}

	const { body, contentType } = buildMultipartBody(fields, [
		{ field: 'file', filename: 'audio.wav', contentType: 'audio/wav', data: wav },
	]);

	const headers: Record<string, string> = {
		'content-type': contentType,
		accept: 'application/json',
	};
	if (config.apiKey) {
		headers.authorization = `Bearer ${config.apiKey}`;
	}

	const response = await httpRequest(transcriptionUrl(config.baseUrl), {
		method: 'POST',
		headers,
		body,
		timeoutMs: config.timeoutMs ?? 60000,
		insecureTLS: config.insecureTLS,
		signal,
	});

	if (response.status < 200 || response.status >= 300) {
		throw new Error(`Transcription request failed with HTTP ${response.status}: ${snippet(response.text)}`);
	}

	return parseTranscriptionResponse(response.text).trim();
}

export function wavFor(pcm: Int16Array): Buffer {
	return encodeWav(pcm);
}
