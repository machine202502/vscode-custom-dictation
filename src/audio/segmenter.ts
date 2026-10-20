import { concatInt16, PCM_SAMPLE_RATE, rmsOf } from './wav';

export interface SegmenterOptions {
	readonly sampleRate?: number;
	/** Frame size used for voice activity detection. */
	readonly frameMs?: number;
	/** Pause length that closes the current phrase. */
	readonly silenceMs?: number;
	/** Phrases shorter than this are dropped as noise. */
	readonly minSegmentMs?: number;
	/** Hard cut for speech that never pauses. */
	readonly maxSegmentMs?: number;
	/** Audio kept in front of the detected onset so the first consonant is not clipped. */
	readonly leadInMs?: number;
	/** Audio kept after the last voiced frame. */
	readonly trailingMs?: number;
	/** Fixed RMS threshold (0 disables it and enables noise floor tracking). */
	readonly noiseThreshold?: number;
	/** Multiplier applied to the tracked noise floor. */
	readonly noiseMultiplier?: number;
	/** Voiced audio a phrase needs before it counts as speech. */
	readonly minSpeechMs?: number;
}

export interface Segment {
	readonly pcm: Int16Array;
	readonly durationMs: number;
	readonly peakRms: number;
}

type RequiredOptions = Required<SegmenterOptions>;

const DEFAULTS: RequiredOptions = {
	sampleRate: PCM_SAMPLE_RATE,
	frameMs: 20,
	silenceMs: 600,
	minSegmentMs: 400,
	maxSegmentMs: 15000,
	leadInMs: 200,
	trailingMs: 200,
	noiseThreshold: 0,
	noiseMultiplier: 3,
	minSpeechMs: 120,
};

const ONSET_FRAMES = 2; // 40 ms of voiced audio before a phrase starts
const MIN_THRESHOLD = 0.004;
const MIN_NOISE_FLOOR = 0.0002;

/**
 * Splits a continuous PCM stream into phrases at natural pauses so each phrase can be
 * sent to the recognizer while the user keeps talking. Frame based and deterministic,
 * which keeps it testable.
 */
export class Segmenter {
	private readonly opts: RequiredOptions;
	private readonly frameSamples: number;

	private remainder = new Int16Array(0);
	private prebuffer: Int16Array[] = [];
	private frames: Int16Array[] = [];
	private inSpeech = false;
	private voicedRun = 0;
	private silenceRun = 0;
	private voicedFrames = 0;
	private peak = 0;
	private noiseFloor = 0.0015;

	constructor(options: SegmenterOptions = {}) {
		this.opts = { ...DEFAULTS, ...stripUndefined(options) } as RequiredOptions;
		this.frameSamples = Math.max(1, Math.round((this.opts.sampleRate * this.opts.frameMs) / 1000));
	}

	push(chunk: Int16Array): Segment[] {
		if (chunk.length === 0) {
			return [];
		}

		const data = this.remainder.length > 0 ? concatInt16([this.remainder, chunk]) : chunk;
		const frameCount = Math.floor(data.length / this.frameSamples);
		const segments: Segment[] = [];

		for (let i = 0; i < frameCount; i++) {
			const frame = data.subarray(i * this.frameSamples, (i + 1) * this.frameSamples);
			const segment = this.consumeFrame(frame);
			if (segment) {
				segments.push(segment);
			}
		}

		this.remainder = data.slice(frameCount * this.frameSamples);
		return segments;
	}

	/**
	 * Closes an open phrase, e.g. when the user stops dictating.
	 *
	 * Short phrases are kept here on purpose: the user pressed stop, so whatever was said
	 * must reach the model, even if it never got a full second or ended without a pause.
	 */
	flush(): Segment[] {
		if (this.remainder.length > 0) {
			if (this.inSpeech) {
				this.frames.push(this.remainder);
			} else {
				this.pushPrebuffer(this.remainder);
			}
			this.remainder = new Int16Array(0);
		}

		const segments: Segment[] = [];
		if (this.inSpeech) {
			const segment = this.endSegment(false, true);
			if (segment) {
				segments.push(segment);
			}
		}
		this.reset();
		return segments;
	}

