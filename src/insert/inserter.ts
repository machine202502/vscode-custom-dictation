import * as vscode from 'vscode';
import type { DictationConfig } from '../configTypes';
import { t } from '../i18n';
import type { Logger } from '../log';

/** How a phrase ended up (or failed to end up) in the target surface. */
export type InsertOutcome = 'inserted' | 'clipboard' | 'skipped' | 'failed';

/**
 * Writes recognized phrases into the requested destination.
 *
 * Chat has no extension API for its input, so text is pasted with
 * `editor.action.clipboardPasteAction` after focusing the chat input (the clipboard is restored
 * afterwards). Editors are written through the text editor API, which does not steal focus.
 *
 * Every outcome is reported so the caller can tell the user when nothing was inserted.
 */
export class Inserter {
	private transcript = '';
	private failure: string | undefined;

	constructor(
		private readonly config: DictationConfig['insert'],
		private readonly logger: Logger,
	) { }

	get text(): string {
		return this.transcript;
	}

	/** Stores text that was recognized but not inserted (e.g. the "stop and copy" path). */
	replaceTranscript(text: string): void {
		this.transcript = text;
	}

	/** First failure message, if insertion did not work. */
	get failureMessage(): string | undefined {
		return this.failure;
	}

	async prepare(): Promise<void> {
		if (this.config.target !== 'chat') {
			return;
		}
		const focused = await focusChatInput(this.logger);
		if (!focused) {
			this.recordFailure(t('Could not open the Copilot Chat input.'));
		}
	}

	async append(phrase: string): Promise<InsertOutcome> {
		const text = phrase.trim();
		if (!text) {
			return 'skipped';
		}
		this.transcript = this.transcript ? `${this.transcript} ${text}` : text;

		switch (this.config.target) {
			case 'clipboard':
				return 'clipboard';
			case 'editor':
				return this.insertIntoEditor(`${text} `);
			case 'chat':
				return this.insertIntoChat(text);
		}
	}

	/** Called once the session ends, e.g. to fill the clipboard. */
	async finish(): Promise<void> {
		if (this.config.target === 'clipboard' && this.transcript) {
			await vscode.env.clipboard.writeText(this.transcript);
		}
	}

	async copyTranscript(text = this.transcript): Promise<boolean> {
		if (!text) {
			return false;
		}
		try {
			await vscode.env.clipboard.writeText(text);
			return true;
		} catch (error) {
			this.recordFailure(t('Could not write the text to the clipboard: {0}', describe(error)));
			return false;
		}
	}

	private async insertIntoChat(text: string): Promise<InsertOutcome> {
		if (this.config.chatMode === 'replace') {
			try {
				await vscode.commands.executeCommand('workbench.action.chat.open', {
					query: `${this.transcript} `,
					isPartialQuery: true,
				});
				return 'inserted';
			} catch (error) {
				this.recordFailure(t('Could not fill the chat input: {0}', describe(error)));
				this.logger.error('Filling the chat input failed', error);
				return 'failed';
			}
		}

		// The text arrives when the user stops, so focus may have moved elsewhere meanwhile.
		const focused = await focusChatInput(this.logger);
		if (!focused) {
			this.recordFailure(t('Could not focus the Copilot Chat input.'));
			return 'failed';
		}

		const pasted = await pasteWithClipboard(`${text} `, this.logger);
		if (!pasted) {
			this.recordFailure(t(
				'The text did not reach the chat input: the paste command did not run. '
				+ 'Check that Copilot Chat is open and its input is available.',
			));
			return 'failed';
		}
		return 'inserted';
	}

	private async insertIntoEditor(text: string): Promise<InsertOutcome> {
		const editor = vscode.window.activeTextEditor;
		if (!editor) {
			this.recordFailure(t('There is no active editor to insert into.'));
			return 'failed';
		}

		const position = editor.selection.active;
		const before = editor.document.getText().length;
		const inserted = await editor.edit(builder => builder.insert(position, text));
		const after = editor.document.getText().length;

		if (!inserted || after === before) {
			this.recordFailure(t('The editor rejected the insertion.'));
			this.logger.warn('The active editor rejected the insertion.');
			return 'failed';
		}

		const lines = text.split(/\r?\n/);
		const end = lines.length > 1
			? new vscode.Position(position.line + lines.length - 1, lines[lines.length - 1].length)
			: position.translate(0, text.length);
		editor.selection = new vscode.Selection(end, end);
		return 'inserted';
	}

	private recordFailure(message: string): void {
		this.failure ??= message;
		this.logger.warn(message);
	}
}

/** Settle time after `chat.open`, so a freshly revealed widget can build its input. */
const FOCUS_SETTLE_MS = 60;

/**
 * Commands that can focus the chat input, in the order they are tried.
 *
 * `workbench.action.chat.focusInput` is the cheapest one, but it only runs
 * `lastFocusedWidget?.focusInput()` — in a window where the chat has never been focused
 * (the Agents window right after opening, or the main window before the chat was used) there
 * is no such widget and the command **silently does nothing**, without throwing.
 *
 * `workbench.action.chat.open` falls back to `revealWidget()` and ends with `focusInput()`
 * (core: `let b = lastFocusedWidget; if (!mode || !b || !visible(b)) b = await revealWidget();
 * … b.focusInput()`), so it creates/reveals the widget first. That is why the cascade always
 * runs it instead of trusting the first command's silence.
 */
export const CHAT_FOCUS_COMMANDS: readonly string[] = [
	'workbench.action.chat.focusInput',
	'workbench.action.chat.open',
	'workbench.action.chat.focusInput',
];

/**
 * Focuses the chat input, trying every command that can do it.
 * Returns false only when none of them is available in the running window.
 */
export async function focusChatInput(logger: Logger): Promise<boolean> {
	let available = 0;

	for (const [index, command] of CHAT_FOCUS_COMMANDS.entries()) {
		if (index === CHAT_FOCUS_COMMANDS.length - 1) {
			await delay(FOCUS_SETTLE_MS);
		}
		try {
			await vscode.commands.executeCommand(command);
			available++;
		} catch (error) {
			logger.warn(`${command} failed: ${describe(error)}`);
		}
	}

	if (available === 0) {
		logger.warn('Could not focus the chat input: none of the focus commands is available');
		return false;
	}
	return true;
}

function delay(ms: number): Promise<void> {
	return new Promise<void>(resolve => setTimeout(resolve, ms));
}

async function pasteWithClipboard(text: string, logger: Logger): Promise<boolean> {
	let previous: string | undefined;
	try {
		previous = await Promise.resolve(vscode.env.clipboard.readText());
	} catch {
		previous = undefined;
	}

	try {
		await vscode.env.clipboard.writeText(text);
	} catch (error) {
		logger.error('Writing to the clipboard failed', error);
		return false;
	}

	let pasted = true;
	try {
		await vscode.commands.executeCommand('editor.action.clipboardPasteAction');
	} catch (error) {
		logger.error('editor.action.clipboardPasteAction failed', error);
		pasted = false;
	}

	if (previous !== undefined) {
		// Give the focused widget a moment to read the clipboard before restoring it.
		setTimeout(() => {
			void (async () => {
				try {
					if (await vscode.env.clipboard.readText() === text) {
						await vscode.env.clipboard.writeText(previous);
					}
				} catch {
					// clipboard unavailable; nothing to restore
				}
			})();
		}, 250);
	}

	return pasted;
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
