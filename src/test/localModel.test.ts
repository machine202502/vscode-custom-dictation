import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import {
	buildLocalWhisperCommand,
	executableNames,
	findWhisperExecutable,
	modelScore,
	resolveModelFile,
} from '../stt/localModel';

const root = mkdtempSync(join(tmpdir(), 'custom-dictation-models-'));

after(() => {
	rmSync(root, { recursive: true, force: true });
});

function touch(relativePath: string): string {
	const full = join(root, relativePath);
	mkdirSync(join(full, '..'), { recursive: true });
	writeFileSync(full, '');
	return full;
}

describe('local whisper.cpp models', () => {
	it('accepts a model file directly', () => {
		const file = touch('single/ggml-small.bin');
		assert.equal(resolveModelFile(file), file);
	});

	it('picks the most capable model from a folder', () => {
		touch('many/ggml-tiny.bin');
		touch('many/ggml-base.bin');
		touch('many/ggml-large-v3.bin');
		touch('many/ggml-large-v3-turbo.bin');
		touch('many/readme.txt');

		assert.equal(resolveModelFile(join(root, 'many')), join(root, 'many', 'ggml-large-v3-turbo.bin'));
	});

	it('falls back to the only model when the name is unusual', () => {
		touch('odd/custom-model.bin');
		assert.equal(resolveModelFile(join(root, 'odd')), join(root, 'odd', 'custom-model.bin'));
	});

	it('returns undefined for missing paths and folders without models', () => {
		mkdirSync(join(root, 'empty'), { recursive: true });
		writeFileSync(join(root, 'empty', 'notes.txt'), '');

		assert.equal(resolveModelFile(join(root, 'does-not-exist')), undefined);
		assert.equal(resolveModelFile(join(root, 'empty')), undefined);
		assert.equal(resolveModelFile('   '), undefined);
	});

	it('ranks model names by capability', () => {
		assert.ok(modelScore('ggml-large-v3-turbo-q5_0.bin') < modelScore('ggml-large-v3.bin'));
		assert.ok(modelScore('ggml-medium.bin') < modelScore('ggml-small.bin'));
		assert.equal(modelScore('something-else.bin'), -1);
	});

	it('finds whisper-cli next to the model', () => {
		const executableName = executableNames(process.platform)[0];
		const model = touch('with-cli/ggml-base.bin');
		const executable = touch(`with-cli/${executableName}`);

		assert.equal(findWhisperExecutable({ modelFile: model, platform: process.platform }), executable);
	});

	it('finds whisper-cli in a sibling bin folder and on PATH', () => {
		const executableName = executableNames(process.platform)[0];
		const model = touch('project/models/ggml-base.bin');
		const executable = touch(`project/bin/${executableName}`);

		assert.equal(
			findWhisperExecutable({ modelFile: model, platform: process.platform, pathEnv: '' }),
			executable,
		);

		const onPath = touch(`path-only/${executableName}`);
		assert.equal(
			findWhisperExecutable({
				modelFile: join(root, 'nothing', 'ggml-base.bin'),
				platform: process.platform,
				pathEnv: join(root, 'path-only'),
			}),
			onPath,
		);
	});

	it('honours an explicit executable and ignores it when it does not exist', () => {
		const model = touch('explicit/ggml-base.bin');
		const executable = touch('somewhere/whisper-cli-custom');

		assert.equal(
			findWhisperExecutable({ explicit: executable, modelFile: model, platform: process.platform }),
			executable,
		);
		assert.equal(
			findWhisperExecutable({ explicit: join(root, 'missing', 'whisper-cli'), modelFile: model, platform: process.platform, pathEnv: '' }),
			undefined,
		);
	});

	it('builds the whisper.cpp command line', () => {
		const command = buildLocalWhisperCommand({
			executable: 'C:\\tools\\whisper-cli.exe',
			modelFile: 'C:\\models\\ggml-large-v3-turbo.bin',
			language: 'ru',
			extraArgs: '--threads 8',
		});

		assert.equal(
			command,
			'"C:\\tools\\whisper-cli.exe" -m "C:\\models\\ggml-large-v3-turbo.bin" -f ${file} -l ru -nt --threads 8',
		);
		assert.match(buildLocalWhisperCommand({ executable: 'w', modelFile: 'm' }), /-l auto -nt$/);
	});
});
