export interface TranscribeRequest {
	readonly pcm: Int16Array;
	/** Context prompt built from the previous phrases. */
	readonly prompt?: string;
	readonly signal?: AbortSignal;
}

export interface Transcriber {
	/** Human readable description used in logs and notifications. */
	readonly label: string;
	transcribe(request: TranscribeRequest): Promise<string>;
	/** Releases long lived resources (e.g. a warm speech server). */
	dispose?(): void;
}
