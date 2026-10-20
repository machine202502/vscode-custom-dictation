import { existsSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { expandHome } from './localModel';

export interface OnnxModel {
	readonly modelFile: string;
	readonly tokensFile: string;
}

export interface OnnxModelLookup {
	/** `customDictation.onnx.precision`: `int8`, `fp32` or `auto` (int8 first). */
	readonly precision?: string;
}

/**
 * Resolves a sherpa-onnx NeMo/CTC ASR model. Accepts a model directory
 * (`model.onnx` + `tokens.txt`) or the `.onnx` file itself.
 */
export function resolveOnnxModel(modelPath: string, lookup: OnnxModelLookup = {}): OnnxModel | undefined {
	const value = expandHome(modelPath);
	if (!value) {
		return undefined;
	}

	let stats;
	try {
		stats = statSync(value);
	} catch {
		return undefined;
	}

	if (stats.isFile()) {
		if (!/\.onnx$/i.test(value)) {
			return undefined;
		}
		const tokens = findTokensFile(dirname(value)) ?? findTokensFile(join(dirname(value), '..'));
		return tokens ? { modelFile: resolve(value), tokensFile: tokens } : undefined;
	}

	if (!stats.isDirectory()) {
		return undefined;
	}

	let entries: string[];
	try {
		entries = readdirSync(value);
	} catch {
		return undefined;
	}

	const tokensFile = entries.find(name => /^tokens.*\.txt$/i.test(name)) ?? entries.find(name => /\.txt$/i.test(name));
	if (!tokensFile) {
		return undefined;
	}

	const models = entries.filter(name => /\.onnx$/i.test(name));
	const modelFile = pickModel(models, lookup.precision ?? 'auto');
	if (!modelFile) {
		return undefined;
	}

	return { modelFile: resolve(join(value, modelFile)), tokensFile: resolve(join(value, tokensFile)) };
}

function findTokensFile(directory: string): string | undefined {
	try {
		const name = readdirSync(directory).find(entry => /^tokens.*\.txt$/i.test(entry));
		return name ? resolve(join(directory, name)) : undefined;
	} catch {
		return undefined;
	}
}

/** `auto` prefers the int8 build (smaller and faster on CPU), then fp32. */
export function pickModel(models: readonly string[], precision: string): string | undefined {
	if (models.length === 0) {
		return undefined;
	}

	const byName = (pattern: RegExp) => models.find(name => pattern.test(name));

	if (precision === 'fp32') {
		const fp32 = models.filter(name => !/int8/i.test(name) && !/_(encoder|decoder|joint)\.onnx$/i.test(name));
		return fp32[0] ?? byName(/^(?!.*int8).*\.onnx$/i) ?? models[0];
	}
	if (precision === 'int8') {
		return byName(/int8/i) ?? models[0];
	}

	// Prefer CTC heads over RNNT: RNNT needs encoder/decoder/joint triplets, which is not
	// what `--nemo-ctc-model` expects.
	const ctc = models.filter(name => /ctc/i.test(name));
	const pool = ctc.length > 0 ? ctc : models;
	return pool.find(name => /int8/i.test(name)) ?? pool.find(name => /^(?!.*_(encoder|decoder|joint)).*\.onnx$/i.test(name)) ?? pool[0];
}

export function sherpaExecutableNames(platform: NodeJS.Platform): string[] {
	return platform === 'win32'
		? ['sherpa-onnx-offline.exe', 'sherpa-onnx.exe']
		: ['sherpa-onnx-offline', 'sherpa-onnx'];
}

/** `sherpa-onnx-offline.exe` -> `sherpa-onnx-offline-websocket-server.exe`. */
export function websocketServerBinary(executable: string): string {
	return executable.replace(/offline(\.exe)?$/i, 'offline-websocket-server$1');
}

export interface SherpaLookup {
	readonly explicit?: string;
	readonly modelFile: string;
	readonly pathEnv?: string;
	readonly platform?: NodeJS.Platform;
}

/** Looks for the sherpa-onnx CLI next to the model, in its parent/bin folders, then on PATH. */
export function findSherpaExecutable(lookup: SherpaLookup): string | undefined {
	const platform = lookup.platform ?? process.platform;
	const pathEnv = lookup.pathEnv ?? process.env.PATH ?? '';
	const explicit = lookup.explicit ? expandHome(lookup.explicit) : '';

	if (explicit) {
		if (existsSync(explicit)) {
			return resolve(explicit);
		}
		const name = basename(explicit);
		const names = platform === 'win32' && !/\.exe$/i.test(name) ? [`${name}.exe`, name] : [name];
		return searchDirectories(pathDirectories(pathEnv, platform), names);
	}

	const modelDirectory = dirname(lookup.modelFile);
	const candidates = [
		modelDirectory,
		join(modelDirectory, 'bin'),
		dirname(modelDirectory),
		join(dirname(modelDirectory), 'bin'),
	];

	return searchDirectories(candidates, sherpaExecutableNames(platform))
		?? searchDirectories(pathDirectories(pathEnv, platform), sherpaExecutableNames(platform));
}

export interface SherpaCommandOptions {
	readonly executable: string;
	readonly modelFile: string;
	readonly tokensFile: string;
	readonly extraArgs?: string;
}

/** `${file}` stays a placeholder for {@link transcribeWithCommand}. */
export function buildSherpaCommand(options: SherpaCommandOptions): string {
	const parts = [
		quote(options.executable),
		`--tokens=${quote(options.tokensFile)}`,
		`--nemo-ctc-model=${quote(options.modelFile)}`,
		'--num-threads=2',
	];

	const extra = options.extraArgs?.trim();
	if (extra) {
		parts.push(extra);
	}

	parts.push('${file}');
	return parts.join(' ');
}

/**
 * sherpa-onnx prints the transcript together with the audio file name and timing,
 * e.g. `ru16.wav -- {"lang": "", "text": "привет", ...}`.
 */
export function extractSherpaText(output: string): string {
	const cleaned = output
		.split(/\r?\n/)
		.map(line => line.trim())
		.filter(line => line && !/^sherpa-onnx/i.test(line) && !/^--$/.test(line))
		.join('\n');

	const json = /"text"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(cleaned);
	if (json) {
		return json[1].replace(/\\"/g, '"').replace(/\\n/g, ' ').trim();
	}

	return cleaned
		.split(/\r?\n/)
		.map(line => line.replace(/^.*?\.wav\s*(?:--\s*)?/, '').trim())
		.filter(Boolean)
		.join(' ')
		.trim();
}

function searchDirectories(directories: readonly string[], names: readonly string[]): string | undefined {
	for (const directory of directories) {
		for (const name of names) {
			const candidate = join(directory, name);
			if (existsSync(candidate)) {
				return candidate;
			}
		}
	}
	return undefined;
}

function pathDirectories(pathEnv: string, platform: NodeJS.Platform): string[] {
	return pathEnv
		.split(platform === 'win32' ? ';' : ':')
		.map(entry => entry.trim())
		.filter(Boolean);
}

function quote(value: string): string {
	return `"${value}"`;
}
