import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, it, afterEach } from 'node:test';
import { WebSocketClient } from '../util/websocket';
import {
	buildSherpaCommand,
	extractSherpaText,
	pickModel,
	resolveOnnxModel,
	websocketServerBinary,
} from '../stt/sherpaOnnx';
import { buildSherpaServerArgs, splitArgs } from '../stt/sherpaServer';

interface MockServer {
	readonly port: number;
	readonly received: string[];
	close(): Promise<void>;
}

/**
 * Just enough of an RFC 6455 server to prove the client masks and parses correctly.
 * Replies to every binary frame with three fragments to exercise reassembly.
 */
async function startMockServer(reply: string): Promise<MockServer> {
	const received: string[] = [];
	let socket: import('node:net').Socket | undefined;

	const server: Server = createServer();
	server.on('upgrade', (request, connection) => {
		const key = request.headers['sec-websocket-key'] ?? '';
		const accept = createHash('sha1')
			.update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
			.digest('base64');
		connection.write(
			'HTTP/1.1 101 Switching Protocols\r\n'
			+ 'Upgrade: websocket\r\n'
			+ 'Connection: Upgrade\r\n'
			+ `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
		);

		socket = connection as unknown as import('node:net').Socket;
		let buffer: Buffer = Buffer.alloc(0);

		connection.on('data', chunk => {
			buffer = Buffer.concat([buffer, chunk]);
			for (; ;) {
				if (buffer.length < 2) {
					return;
				}
				const opcode = buffer[0] & 0x0f;
				let length = buffer[1] & 0x7f;
				let offset = 2;
				if (length === 126) {
					if (buffer.length < 4) {
						return;
					}
					length = buffer.readUInt16BE(2);
					offset = 4;
				} else if (length === 127) {
					if (buffer.length < 10) {
						return;
					}
					length = Number(buffer.readBigUInt64BE(2));
					offset = 10;
				}
				const masked = (buffer[1] & 0x80) !== 0;
				const maskKey = masked ? buffer.subarray(offset, offset + 4) : undefined;
				if (masked) {
					offset += 4;
				}
				if (buffer.length < offset + length) {
					return;
				}
				const payload = Buffer.from(buffer.subarray(offset, offset + length));
				if (maskKey) {
					for (let i = 0; i < payload.length; i++) {
						payload[i] ^= maskKey[i & 3];
					}
				}
				buffer = buffer.subarray(offset + length);

				if (opcode === 0x2) {
					received.push(payload.toString('latin1'));
					const first = Buffer.from(reply.slice(0, 4), 'utf8');
					const second = Buffer.from(reply.slice(4, 8), 'utf8');
					const third = Buffer.from(reply.slice(8), 'utf8');
					connection.write(frame(0x1, first, false));
					connection.write(frame(0x0, second, false));
					connection.write(frame(0x0, third, true));
				}
			}
		});
	});

	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
	const address = server.address() as AddressInfo;

	return {
		port: address.port,
		received,
		close: () => new Promise<void>(resolve => {
			socket?.destroy();
			server.close(() => resolve());
		}),
	};
}

function frame(opcode: number, payload: Buffer, fin: boolean): Buffer {
	const header: number[] = [(fin ? 0x80 : 0) | opcode];
	if (payload.length < 126) {
		header.push(payload.length);
	} else {
		header.push(126, payload.length >> 8, payload.length & 0xff);
	}
	return Buffer.concat([Buffer.from(header), payload]);
}

describe('WebSocket client', () => {
	let mock: MockServer | undefined;

	afterEach(async () => {
		await mock?.close();
		mock = undefined;
	});

	it('completes the handshake, masks outgoing frames and reassembles fragments', async () => {
		mock = await startMockServer('{"text": "готово"}');
		const client = await WebSocketClient.connect('127.0.0.1', mock.port);

		const message = await new Promise<string>(resolve => {
			client.onMessage = (data, isText) => resolve(`${isText ? 'text' : 'binary'}:${data.toString('utf8')}`);
			client.sendBinary(Buffer.from('hello', 'utf8'));
		});

		assert.equal(mock.received[0], 'hello');
		assert.equal(message, 'text:{"text": "готово"}');
		client.close();
	});

	it('sends payloads of every length class', async () => {
		mock = await startMockServer('ok');
		const client = await WebSocketClient.connect('127.0.0.1', mock.port);

		for (const size of [5, 300, 70000]) {
			const payload = Buffer.alloc(size, 'a');
			await new Promise<void>(resolve => {
				client.onMessage = () => resolve();
				client.sendBinary(payload);
			});
			assert.equal(mock.received.at(-1)?.length, size);
		}
		client.close();
	});
});

describe('sherpa-onnx helpers', () => {
	it('extracts the transcript from the server/CLI JSON', () => {
		const line = '{"lang": "", "emotion": "", "text": "Привет. Это тест", "timestamps": [0.0]}';
		assert.equal(extractSherpaText(line), 'Привет. Это тест');
		assert.equal(extractSherpaText(`wav:\n${line}`), 'Привет. Это тест');
		assert.equal(extractSherpaText('просто текст'), 'просто текст');
	});

	it('prefers int8 and CTC heads in a model folder', () => {
		const models = [
			'gigaam_v3_rnnt_encoder.onnx',
			'gigaam_v3_e2e_ctc.onnx',
			'gigaam_v3_e2e_ctc_int8.onnx',
		];
		assert.equal(pickModel(models, 'auto'), 'gigaam_v3_e2e_ctc_int8.onnx');
		assert.equal(pickModel(models, 'fp32'), 'gigaam_v3_e2e_ctc.onnx');
		assert.equal(pickModel(['model.onnx'], 'int8'), 'model.onnx');
		assert.equal(pickModel([], 'auto'), undefined);
	});

	it('builds the CLI command and the server arguments', () => {
		const command = buildSherpaCommand({
			executable: 'C:\\sherpa\\sherpa-onnx-offline.exe',
			modelFile: 'C:\\models\\gigaam.onnx',
			tokensFile: 'C:\\models\\tokens.txt',
			extraArgs: '--decoding-method=modified_beam_search',
		});
		assert.equal(
			command,
			'"C:\\sherpa\\sherpa-onnx-offline.exe" --tokens="C:\\models\\tokens.txt"'
			+ ' --nemo-ctc-model="C:\\models\\gigaam.onnx" --num-threads=2'
			+ ' --decoding-method=modified_beam_search ${file}',
		);

		const args = buildSherpaServerArgs({
			executable: 'x',
			modelFile: 'm.onnx',
			tokensFile: 'tokens.txt',
			extraArgs: '--num-threads=8',
		}, 6006);
		assert.ok(args.includes('--port=6006'));
		assert.ok(args.includes('--nemo-ctc-model=m.onnx'));
		assert.ok(args.includes('--num-threads=8'));
		assert.ok(!args.some(arg => arg.startsWith('--log-file=')), 'no log file when it is not provided');

		const withLog = buildSherpaServerArgs({ executable: 'x', modelFile: 'm', tokensFile: 't' }, 1, '/tmp/sherpa.log');
		assert.ok(withLog.includes('--log-file=/tmp/sherpa.log'), 'log file keeps the server out of the workspace');
	});

	it('derives the websocket server binary name', () => {
		assert.equal(websocketServerBinary('C:\\x\\sherpa-onnx-offline.exe'), 'C:\\x\\sherpa-onnx-offline-websocket-server.exe');
		assert.equal(websocketServerBinary('/usr/bin/sherpa-onnx-offline'), '/usr/bin/sherpa-onnx-offline-websocket-server');
	});

	it('splits extra arguments keeping quoted values together', () => {
		assert.deepEqual(splitArgs('--a=1 --b "two words"'), ['--a=1', '--b', 'two words']);
		assert.deepEqual(splitArgs(''), []);
	});

	it('returns undefined when the model path has no tokens or onnx', () => {
		assert.equal(resolveOnnxModel(''), undefined);
		assert.equal(resolveOnnxModel('C:\\definitely\\missing'), undefined);
	});
});
