import { existsSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

/** Most capable first: `ggml-large-v3-turbo.bin` wins over `ggml-large-v3.bin`, and so on. */
const MODEL_PREFERENCE = ['turbo', 'large-v3', 'large-v2', 'large', 'medium', 'small', 'base', 'tiny'];

export function expandHome(value: string): string {
	const trimmed = value.trim();
	if (trimmed === '~' || trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
		const home = process.env.USERPROFILE ?? process.env.HOME ?? '';
		return join(home, trimmed.slice(1).replace(/^[\\/]/, ''));
	}
	return trimmed;
}

/**
 * Accepts either a model file (`...\ggml-large-v3-turbo.bin`) or a folder that contains
 * one or more `.bin` models; the best match is picked by {@link modelScore}.
 */
export function resolveModelFile(modelPath: string): string | undefined {
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
		return resolve(value);
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

	const models = entries.filter(name => /\.bin$/i.test(name));
	if (models.length === 0) {
		return undefined;
	}

	const ranked = models
		.map(name => ({ name, score: modelScore(name) }))
		.filter(entry => entry.score >= 0)
		.sort((left, right) => left.score - right.score || left.name.localeCompare(right.name));

	const picked = ranked[0]?.name ?? models.sort()[0];
	return resolve(join(value, picked));
}

/** Lower is better; `-1` means the file name carries no recognizable model size. */
export function modelScore(fileName: string): number {
	const lower = fileName.toLowerCase();
	return MODEL_PREFERENCE.findIndex(token => lower.includes(token));
}

export interface ExecutableLookup {
	/** `customDictation.local.executablePath`; a path or a bare name on PATH. */
	readonly explicit?: string;
	readonly modelFile: string;
	readonly pathEnv?: string;
	readonly platform?: NodeJS.Platform;
}

export function executableNames(platform: NodeJS.Platform): string[] {
	return platform === 'win32'
		? ['whisper-cli.exe', 'main.exe', 'whisper.exe']
		: ['whisper-cli', 'main', 'whisper'];
}

/**
 * Looks for a whisper.cpp CLI next to the model, in `build/bin`, and finally on PATH.
 * When an explicit path/name is configured it is the only thing considered.
 */
export function findWhisperExecutable(lookup: ExecutableLookup): string | undefined {
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
		join(dirname(modelDirectory), 'build', 'bin'),
		// Layout of the official whisper.cpp Windows release zip: bin/Release or Release.
		join(dirname(modelDirectory), 'bin', 'Release'),
		join(dirname(modelDirectory), 'Release'),
	];

	return searchDirectories(candidates, executableNames(platform))
		?? searchDirectories(pathDirectories(pathEnv, platform), executableNames(platform));
}

export interface LocalCommandOptions {
	readonly executable: string;
	readonly modelFile: string;
	/** Short whisper language code, `undefined` for auto-detection. */
	readonly language?: string;
	readonly extraArgs?: string;
}

/** whisper.cpp CLI invocation; `${file}` stays a placeholder for {@link transcribeWithCommand}. */
export function buildLocalWhisperCommand(options: LocalCommandOptions): string {
	const parts = [
		quote(options.executable),
		'-m', quote(options.modelFile),
		'-f', '${file}',
		'-l', options.language || 'auto',
		'-nt',
	];

	const extra = options.extraArgs?.trim();
	if (extra) {
		parts.push(extra);
	}
	return parts.join(' ');
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
