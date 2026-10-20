import { execFile } from 'node:child_process';

export type CaptureFormat = 'dshow' | 'avfoundation' | 'pulse' | 'alsa';

export interface AudioDevice {
	/** Friendly name shown to the user. */
	readonly name: string;
	/** Value handed to ffmpeg (`-i`). For DirectShow this is the ASCII only alternative name. */
	readonly id: string;
	readonly kind: 'audio' | 'video';
}

export function defaultCaptureFormat(platform: NodeJS.Platform = process.platform): CaptureFormat {
	switch (platform) {
		case 'win32':
			return 'dshow';
		case 'darwin':
			return 'avfoundation';
		default:
			return 'pulse';
	}
}

export function resolveCaptureFormat(configured: string, platform: NodeJS.Platform = process.platform): CaptureFormat {
	if (configured === 'dshow' || configured === 'avfoundation' || configured === 'pulse' || configured === 'alsa') {
		return configured;
	}
	return defaultCaptureFormat(platform);
}

/**
 * Parses `ffmpeg -list_devices true -f dshow -i dummy` output.
 *
 * Device names on Windows are often localized ("Набор микрофонов"), and ffmpeg's CRT
 * decodes argv with the ANSI code page, which corrupts them. The alternative name
 * (`@device_cm_{...}\wave_{...}`) is pure ASCII, so it is used whenever available.
 */
export function parseDshowDevices(output: string): AudioDevice[] {
	const devices: AudioDevice[] = [];
	let last: { name: string; kind: 'audio' | 'video'; alternative?: string } | undefined;

	for (const line of output.split(/\r?\n/)) {
		const device = /\]\s+"([^"]+)"\s+\((audio|video)\)\s*$/.exec(line.trimEnd());
		if (device) {
			if (last) {
				devices.push(toDevice(last));
			}
			last = { name: device[1], kind: device[2] as 'audio' | 'video' };
			continue;
		}

		const alternative = /\]\s+Alternative name "([^"]+)"/.exec(line);
		if (alternative && last && !last.alternative) {
			last.alternative = alternative[1];
		}
	}

	if (last) {
		devices.push(toDevice(last));
	}
	return devices;
}

function toDevice(entry: { name: string; kind: 'audio' | 'video'; alternative?: string }): AudioDevice {
	return { name: entry.name, id: entry.alternative ?? entry.name, kind: entry.kind };
}

/** Parses `ffmpeg -f avfoundation -list_devices true -i ""` output. */
export function parseAvfoundationDevices(output: string): AudioDevice[] {
	const devices: AudioDevice[] = [];
	let section: 'audio' | 'video' | undefined;

	for (const line of output.split(/\r?\n/)) {
		if (/AVFoundation video devices:/i.test(line)) {
			section = 'video';
			continue;
		}
		if (/AVFoundation audio devices:/i.test(line)) {
			section = 'audio';
			continue;
		}
		const match = /\[(\d+)\]\s+(.+?)\s*$/.exec(line);
		if (match && section) {
			devices.push({ name: match[2], id: match[1], kind: section });
		}
	}
	return devices;
}

/** Parses `pactl list short sources`. */
export function parsePactlSources(output: string): AudioDevice[] {
	const devices: AudioDevice[] = [];
	for (const line of output.split(/\r?\n/)) {
		const columns = line.split('\t');
		if (columns.length < 2) {
			continue;
		}
		const id = columns[1].trim();
		if (!id || id.endsWith('.monitor')) {
			continue;
		}
		devices.push({ name: id, id, kind: 'audio' });
	}
	return devices;
}

export function execFileText(command: string, args: string[], timeoutMs = 5000): Promise<string> {
	return new Promise<string>(resolve => {
		execFile(
			command,
			args,
			{ timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' },
			(error, stdout, stderr) => {
				// ffmpeg exits with a non-zero code for `-list_devices`; the output is still what we want.
				resolve(`${stdout ?? ''}${stderr ?? ''}${error && !stdout && !stderr ? String(error) : ''}`);
			},
		);
	});
}

export async function listAudioDevices(ffmpegPath: string, format: CaptureFormat): Promise<AudioDevice[]> {
	switch (format) {
		case 'dshow': {
			const output = await execFileText(ffmpegPath, ['-hide_banner', '-list_devices', 'true', '-f', 'dshow', '-i', 'dummy'], 8000);
			return parseDshowDevices(output).filter(device => device.kind === 'audio');
		}
		case 'avfoundation': {
			const output = await execFileText(ffmpegPath, ['-hide_banner', '-f', 'avfoundation', '-list_devices', 'true', '-i', ''], 8000);
			return parseAvfoundationDevices(output).filter(device => device.kind === 'audio');
		}
		case 'pulse': {
			const output = await execFileText('pactl', ['list', 'short', 'sources'], 4000);
			return parsePactlSources(output);
		}
		case 'alsa':
			return [];
	}
}

/** Maps a user supplied device setting (name, index or ffmpeg id) onto a real device. */
export function resolveDevice(devices: readonly AudioDevice[], configured: string): string {
	const wanted = configured.trim();
	if (devices.length === 0) {
		return wanted;
	}
	if (!wanted) {
		return devices[0].id;
	}
	const exact = devices.find(device => device.id === wanted);
	if (exact) {
		return exact.id;
	}
	const lower = wanted.toLowerCase();
	const byName = devices.find(device => device.name.toLowerCase() === lower)
		?? devices.find(device => device.name.toLowerCase().includes(lower))
		?? devices.find(device => device.id.toLowerCase().includes(lower));
	return byName ? byName.id : wanted;
}