	reset(): void {
		this.remainder = new Int16Array(0);
		this.prebuffer = [];
		this.frames = [];
		this.inSpeech = false;
		this.voicedRun = 0;
		this.silenceRun = 0;
		this.voicedFrames = 0;
		this.peak = 0;
	}

	get threshold(): number {
		if (this.opts.noiseThreshold > 0) {
			return this.opts.noiseThreshold;
		}
		return Math.max(MIN_THRESHOLD, this.noiseFloor * this.opts.noiseMultiplier);
	}

	private consumeFrame(frame: Int16Array): Segment | undefined {
		const level = rmsOf(frame);
		const voiced = level >= this.threshold;

		if (!this.inSpeech) {
			this.pushPrebuffer(frame);
			if (voiced) {
				this.voicedRun++;
				if (this.voicedRun >= ONSET_FRAMES) {
					this.beginSpeech();
				}
			} else {
				this.voicedRun = 0;
				this.adaptNoise(level);
			}
			return undefined;
		}

		this.frames.push(frame);
		this.peak = Math.max(this.peak, level);

		if (voiced) {
			this.voicedFrames++;
			this.silenceRun = 0;
		} else {
			this.silenceRun++;
			this.adaptNoise(level);
		}

		if (this.silenceRun * this.opts.frameMs >= this.opts.silenceMs) {
			return this.endSegment(false);
		}
		if (this.frames.length * this.opts.frameMs >= this.opts.maxSegmentMs) {
			return this.endSegment(true);
		}
		return undefined;
	}

	private beginSpeech(): void {
		this.inSpeech = true;
		this.frames = this.prebuffer.slice();
		this.prebuffer = [];
		this.voicedFrames = ONSET_FRAMES;
		this.silenceRun = 0;
		this.peak = 0;
	}

	private endSegment(force: boolean, final = false): Segment | undefined {
		let frames = this.frames;

		if (!force) {
			const trailingFrames = Math.max(0, Math.round(this.opts.trailingMs / this.opts.frameMs));
			const drop = Math.max(0, this.silenceRun - trailingFrames);
			if (drop > 0) {
				frames = frames.slice(0, Math.max(0, frames.length - drop));
			}
		}

		const durationMs = Math.round((frames.length * this.frameSamples * 1000) / this.opts.sampleRate);
		const voicedMs = this.voicedFrames * this.opts.frameMs;
		const peak = this.peak;

		this.inSpeech = false;
		this.frames = [];
		this.voicedFrames = 0;
		this.silenceRun = 0;
		this.voicedRun = 0;
		this.peak = 0;
		this.prebuffer = [];

		if (final ? frames.length === 0 : durationMs < this.opts.minSegmentMs || voicedMs < this.opts.minSpeechMs) {
			if (peak < this.threshold * 2) {
				this.adaptNoise(peak, 0.3);
			}
			return undefined;
		}

		return {
			pcm: concatInt16(frames),
			durationMs,
			peakRms: peak,
		};
	}

	private pushPrebuffer(frame: Int16Array): void {
		this.prebuffer.push(frame);
		const maxFrames = Math.max(1, Math.round(this.opts.leadInMs / this.opts.frameMs));
		if (this.prebuffer.length > maxFrames) {
			this.prebuffer.shift();
		}
	}

	private adaptNoise(level: number, rate = 0.05): void {
		if (level >= this.threshold) {
			return;
		}
		this.noiseFloor = Math.max(MIN_NOISE_FLOOR, this.noiseFloor * (1 - rate) + level * rate);
	}
}

function stripUndefined(options: SegmenterOptions): SegmenterOptions {
	const result: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(options)) {
		if (value !== undefined) {
			result[key] = value;
		}
	}
	return result as SegmenterOptions;
}
