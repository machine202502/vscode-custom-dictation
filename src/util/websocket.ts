import { randomBytes } from 'node:crypto';
import { Socket } from 'node:net';

const MAX_PAYLOAD = 64 * 1024 * 1024;

/**
 * Minimal RFC 6455 client. Only what is needed to talk to a local
 * `sherpa-onnx-offline-websocket-server`: no TLS, no extensions, no compression.
 */
export class WebSocketClient {
	private readonly socket: Socket;
	private buffer: Buffer = Buffer.alloc(0);
	private fragments: Buffer[] = [];
	private fragmentOpcode = 0;
	private closed = false;

	onMessage: (data: Buffer, isText: boolean) => void = () => undefined;
	onClose: (error?: Error) => void = () => undefined;

	private constructor(socket: Socket) {
		this.socket = socket;
		socket.on('data', chunk => this.consume(chunk));
		socket.on('error', error => this.finish(error));
		socket.on('close', () => this.finish());
	}

	static connect(host: string, port: number, path = '/'): Promise<WebSocketClient> {
		return new Promise<WebSocketClient>((resolve, reject) => {
			const key = randomBytes(16).toString('base64');
			const socket = new Socket();
			let settled = false;

			const fail = (error: Error) => {
				if (!settled) {
					settled = true;
					socket.destroy();
					reject(error);
				}
			};

			socket.setNoDelay(true);
			socket.once('error', fail);
			socket.connect(port, host, () => {
				socket.write(
					`GET ${path} HTTP/1.1\r\n`
					+ `Host: ${host}:${port}\r\n`
					+ 'Upgrade: websocket\r\n'
					+ 'Connection: Upgrade\r\n'
					+ `Sec-WebSocket-Key: ${key}\r\n`
					+ 'Sec-WebSocket-Version: 13\r\n'
					+ '\r\n',
				);
			});

			let header: Buffer = Buffer.alloc(0);
			const onHandshakeData = (chunk: Buffer) => {
				header = Buffer.concat([header, chunk]);
				const end = header.indexOf('\r\n\r\n');
				if (end < 0) {
					if (header.length > 16 * 1024) {
						fail(new Error('WebSocket handshake response is too large'));
					}
					return;
				}

				const head = header.subarray(0, end).toString('latin1');
				if (!/^HTTP\/1\.1\s+101/i.test(head.split('\r\n')[0])) {
					fail(new Error(`WebSocket handshake failed: ${head.split('\r\n')[0]}`));
					return;
				}

				socket.off('data', onHandshakeData);
				socket.off('error', fail);

				const client = new WebSocketClient(socket);
				settled = true;
				const rest = header.subarray(end + 4);
				resolve(client);
				if (rest.length > 0) {
					client.consume(rest);
				}
			};

			socket.on('data', onHandshakeData);
		});
	}

	sendBinary(payload: Buffer): void {
		this.sendFrame(0x2, payload);
	}

	sendText(text: string): void {
		this.sendFrame(0x1, Buffer.from(text, 'utf8'));
	}

	close(): void {
		if (this.closed) {
			return;
		}
		this.closed = true;
		try {
			this.sendFrame(0x8, Buffer.alloc(0));
		} catch {
			// socket already gone
		}
		this.socket.destroy();
		this.finish();
	}

	private sendFrame(opcode: number, payload: Buffer): void {
		if (this.closed) {
			throw new Error('WebSocket is closed');
		}

		const header: number[] = [0x80 | opcode];
		if (payload.length < 126) {
			header.push(0x80 | payload.length);
		} else if (payload.length <= 0xffff) {
			header.push(0x80 | 126, payload.length >> 8, payload.length & 0xff);
		} else {
			header.push(0x80 | 127);
			const length = BigInt(payload.length);
			for (let shift = 56n; shift >= 0n; shift -= 8n) {
				header.push(Number((length >> shift) & 0xffn));
			}
		}

		const mask = randomBytes(4);
		header.push(...mask);

		const masked = Buffer.allocUnsafe(payload.length);
		for (let i = 0; i < payload.length; i++) {
			masked[i] = payload[i] ^ mask[i & 3];
		}

		this.socket.write(Buffer.concat([Buffer.from(header), masked]));
	}

	private consume(chunk: Buffer): void {
		this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);

		for (; ;) {
			if (this.buffer.length < 2) {
				return;
			}

			const first = this.buffer[0];
			const second = this.buffer[1];
			const fin = (first & 0x80) !== 0;
			const opcode = first & 0x0f;
			const masked = (second & 0x80) !== 0;
			let length = second & 0x7f;
			let offset = 2;

			if (length === 126) {
				if (this.buffer.length < offset + 2) {
					return;
				}
				length = this.buffer.readUInt16BE(offset);
				offset += 2;
			} else if (length === 127) {
				if (this.buffer.length < offset + 8) {
					return;
				}
				const big = this.buffer.readBigUInt64BE(offset);
				if (big > BigInt(MAX_PAYLOAD)) {
					this.finish(new Error('WebSocket frame is too large'));
					return;
				}
				length = Number(big);
				offset += 8;
			}

			let maskKey: Buffer | undefined;
			if (masked) {
				if (this.buffer.length < offset + 4) {
					return;
				}
				maskKey = this.buffer.subarray(offset, offset + 4);
				offset += 4;
			}

			if (this.buffer.length < offset + length) {
				return;
			}

			let payload = this.buffer.subarray(offset, offset + length);
			this.buffer = this.buffer.subarray(offset + length);

			if (maskKey) {
				const unmasked = Buffer.allocUnsafe(payload.length);
				for (let i = 0; i < payload.length; i++) {
					unmasked[i] = payload[i] ^ maskKey[i & 3];
				}
				payload = unmasked;
			}

			this.handleFrame(fin, opcode, payload);
			if (this.closed) {
				return;
			}
		}
	}

	private handleFrame(fin: boolean, opcode: number, payload: Buffer): void {
		switch (opcode) {
			case 0x0: { // continuation
				this.fragments.push(Buffer.from(payload));
				if (fin) {
					const data = Buffer.concat(this.fragments);
					const text = this.fragmentOpcode === 0x1;
					this.fragments = [];
					this.fragmentOpcode = 0;
					this.onMessage(data, text);
				}
				return;
			}
			case 0x1:
			case 0x2: {
				if (fin) {
					this.onMessage(Buffer.from(payload), opcode === 0x1);
					return;
				}
				this.fragmentOpcode = opcode;
				this.fragments = [Buffer.from(payload)];
				return;
			}
			case 0x8: {
				this.finish();
				return;
			}
			case 0x9: { // ping -> pong
				this.sendFrame(0xa, payload);
				return;
			}
			default:
				return; // pong / reserved
		}
	}

	private finish(error?: Error): void {
		if (this.closed) {
			return;
		}
		this.closed = true;
		this.socket.destroy();
		this.onClose(error);
	}
}
