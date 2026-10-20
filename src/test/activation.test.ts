import assert from 'node:assert/strict';
import Module from 'node:module';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

/** Minimal stand-in for the `vscode` module, enough to run `activate()`. */
function createVscodeStub(registered: Map<string, (...args: unknown[]) => unknown>) {
	const disposables: Array<{ dispose(): void }> = [];
	const noop = () => undefined;

	const stub = {
		version: '1.95.0',
		StatusBarAlignment: { Left: 1, Right: 2 },
		ConfigurationTarget: { Global: 1, Workspace: 2 },
		EventEmitter: class<T> {
			readonly event = (_listener: (value: T) => void) => ({ dispose: noop });
			fire(): void { /* no listeners in the smoke test */ }
			dispose(): void { /* nothing to release */ }
		},
		MarkdownString: class {
			value = '';
			isTrusted = false;
			supportThemeIcons = false;
			constructor(value = '') { this.value = value; }
			appendMarkdown(text: string) {
				this.value += text;
				return this;
			}
		},
		Position: class {
			constructor(readonly line: number, readonly character: number) { }
			translate(): unknown { return this; }
		},
		Selection: class { },
		window: {
			createOutputChannel: () => ({ appendLine: noop, show: noop, dispose: noop }),
			createStatusBarItem: () => {
				const item = { text: '', tooltip: undefined as unknown, command: undefined, name: '', show: noop, hide: noop, dispose: noop };
				disposables.push(item);
				return item;
			},
			showErrorMessage: async () => undefined,
			showInformationMessage: async () => undefined,
			showWarningMessage: async () => undefined,
			quickPick: async () => undefined,
			showQuickPick: async () => undefined,
			showInputBox: async () => undefined,
			showTextDocument: async () => undefined,
			get activeTextEditor() { return undefined; },
			registerWebviewViewProvider: () => ({ dispose: noop }),
		},
		commands: {
			registerCommand: (id: string, callback: (...args: unknown[]) => unknown) => {
				registered.set(id, callback);
				return { dispose: noop };
			},
			executeCommand: async () => undefined,
		},
		workspace: {
			getConfiguration: () => ({
				get: <T>(_key: string, fallback?: T) => fallback,
				inspect: () => ({}),
				update: async () => undefined,
			}),
			openTextDocument: async () => ({ }),
		},
		env: {
			clipboard: { readText: async () => '', writeText: async () => undefined },
		},
		Uri: { joinPath: (base: { path?: string }, ...parts: string[]) => ({ path: [base.path ?? '', ...parts].join('/') }) },
		extensions: { getExtension: () => undefined },
	};

	return { stub, disposables };
}

describe('extension activation', () => {
	it('registers every command declared in package.json', () => {
		const registered = new Map<string, (...args: unknown[]) => unknown>();
		const { stub, disposables } = createVscodeStub(registered);

		const originalLoad = (Module as unknown as { _load: (request: string, ...rest: unknown[]) => unknown })._load;
		(Module as unknown as { _load: (request: string, ...rest: unknown[]) => unknown })._load = function (request: string, ...rest: unknown[]) {
			if (request === 'vscode') {
				return stub;
			}
			return originalLoad.call(Module, request, ...rest);
		};

		try {
			const manifest = JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8')) as {
				contributes: { commands: Array<{ command: string }> };
			};
			const declared = manifest.contributes.commands.map(entry => entry.command);

			const extension = require('../extension') as typeof import('../extension');
			const context = {
				subscriptions: [] as Array<{ dispose(): void }>,
				secrets: { get: async () => undefined, store: async () => undefined, delete: async () => undefined },
				extension: { id: 'local.custom-dictation', packageJSON: { version: '0.1.0' } },
				extensionUri: { fsPath: process.cwd(), scheme: 'file', path: process.cwd() },
				globalState: { get: () => false, update: async () => undefined },
			};

			extension.activate(context as unknown as Parameters<typeof extension.activate>[0]);

			assert.deepEqual([...registered.keys()].sort(), [...declared].sort());
			assert.ok(context.subscriptions.length > 0, 'disposables are registered on the context');

			extension.deactivate();
			for (const disposable of context.subscriptions) {
				disposable.dispose();
			}
			for (const disposable of disposables) {
				disposable.dispose();
			}
		} finally {
			(Module as unknown as { _load: (request: string, ...rest: unknown[]) => unknown })._load = originalLoad;
		}
	});

	it('keeps the auto-stop default at one minute of silence', () => {
		type NumberSetting = { type: string; default: number };
		const manifest = JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8')) as {
			contributes: { configuration: { properties: Record<string, NumberSetting> } };
		};
		const setting = manifest.contributes.configuration.properties['customDictation.audio.autoStopSilenceMs'];

		assert.ok(setting, 'the setting is contributed');
		assert.equal(setting.default, 60_000);
	});
});
