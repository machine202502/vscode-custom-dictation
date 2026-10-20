import { randomUUID } from 'node:crypto';

export interface MultipartFile {
	readonly field: string;
	readonly filename: string;
	readonly contentType: string;
	readonly data: Buffer;
}

export interface MultipartBody {
	readonly body: Buffer;
	readonly contentType: string;
}

/** Minimal RFC 7578 multipart/form-data encoder (no external dependencies). */
export function buildMultipartBody(
	fields: Readonly<Record<string, string | number | boolean | undefined>>,
	files: readonly MultipartFile[] = [],
	boundary = `----customDictation${randomUUID().replace(/-/g, '')}`,
): MultipartBody {
	const parts: Buffer[] = [];

	for (const [name, value] of Object.entries(fields)) {
		if (value === undefined) {
			continue;
		}
		parts.push(Buffer.from(
			`--${boundary}\r\nContent-Disposition: form-data; name="${escapeName(name)}"\r\n\r\n${String(value)}\r\n`,
			'utf8',
		));
	}

	for (const file of files) {
		parts.push(Buffer.from(
			`--${boundary}\r\nContent-Disposition: form-data; name="${escapeName(file.field)}"; filename="${escapeName(file.filename)}"\r\n`
			+ `Content-Type: ${file.contentType}\r\n\r\n`,
			'utf8',
		));
		parts.push(file.data);
		parts.push(Buffer.from('\r\n', 'utf8'));
	}

	parts.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));

	return {
		body: Buffer.concat(parts),
		contentType: `multipart/form-data; boundary=${boundary}`,
	};
}

function escapeName(value: string): string {
	return value.replace(/["\r\n]/g, '_');
}
