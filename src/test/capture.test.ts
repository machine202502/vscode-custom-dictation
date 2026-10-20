import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseAvfoundationDevices, parseDshowDevices, parsePactlSources, resolveDevice } from '../capture/devices';
import { buildFfmpegArgs } from '../capture/source';

const DSHOW_OUTPUT = [
	'[in#0 @ 000002513c401b40] "Integrated Camera" (video)',
	'[in#0 @ 000002513c401b40]   Alternative name "@device_pnp_\\\\?\\usb#vid_04f2&pid_b7e8&mi_00#7&37c306d&0&0000#{65e8773d-8f56-11d0-a3b9-00a0c9223196}\\global"',
	'[in#0 @ 000002513c401b40] "Набор микрофонов (Realtek(R) Audio)" (audio)',
	'[in#0 @ 000002513c401b40]   Alternative name "@device_cm_{33D9A762-90C8-11D0-BD43-00A0C911CE86}\\wave_{3913F9F7-5012-4C90-AC4C-2CE5F471AE2F}"',
	'Error opening input file dummy.',
].join('\r\n');

describe('capture device parsing', () => {
	it('parses DirectShow devices and prefers the ASCII alternative name', () => {
		const devices = parseDshowDevices(DSHOW_OUTPUT);
		const audio = devices.filter(device => device.kind === 'audio');

		assert.equal(devices.length, 2);
		assert.equal(audio.length, 1);
		assert.equal(audio[0].name, 'Набор микрофонов (Realtek(R) Audio)');
		assert.match(audio[0].id, /^@device_cm_/);
	});

	it('parses AVFoundation devices by section', () => {
		const output = [
			'[AVFoundation indev @ 0x7f8] AVFoundation video devices:',
			'[AVFoundation indev @ 0x7f8] [0] FaceTime HD Camera',
			'[AVFoundation indev @ 0x7f8] AVFoundation audio devices:',
			'[AVFoundation indev @ 0x7f8] [0] MacBook Pro Microphone',
			'[AVFoundation indev @ 0x7f8] [1] BlackHole 2ch',
		].join('\n');

		assert.deepEqual(parseAvfoundationDevices(output), [
			{ name: 'FaceTime HD Camera', id: '0', kind: 'video' },
			{ name: 'MacBook Pro Microphone', id: '0', kind: 'audio' },
			{ name: 'BlackHole 2ch', id: '1', kind: 'audio' },
		]);
	});

	it('parses pactl sources and skips monitors', () => {
		const output = [
			'0\talsa_output.pci-0000_00_1f.3.analog-stereo.monitor\tmodule-alsa-card.c\ts16le 2ch 48000Hz\tSUSPENDED',
			'1\talsa_input.pci-0000_00_1f.3.analog-stereo\tmodule-alsa-card.c\ts16le 2ch 48000Hz\tSUSPENDED',
		].join('\n');

		assert.deepEqual(parsePactlSources(output), [
			{ name: 'alsa_input.pci-0000_00_1f.3.analog-stereo', id: 'alsa_input.pci-0000_00_1f.3.analog-stereo', kind: 'audio' },
		]);
	});

	it('resolves a friendly name or falls back to the raw setting', () => {
		const devices = parseDshowDevices(DSHOW_OUTPUT).filter(device => device.kind === 'audio');

		assert.match(resolveDevice(devices, ''), /^@device_cm_/, 'empty setting uses the first device');
		assert.match(resolveDevice(devices, 'realtek'), /^@device_cm_/, 'partial name matches');
		assert.equal(resolveDevice(devices, 'USB Mic'), 'USB Mic', 'unknown names pass through');
	});
});

describe('ffmpeg arguments', () => {
	it('captures raw s16le 16 kHz mono on stdout', () => {
		assert.deepEqual(buildFfmpegArgs('dshow', '@device_cm_{x}\\wave_{y}'), [
			'-hide_banner', '-nostdin', '-loglevel', 'error',
			'-f', 'dshow', '-audio_buffer_size', '100', '-i', 'audio=@device_cm_{x}\\wave_{y}',
			'-ac', '1', '-ar', '16000', '-f', 's16le', 'pipe:1',
		]);
	});

	it('uses the audio index for avfoundation', () => {
		assert.deepEqual(buildFfmpegArgs('avfoundation', '2').slice(-8), [':2', '-ac', '1', '-ar', '16000', '-f', 's16le', 'pipe:1']);
	});

	it('defaults the pulse device when none is configured', () => {
		assert.ok(buildFfmpegArgs('pulse', '').includes('default'));
	});
});
