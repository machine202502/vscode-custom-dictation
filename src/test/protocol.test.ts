import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildMultipartBody } from '../util/multipart';
import { toBcp47, toShortLanguage, resolveConfiguredLanguage, joinTranscript } from '../stt/language';
import { buildCommandLine, stripTimestamps } from '../stt/commandTranscriber';
import { parseSaluteResponse } from '../stt/salute';
import { parseTranscriptionResponse, transcriptionUrl } from '../stt/openaiCompatible';

describe('multipart encoding', () => {
	it('encodes text fields and file parts', () => {
		const { body, contentType } = buildMultipartBody(
			{ model: 'whisper-1', language: undefined, response_format: 'json' },
			[{ field: 'file', filename: 'audio.wav', contentType: 'audio/wav', data: Buffer.from([1, 2, 3]) }],
			'boundary123',
		);

		assert.equal(contentType, 'multipart/form-data; boundary=boundary123');
		const text = body.toString('latin1');
		assert.ok(text.includes('Content-Disposition: form-data; name="model"\r\n\r\nwhisper-1\r\n'));
		assert.ok(text.includes('filename="audio.wav"'));
		assert.ok(text.includes('Content-Type: audio/wav'));
		assert.ok(!text.includes('name="language"'), 'undefined fields are skipped');
		assert.ok(body.includes(Buffer.from([1, 2, 3])), 'file bytes are embedded verbatim');
		assert.ok(text.trimEnd().endsWith('--boundary123--'));
	});
});

describe('language mapping', () => {
	it('maps between short and BCP-47 codes', () => {
		assert.equal(toShortLanguage('ru-RU'), 'ru');
		assert.equal(toShortLanguage('ru'), 'ru');
		assert.equal(toShortLanguage('auto'), undefined);
		assert.equal(toBcp47('ru'), 'ru-RU');
		assert.equal(toBcp47('en'), 'en-US');
		assert.equal(toBcp47('en-GB'), 'en-GB');
		assert.equal(toBcp47(undefined), 'ru-RU');
	});

	it('follows the VS Code speech language setting for auto', () => {
		assert.equal(resolveConfiguredLanguage('auto', 'de-DE', 'ru-RU'), 'de-DE');
		assert.equal(resolveConfiguredLanguage('auto', 'auto', 'ru-RU'), 'ru-RU');
		assert.equal(resolveConfiguredLanguage('en', 'de-DE', 'ru-RU'), 'en');
	});

	it('joins phrases with a single space', () => {
		assert.equal(joinTranscript('', ' привет '), 'привет');
		assert.equal(joinTranscript('привет', 'мир'), 'привет мир');
		assert.equal(joinTranscript('привет', '   '), 'привет');
	});
});

describe('command transcriber helpers', () => {
	it('substitutes ${file} and ${out}', () => {
		const { commandLine, outFile } = buildCommandLine('whisper -f ${file} -of ${out}', 'C:\\tmp x\\segment.wav');
		assert.equal(commandLine, 'whisper -f "C:\\tmp x\\segment.wav" -of "C:\\tmp x\\segment.txt"');
		assert.equal(outFile, 'C:\\tmp x\\segment.txt');
	});

	it('strips whisper timestamps', () => {
		const raw = '[00:00:00.000 --> 00:00:02.000]   привет мир\n[00:00:02.000 --> 00:00:04.000]   как дела';
		assert.equal(stripTimestamps(raw), 'привет мир\nкак дела');
	});
});

describe('response parsing', () => {
	it('accepts the common transcription shapes', () => {
		assert.equal(parseTranscriptionResponse('{"text":"привет"}'), 'привет');
		assert.equal(parseTranscriptionResponse('[{"text":"a"},{"text":"b"}]'), 'a b');
		assert.equal(parseTranscriptionResponse('"просто строка"'), 'просто строка');
		assert.equal(parseTranscriptionResponse('plain text'), 'plain text');
		assert.equal(parseTranscriptionResponse('{"segments":[]}'), '{"segments":[]}');
	});

	it('joins SaluteSpeech result parts', () => {
		assert.equal(parseSaluteResponse('{"status":200,"result":["привет","мир"]}'), 'привет мир');
		assert.throws(() => parseSaluteResponse('{"status":400,"message":"bad audio"}'), /bad audio/);
	});

	it('builds the transcriptions endpoint', () => {
		assert.equal(transcriptionUrl('http://127.0.0.1:8000/v1/'), 'http://127.0.0.1:8000/v1/audio/transcriptions');
		assert.equal(transcriptionUrl('http://host/v1/audio/transcriptions'), 'http://host/v1/audio/transcriptions');
	});
});
