import * as vscode from 'vscode';
import { readConfig } from '../config';
import { createPcmSource } from '../capture';
import { createTranscriber } from '../stt/createTranscriber';
import { errorMessage, type Logger } from '../log';
import { DEFAULT_CUE_SETTINGS, shouldPlayCue, SoundCues, type CueKind, type CueSettings } from '../audio/cues';
import { t } from '../i18n';
import { DictationPanel } from '../ui/dictationPanel';
import { DictationSession, type DictationEndInfo, type DictationState } from './session';

const STATUS_ID = 'customDictation.status';
/** Normalized RMS above which a frame counts as voice for the auto-stop timer. */
const VOICE_LEVEL = 0.004;
const FLOOR_DB = -60;

/**
 * The microphone lives in the status bar; the live display is a floating toast (progress
 * notification) that appears right above the status bar, over the editor, without stealing
 * focus — the closest an extension can get to the Copilot status popover.
 *
 * The real popover cannot be reproduced: VS Code pins a status bar hover only for its own
 * `ToggleTooltipCommand`, compared by object identity (`command === ToggleTooltipCommand`),
 * while an extension's command arrives as a `{ id, title }` DTO from `extHostStatusBar`.
 * That is also why a live value inside `status.tooltip` used to flicker: every update calls
 * `hover.update(...)` on the already open hover. The toast therefore carries only the timer,
 * and in toast mode the status bar item keeps no tooltip at all while it is recording.
 */
export class DictationController implements vscode.Disposable {
	private readonly status: vscode.StatusBarItem;
	private readonly panel: DictationPanel;
	private session?: DictationSession;
	private busy = false;
	private processing = false;
	private renderToken = 0;
	private lastVoicedAt = 0;
	private autoStopMs = 0;
	private autoStopNotice = false;
	private lastError?: { message: string; at: number };
	private reportProgress: ((message: string) => void) | undefined;
	private closeToast: (() => void) | undefined;
	private readonly cues: SoundCues;
	private cueSettings: CueSettings = DEFAULT_CUE_SETTINGS;
	private ffmpegPath = 'ffmpeg';
	private endCuePending = false;

	constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly logger: Logger,
	) {
		this.cues = new SoundCues(context.extensionUri.fsPath, logger);
		this.status = vscode.window.createStatusBarItem(STATUS_ID, vscode.StatusBarAlignment.Right, 1000);
		this.status.name = 'Custom Dictation';
		this.status.command = 'customDictation.toggle';
		this.panel = new DictationPanel(action => {
			if (action === 'stop') {
				void this.stop();
			} else if (action === 'copy') {
				void this.stopAndCopy();
			} else {
				void this.cancel();
			}
		});
	}

	showIdle(): void {
		if (this.session) {
			return;
		}
		if (!this.statusBarEnabled()) {
			this.status.hide();
			return;
		}
		this.renderToken++;
		this.status.text = '$(mic)';
		this.status.color = undefined;
		this.status.command = 'customDictation.toggle';
		this.status.tooltip = this.idleTooltip();
		this.status.show();
	}

	async toggle(): Promise<void> {
		if (this.session) {
			await this.stop();
			return;
		}
		await this.start();
	}

	/** Shows the floating controls again (also used by the command palette). */
	showControls(): void {
		if (this.session) {
			this.openControls();
			return;
		}
		void vscode.window.showInformationMessage(
			t('Custom Dictation: start dictation — the window will appear by itself.'),
			t('Start'),
		).then(choice => {
			if (choice === t('Start')) {
				void this.start();
			}
		});
	}

	async start(): Promise<void> {
		if (this.session || this.busy || this.processing) {
			return;
		}
		this.busy = true;
		this.autoStopNotice = false;

		try {
			const config = await readConfig(this.context.secrets);
			const transcriber = createTranscriber(config, this.logger);
			const source = createPcmSource(config, this.logger);

			this.logger.info(
				`Starting dictation: provider=${transcriber.label}, language=${config.language ?? 'auto'}, `
				+ `target=${config.insert.target}, capture=${config.command.capture ? 'command' : `ffmpeg/${config.audio.format}`}`,
			);

			const session = new DictationSession(config, transcriber, source, this.logger, {
				update: (state, transcript, elapsedMs, level) => this.render(state, transcript, elapsedMs, level),
				error: error => this.reportError(error),
				end: info => this.end(info),
			});

			this.autoStopMs = Math.max(0, config.audio.autoStopSilenceMs);
			this.cueSettings = config.audio.cues;
			this.ffmpegPath = config.audio.ffmpegPath;
			this.lastVoicedAt = Date.now();
			this.session = session;
			this.endCuePending = true;

			this.markRecording();
			this.openControls();
			await session.start();
			this.playCue('start');
		} catch (error) {
			this.session = undefined;
			this.endCuePending = false;
			this.closeControls();
			this.logger.error('Could not start dictation', error);
			this.showStartFailure(errorMessage(error));
			this.showIdle();
		} finally {
			this.busy = false;
		}
	}

	async stop(): Promise<void> {
		this.playEndCue();
		await this.session?.stop();
	}

	/** Stop and put the transcript on the clipboard instead of inserting it. */
	async stopAndCopy(): Promise<void> {
		this.playEndCue();
		await this.session?.stopAndCopy();
	}

	async cancel(): Promise<void> {
		this.playEndCue();
		await this.session?.cancel();
	}

	dispose(): void {
		void this.session?.cancel();
		this.closeControls();
		this.cues.dispose();
		this.panel.dispose();
		this.status.dispose();
	}

	private playCue(kind: CueKind): void {
		if (!shouldPlayCue(this.cueSettings, kind)) {
			return;
		}
		this.cues.play(kind, this.ffmpegPath, this.cueSettings.volume);
	}

	/** The stop cue fires once per session, also when the recorder dies on its own. */
	private playEndCue(): void {
		if (!this.endCuePending) {
			return;
		}
		this.endCuePending = false;
		this.playCue('end');
	}

	/** One status bar update for the whole recording — no per-frame rewrites. */
	private markRecording(): void {
		if (!this.statusBarEnabled()) {
			return;
		}
		this.status.text = '$(mic-filled)';
		this.status.color = new vscode.ThemeColor('errorForeground');
		this.status.command = 'customDictation.toggle';
		this.status.tooltip = this.showsTooltip() ? this.recordingTooltip() : undefined;
		this.status.show();
	}

	/** Cooldown: the microphone is spin-locked until the model has the whole recording. */
	private markRecognizing(): void {
		if (!this.statusBarEnabled()) {
			return;
		}
		this.status.text = '$(sync~spin)';
		this.status.color = undefined;
		this.status.command = 'customDictation.toggle';
		this.status.tooltip = this.showsTooltip()
			? new vscode.MarkdownString(`$(sync~spin) ${t('Recognizing — the microphone is unavailable')}`)
			: undefined;
		this.status.show();
	}

	private render(state: DictationState, transcript: string, elapsedMs: number, level: number): void {
		if (!this.session) {
			return;
		}
		this.renderToken++;

		if (state === 'listening') {
			if (level > VOICE_LEVEL) {
				this.lastVoicedAt = Date.now();
			}
			this.updateControls(elapsedMs, level);
			this.checkAutoStop(elapsedMs);
			return;
		}

		this.processing = true;
		// Notification messages are plain text: codicons like $(sync~spin) would be shown
		// literally, so the state is written out.
		this.reportProgress?.(t('recognizing…'));
		this.panel.levels([0], elapsedMs);
		this.panel.state('working', elapsedMs);
		this.markRecognizing();
	}

	/** Toast: the timer only — no waveform, nothing that jumps. Panel: live div bars. */
	private updateControls(elapsedMs: number, level: number): void {
		const mode = this.controlsMode();
		if (mode === 'toast') {
			this.reportProgress?.(formatTimer(elapsedMs));
		} else if (mode === 'panel') {
			this.panel.levels([levelToScale(level)], elapsedMs);
		}
	}

	/** Opens the floating display: a toast above the status bar, or the pinned panel. */
	private openControls(): void {
		const mode = this.controlsMode();
		if (mode === 'panel') {
			this.panel.show();
			this.panel.state('listening', 0);
			return;
		}
		if (mode === 'none' || this.closeToast) {
			return;
		}

		let finish!: () => void;
		const done = new Promise<void>(resolve => {
			finish = resolve;
		});
		this.closeToast = () => {
			this.reportProgress = undefined;
			this.closeToast = undefined;
			finish();
		};

		void vscode.window.withProgress({
			location: vscode.ProgressLocation.Notification,
			title: 'Dictation',
			cancellable: true,
		}, async (progress, token) => {
			this.reportProgress = message => progress.report({ message });
			this.reportProgress(formatTimer(0));
			token.onCancellationRequested(() => {
				void this.cancel();
			});
			await done;
		}).then(undefined, error => this.logger.warn(`Dictation toast failed: ${errorMessage(error)}`));
	}

	private closeControls(): void {
		const close = this.closeToast;
		this.closeToast = undefined;
		this.reportProgress = undefined;
		close?.();
		this.panel.hide();
	}

	/** Ends the recording when the user has been silent for a while. */
	private checkAutoStop(elapsedMs: number): void {
		if (this.autoStopMs <= 0 || this.autoStopNotice) {
			return;
		}
		if (Date.now() - this.lastVoicedAt < this.autoStopMs) {
			return;
		}

		this.autoStopNotice = true;
		const seconds = Math.round(this.autoStopMs / 1000);
		this.logger.info(`Auto-stopping dictation after ${seconds}s of silence (${elapsedMs} ms session)`);
		void this.stop().then(() => {
			void vscode.window.showInformationMessage(
				t('Custom Dictation: recording stopped — {0}s without speech.', seconds),
			);
		});
	}

	private end(info: DictationEndInfo): void {
		const transcript = info.transcript;
		this.session = undefined;
		this.processing = false;
		// Covers the recorder dying on its own: the stop cue still fires exactly once.
		this.playEndCue();
		const token = ++this.renderToken;
		this.closeControls();

		if (info.cancelled) {
			this.showIdle();
			return;
		}

		if (info.insertFailure) {
			void this.reportInsertFailure(info);
		}

		if (!this.statusBarEnabled()) {
			this.showIdle();
			return;
		}

		const target = vscode.workspace.getConfiguration('customDictation').get<string>('insert.target', 'chat');
		let icon = '$(check)';
		let message = t('inserted, {0} chars', transcript.length);

		if (!transcript) {
			icon = '$(info)';
			message = t('no speech recognized');
		} else if (info.copied || info.copiedAsFallback || target === 'clipboard') {
			icon = '$(clippy)';
			message = t('copied to the clipboard ({0} chars)', transcript.length);
		} else if (info.insertFailure) {
			icon = '$(warning)';
			message = info.insertFailure;
		}

		this.status.text = icon;
		this.status.color = info.insertFailure ? new vscode.ThemeColor('errorForeground') : undefined;
		this.status.command = 'customDictation.toggle';
		this.status.tooltip = new vscode.MarkdownString(transcript ? `${message}\n\n---\n${transcript}` : message);
		this.status.show();

		setTimeout(() => {
			if (token === this.renderToken) {
				this.showIdle();
			}
		}, 4000);
	}

	private idleTooltip(): vscode.MarkdownString {
		return new vscode.MarkdownString(
			`${t('**Custom Dictation** — click the microphone to dictate')}\n\n`
			+ t('`Ctrl+Alt+D` start / stop · `Ctrl+Alt+Shift+C` stop and copy'),
		);
	}

	/** Static text only: any value that changes would re-render the open hover. */
	private recordingTooltip(): vscode.MarkdownString {
		const target = vscode.workspace.getConfiguration('customDictation').get<string>('insert.target', 'chat');
		const where = target === 'editor'
			? t('into the active editor')
			: target === 'clipboard' ? t('to the clipboard') : t('into the chat input');

		const markdown = new vscode.MarkdownString(`$(circle-filled) ${t('**Recording** — text goes {0}', where)}`);
		markdown.appendMarkdown(
			`\n\n${t('`Ctrl+Alt+D` stop and insert · `Ctrl+Alt+Shift+C` stop and copy · `Ctrl+Alt+Shift+D` cancel')}`,
		);
		markdown.supportThemeIcons = true;
		return markdown;
	}

	/** Tells the user explicitly that the text did not reach the chat input. */
	private async reportInsertFailure(info: DictationEndInfo): Promise<void> {
		const message = info.insertFailure ?? t('Could not insert the recognized text.');
		this.logger.error(`Insert failed: ${message}`);

		if (info.copiedAsFallback) {
			const choice = await vscode.window.showWarningMessage(
				t('Custom Dictation: {0} The text was copied to the clipboard ({1} chars) — paste it manually.', message, info.transcript.length),
				t('Show Log'),
			);
			if (choice === t('Show Log')) {
				this.logger.show();
			}
			return;
		}

		const choice = await vscode.window.showErrorMessage(
			`Custom Dictation: ${message}`,
			t('Copy to clipboard'),
			t('Show Log'),
			t('Diagnostics'),
		);
		if (choice === t('Copy to clipboard') && info.transcript) {
			await vscode.env.clipboard.writeText(info.transcript);
			void vscode.window.showInformationMessage(t('Custom Dictation: the text was copied to the clipboard.'));
		} else if (choice === t('Show Log')) {
			this.logger.show();
		} else if (choice === t('Diagnostics')) {
			void vscode.commands.executeCommand('customDictation.diagnostics');
		}
	}

	private statusBarEnabled(): boolean {
		return vscode.workspace.getConfiguration('customDictation').get<boolean>('statusBar.enabled', true);
	}

	/** In toast mode the floating window already reports everything; no hover hints. */
	private showsTooltip(): boolean {
		return this.controlsMode() !== 'toast';
	}

	private controlsMode(): 'toast' | 'panel' | 'none' {
		const value = vscode.workspace.getConfiguration('customDictation').get<string>('controls', 'toast');
		return value === 'panel' || value === 'none' ? value : 'toast';
	}

	private reportError(error: Error): void {
		const now = Date.now();
		if (this.lastError && this.lastError.message === error.message && now - this.lastError.at < 10_000) {
			return;
		}
		this.lastError = { message: error.message, at: now };
		void vscode.window.showErrorMessage(`Custom Dictation: ${error.message}`, t('Show Log')).then(choice => {
			if (choice === t('Show Log')) {
				this.logger.show();
			}
		});
	}

	private showStartFailure(message: string): void {
		const actions = [t('Show Log'), t('Diagnostics'), t('Open Settings')];
		void vscode.window.showErrorMessage(`Custom Dictation: ${message}`, ...actions).then(choice => {
			if (choice === t('Show Log')) {
				this.logger.show();
			} else if (choice === t('Diagnostics')) {
				void vscode.commands.executeCommand('customDictation.diagnostics');
			} else if (choice === t('Open Settings')) {
				void vscode.commands.executeCommand('workbench.action.openSettings', 'customDictation');
			}
		});
	}
}

/** RMS (0..1) -> decibels -> 0..1 for the waveform cells. */
function levelToScale(rms: number): number {
	if (!(rms > 0)) {
		return 0;
	}
	const db = 20 * Math.log10(Math.min(rms, 1));
	return Math.min(1, Math.max(0, (db - FLOOR_DB) / -FLOOR_DB));
}

function formatTimer(ms: number): string {
	const totalSeconds = Math.min(99 * 60 + 59, Math.max(0, Math.floor(ms / 1000)));
	return `${Math.floor(totalSeconds / 60)}:${String(totalSeconds % 60).padStart(2, '0')}`;
}
