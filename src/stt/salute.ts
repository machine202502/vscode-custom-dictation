import { randomUUID } from 'node:crypto';
import { int16ToPcmBuffer } from '../audio/wav';
import { httpRequest, snippet } from '../util/http';

export interface SaluteConfig {
	readonly tokenUrl: string;
	readonly recognizeUrl: string;
	/** Ready-made Basic credentials ("Authorization key" from the Sber studio). */
	readonly authorizationKey?: string;
	readonly clientId?: string;
	readonly clientSecret?: string;
	readonly scope: string;
	readonly language: string;
	readonly insecureTLS?: boolean;
	readonly timeoutMs?: number;
}

interface TokenState {
	readonly value: string;
	readonly expiresAt: number;
}

const TOKEN_MARGIN_MS = 60_000;

/**
 * Sber SaluteSpeech recognition (GigaAM acoustic model).
 * Shares the OAuth flow with GigaChat: Basic credentials -> access token -> REST call.
 */
export class SaluteTranscriber {
	private token: TokenState | undefined;

	constructor(private readonly config: SaluteConfig) { }

	async transcribePcm(pcm: Int16Array, signal?: AbortSignal): Promise<string> {
		const body = int16ToPcmBuffer(pcm);

		let accessToken = await this.getToken(false, signal);
		let response = await this.recognize(accessToken, body, signal);
		if (response.status === 401) {
			accessToken = await this.getToken(true, signal);
			response = await this.recognize(accessToken, body, signal);
		}

		if (response.status < 200 || response.status >= 300) {
			throw new Error(`SaluteSpeech request failed with HTTP ${response.status}: ${snippet(response.text)}`);
		}

		return parseSaluteResponse(response.text);
	}

	private async recognize(token: string, body: Buffer, signal?: AbortSignal) {
		const url = new URL(this.config.recognizeUrl);
		if (!url.searchParams.has('language')) {
			url.searchParams.set('language', this.config.language);
		}

		return httpRequest(url.toString(), {
			method: 'POST',
			headers: {
				authorization: `Bearer ${token}`,
				'content-type': 'audio/x-pcm;bit=16;rate=16000',
			},
			body,
			timeoutMs: this.config.timeoutMs ?? 60000,
			insecureTLS: this.config.insecureTLS,
			signal,
		});
	}

	private async getToken(force: boolean, signal?: AbortSignal): Promise<string> {
		if (!force && this.token && this.token.expiresAt - TOKEN_MARGIN_MS > Date.now()) {
			return this.token.value;
		}

		const credentials = this.basicCredentials();
		const response = await httpRequest(this.config.tokenUrl, {
			method: 'POST',
			headers: {
				authorization: `Basic ${credentials}`,
				rquid: randomUUID(),
				'content-type': 'application/x-www-form-urlencoded',
				accept: 'application/json',
			},
			body: Buffer.from(`scope=${encodeURIComponent(this.config.scope)}`, 'utf8'),
			timeoutMs: this.config.timeoutMs ?? 30000,
			insecureTLS: this.config.insecureTLS,
			signal,
		});

		if (response.status < 200 || response.status >= 300) {
			throw new Error(`SaluteSpeech authorization failed with HTTP ${response.status}: ${snippet(response.text)}`);
		}

		let payload: { access_token?: unknown; expires_at?: unknown };
		try {
			payload = JSON.parse(response.text) as typeof payload;
		} catch {
			throw new Error(`SaluteSpeech authorization returned invalid JSON: ${snippet(response.text)}`);
		}

		if (typeof payload.access_token !== 'string' || !payload.access_token) {
			throw new Error(`SaluteSpeech authorization response has no access_token: ${snippet(response.text)}`);
		}

		this.token = {
			value: payload.access_token,
			expiresAt: normalizeExpiry(payload.expires_at),
		};
		return this.token.value;
	}

	private basicCredentials(): string {
		if (this.config.authorizationKey) {
			return this.config.authorizationKey.trim();
		}
		if (this.config.clientId && this.config.clientSecret) {
			return Buffer.from(`${this.config.clientId}:${this.config.clientSecret}`, 'utf8').toString('base64');
		}
		throw new Error('SaluteSpeech credentials are missing. Run "Custom Dictation: Set SaluteSpeech Credentials".');
	}
}

export function parseSaluteResponse(text: string): string {
	try {
		const payload = JSON.parse(text) as { result?: unknown; status?: unknown; message?: unknown };
		if (Array.isArray(payload.result)) {
			return payload.result.filter(part => typeof part === 'string').join(' ').trim();
		}
		if (typeof payload.message === 'string' && payload.status !== undefined) {
			throw new Error(`SaluteSpeech error ${String(payload.status)}: ${payload.message}`);
		}
	} catch (error) {
		if (error instanceof Error && error.message.startsWith('SaluteSpeech error')) {
			throw error;
		}
	}
	return text.trim();
}

function normalizeExpiry(expiresAt: unknown): number {
	if (typeof expiresAt === 'number' && Number.isFinite(expiresAt)) {
		if (expiresAt > 1e12) {
			return expiresAt; // milliseconds since epoch
		}
		if (expiresAt > 1e9) {
			return expiresAt * 1000; // seconds since epoch
		}
		return Date.now() + expiresAt * 1000; // relative seconds
	}
	return Date.now() + 25 * 60_000;
}
