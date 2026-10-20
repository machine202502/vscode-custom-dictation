import assert from 'node:assert/strict';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, it } from 'node:test';
import { transcribeWavOpenAiCompatible } from '../stt/openaiCompatible';
import { SaluteTranscriber } from '../stt/salute';

interface CapturedRequest {
	readonly url: string;
	readonly headers: IncomingMessage['headers'];
	readonly body: Buffer;
}

interface MockServer {
	readonly url: string;
	readonly requests: CapturedRequest[];
	close(): Promise<void>;
}

async function startServer(handler: (request: CapturedRequest, respond: (status: number, body: string) => void) => void): Promise<MockServer> {
	const requests: CapturedRequest[] = [];
	const server = createServer((request, response) => {
		const chunks: Buffer[] = [];
		request.on('data', chunk => chunks.push(chunk as Buffer));
		request.on('end', () => {
			const captured: CapturedRequest = {
				url: request.url ?? '',
				headers: request.headers,
				body: Buffer.concat(chunks),
			};
			requests.push(captured);
			handler(captured, (status, body) => {
				const payload = Buffer.from(body, 'utf8');
				response.writeHead(status, { 'content-type': 'application/json', 'content-length': String(payload.length) });
				response.end(payload);
			});
		});
	});

	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
	const address = server.address() as AddressInfo;

	return {
		url: `http://127.0.0.1:${address.port}`,
		requests,
		close: () => new Promise<void>(resolve => server.close(() => resolve())),
	};
}

describe('OpenAI-compatible transcriber', () => {
	it('uploads multipart audio and returns recognized text', async () => {
		const server = await startServer((_request, respond) => respond(200, JSON.stringify({ text: 'привет, мир' })));

		try {
			const text = await transcribeWavOpenAiCompatible(Buffer.from('RIFFfakewav'), {
				baseUrl: `${server.url}/v1`,
				model: 'whisper-1',
				apiKey: 'secret-key',
				language: 'ru',
				prompt: 'контекст диктовки',
				extraFields: { vad_filter: true, hotwords: 'Copilot' },
			});

			assert.equal(text, 'привет, мир');
			assert.equal(server.requests.length, 1);

			const request = server.requests[0];
			assert.equal(request.url, '/v1/audio/transcriptions');
			assert.equal(request.headers.authorization, 'Bearer secret-key');
			assert.match(String(request.headers['content-type']), /^multipart\/form-data; boundary=----customDictation/);

			const body = request.body.toString('utf8');
			assert.ok(body.includes('name="model"\r\n\r\nwhisper-1'));
			assert.ok(body.includes('name="language"\r\n\r\nru'));
			assert.ok(body.includes('name="prompt"\r\n\r\nконтекст диктовки'));
			assert.ok(body.includes('name="response_format"\r\n\r\njson'));
			assert.ok(body.includes('name="vad_filter"\r\n\r\ntrue'));
			assert.ok(body.includes('name="hotwords"\r\n\r\nCopilot'));
			assert.ok(body.includes('filename="audio.wav"'));
			assert.ok(body.includes('RIFFfakewav'));
		} finally {
			await server.close();
		}
	});

	it('reports HTTP errors with the server message', async () => {
		const server = await startServer((_request, respond) => respond(500, 'model not loaded'));

		try {
			await assert.rejects(
				() => transcribeWavOpenAiCompatible(Buffer.from('x'), { baseUrl: server.url, model: 'm' }),
				/HTTP 500: model not loaded/,
			);
		} finally {
			await server.close();
		}
	});

	it('sends no auth header when no key is configured', async () => {
		const server = await startServer((_request, respond) => respond(200, '{"text":""}'));

		try {
			const text = await transcribeWavOpenAiCompatible(Buffer.from('x'), { baseUrl: server.url, model: 'm' });
			assert.equal(text, '');
			assert.equal(server.requests[0].headers.authorization, undefined);
		} finally {
			await server.close();
		}
	});
});

describe('SaluteSpeech transcriber', () => {
	it('obtains an OAuth token once and posts raw PCM', async () => {
		let tokens = 0;
		const server = await startServer((request, respond) => {
			if (request.url.startsWith('/oauth')) {
				tokens++;
				respond(200, JSON.stringify({ access_token: `token-${tokens}`, expires_at: 3600 }));
				return;
			}
			respond(200, JSON.stringify({ status: 200, result: ['привет', 'мир'] }));
		});

		try {
			const transcriber = new SaluteTranscriber({
				tokenUrl: `${server.url}/oauth`,
				recognizeUrl: `${server.url}/recognize`,
				authorizationKey: 'base64key',
				scope: 'SALUTE_SPEECH_PERS',
				language: 'ru-RU',
			});

			const pcm = new Int16Array([1, 2, 3, 4]);
			assert.equal(await transcriber.transcribePcm(pcm), 'привет мир');
			assert.equal(await transcriber.transcribePcm(pcm), 'привет мир');

			assert.equal(tokens, 1, 'token is cached between phrases');

			const oauth = server.requests[0];
			assert.equal(oauth.headers.authorization, 'Basic base64key');
			assert.equal(oauth.body.toString(), 'scope=SALUTE_SPEECH_PERS');
			assert.ok(oauth.headers.rquid, 'RqUID header is sent');

			const recognize = server.requests[1];
			assert.equal(recognize.url, '/recognize?language=ru-RU');
			assert.equal(recognize.headers.authorization, 'Bearer token-1');
			assert.equal(recognize.headers['content-type'], 'audio/x-pcm;bit=16;rate=16000');
			assert.equal(recognize.body.length, 8, 'raw PCM without a WAV header');
		} finally {
			await server.close();
		}
	});

	it('refreshes the token after a 401', async () => {
		let tokens = 0;
		let recognitions = 0;
		const server = await startServer((request, respond) => {
			if (request.url.startsWith('/oauth')) {
				tokens++;
				respond(200, JSON.stringify({ access_token: `token-${tokens}`, expires_at: 3600 }));
				return;
			}
			recognitions++;
			respond(recognitions === 1 ? 401 : 200, JSON.stringify({ status: 200, result: ['ок'] }));
		});

		try {
			const transcriber = new SaluteTranscriber({
				tokenUrl: `${server.url}/oauth`,
				recognizeUrl: `${server.url}/recognize`,
				clientId: 'id',
				clientSecret: 'secret',
				scope: 'SALUTE_SPEECH_PERS',
				language: 'ru-RU',
			});

			assert.equal(await transcriber.transcribePcm(new Int16Array([1])), 'ок');
			assert.equal(tokens, 2);
			assert.equal(
				server.requests[0].headers.authorization,
				`Basic ${Buffer.from('id:secret').toString('base64')}`,
			);
		} finally {
			await server.close();
		}
	});

	it('explains missing credentials', async () => {
		const transcriber = new SaluteTranscriber({
			tokenUrl: 'http://127.0.0.1:1/oauth',
			recognizeUrl: 'http://127.0.0.1:1/recognize',
			scope: 'SALUTE_SPEECH_PERS',
			language: 'ru-RU',
		});

		await assert.rejects(() => transcriber.transcribePcm(new Int16Array([1])), /credentials are missing/);
	});
});
