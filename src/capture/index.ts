import type { DictationConfig } from '../configTypes';
import type { Logger } from '../log';
import { CommandSource, FfmpegSource, type PcmSource } from './source';

export function createPcmSource(config: DictationConfig, logger: Logger): PcmSource {
	if (config.command.capture.trim()) {
		return new CommandSource(config.command.capture, logger);
	}
	return new FfmpegSource({
		ffmpegPath: config.audio.ffmpegPath,
		format: config.audio.format,
		device: config.audio.device,
	}, logger);
}

export type { PcmSource } from './source';
