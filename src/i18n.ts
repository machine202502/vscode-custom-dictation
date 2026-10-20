interface L10n {
	t(message: string, ...args: Array<string | number>): string;
}

/**
 * Translations for the runtime strings.
 *
 * The English text is the key: `l10n/bundle.l10n.json` maps it to itself and
 * `l10n/bundle.l10n.ru.json` carries the Russian translation. VS Code picks the bundle from the
 * display language, so any language other than the bundled ones falls back to English.
 *
 * Messages use `{0}`, `{1}` placeholders — that is what the `l10n` API expects.
 */
export function t(message: string, ...args: Array<string | number>): string {
	const l10n = extensionL10n();
	if (l10n?.t) {
		try {
			return l10n.t(message, ...args);
		} catch {
			// fall through to the plain formatter
		}
	}
	return format(message, args);
}

/**
 * `vscode` is required lazily: the audio and recognition modules are pure logic and are unit
 * tested without an extension host, so they must stay importable outside VS Code.
 */
function extensionL10n(): L10n | undefined {
	try {
		const vscode = require('vscode') as { l10n?: L10n };
		return vscode.l10n;
	} catch {
		return undefined;
	}
}

/** Exported for tests: `{0}` replacement without any VS Code involvement. */
export function format(message: string, args: Array<string | number>): string {
	if (args.length === 0) {
		return message;
	}
	return message.replace(/\{(\d+)\}/g, (match, index: string) => {
		const value = args[Number(index)];
		return value === undefined ? match : String(value);
	});
}
