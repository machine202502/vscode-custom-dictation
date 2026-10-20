import * as vscode from 'vscode';
import * as errors from './util/errors';

const PREFIX = '[custom-dictation]';

export class Logger implements vscode.Disposable {
	private readonly channel = vscode.window.createOutputChannel('Custom Dictation');

	info(message: string): void {
		this.channel.appendLine(`${timestamp()} ${message}`);
	}

	warn(message: string): void {
		this.channel.appendLine(`${timestamp()} WARN ${message}`);
	}

	error(message: string, error?: unknown): void {
		const detail = error === undefined ? '' : `: ${errorMessage(error)}`;
		this.channel.appendLine(`${timestamp()} ERROR ${message}${detail}`);
		if (error !== undefined && error instanceof Error && error.stack) {
			this.channel.appendLine(error.stack);
		}
	}

	show(preserveFocus = true): void {
		this.channel.show(preserveFocus);
		this.channel.appendLine(PREFIX);
	}

	dispose(): void {
		this.channel.dispose();
	}
}

export function errorMessage(error: unknown): string {
	return errors.errorMessage(error);
}

export function asError(error: unknown): Error {
	return errors.asError(error);
}

function timestamp(): string {
	return new Date().toISOString().slice(11, 23);
}
