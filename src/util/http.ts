import type * as http from 'node:http';
import * as nodeHttp from 'node:http';
import * as nodeHttps from 'node:https';

export interface HttpRequestOptions {
	readonly method?: string;
	readonly headers?: Record<string, string>;
	readonly body?: Buffer;
	readonly timeoutMs?: number;
	readonly insecureTLS?: boolean;
	readonly signal?: AbortSignal;
}

export interface HttpResponse {
	readonly status: number;
	readonly headers: http.IncomingHttpHeaders;
	readonly body: Buffer;
	readonly text: string;
}

export function httpRequest(url: string, options: HttpRequestOptions = {}): Promise<HttpResponse> {
	const target = new URL(url);
	const isHttps = target.protocol === 'https:';
	const headers: Record<string, string> = { ...options.headers };
	if (options.body) {
		headers['content-length'] = String(options.body.length);
	}

	return new Promise<HttpResponse>((resolve, reject) => {
		let settled = false;
		let timer: NodeJS.Timeout | undefined;

		const onAbort = () => request.destroy(new Error('Request cancelled'));
		const cleanup = () => {
			if (timer) {
				clearTimeout(timer);
				timer = undefined;
			}
			options.signal?.removeEventListener('abort', onAbort);
		};
		const finish = (error: Error | undefined, response?: HttpResponse) => {
			if (settled) {
				return;
			}
			settled = true;
			cleanup();
			if (error) {
				reject(error);
			} else if (response) {
				resolve(response);
			}
		};

		const request = (isHttps ? nodeHttps : nodeHttp).request(target, {
			method: options.method ?? 'GET',
			headers,
			rejectUnauthorized: !options.insecureTLS,
		}, response => {
			const chunks: Buffer[] = [];
			response.on('data', chunk => chunks.push(chunk as Buffer));
			response.on('end', () => {
				const body = Buffer.concat(chunks);
				finish(undefined, {
					status: response.statusCode ?? 0,
					headers: response.headers,
					body,
					text: body.toString('utf8'),
				});
			});
			response.on('error', error => finish(error));
		});

		if (options.timeoutMs) {
			timer = setTimeout(() => request.destroy(new Error(`Request timed out after ${options.timeoutMs} ms`)), options.timeoutMs);
		}
		options.signal?.addEventListener('abort', onAbort);
		request.on('error', error => finish(error));

		if (options.signal?.aborted) {
			request.destroy(new Error('Request cancelled'));
			return;
		}
		if (options.body) {
			request.write(options.body);
		}
		request.end();
	});
}

export function snippet(text: string, limit = 400): string {
	const single = text.replace(/\s+/g, ' ').trim();
	return single.length > limit ? `${single.slice(0, limit)}…` : single;
}
