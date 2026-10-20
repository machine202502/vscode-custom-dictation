import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import Module from 'node:module';
import { join } from 'node:path';
import { describe, it, before, beforeEach } from 'node:test';

interface Update {
	readonly section: string;
	readonly key: string;
	readonly value: unknown;
	readonly target: number;
}

const TARGET = { Global: 1, Workspace: 2, WorkspaceFolder: 3 } as const;

const state = {
	levels: { globalValue: undefined as boolean | undefined, workspaceValue: undefined as boolean | undefined, workspaceFolderValue: undefined as boolean | undefined },
	hideBuiltin: true,
	updates: [] as Update[],
	messages: [] as string[],
	applied: false,
};

function installVscodeStub(): void {
	const stub = {
		ConfigurationTarget: TARGET,
		workspace: {
			getConfiguration: (section: string) => ({
				get: (key: string, fallback?: unknown) => {
					if (section === 'customDictation' && key === 'chatMic.hideBuiltin') {
						return state.hideBuiltin;
					}
					const values = [state.levels.globalValue, state.levels.workspaceValue, state.levels.workspaceFolderValue];
					for (let i = values.length - 1; i >= 0; i--) {
						if (values[i] !== undefined) {
							return values[i];
						}
					}
					return fallback;
				},
				inspect: () => ({ ...state.levels }),
				update: async (key: string, value: unknown, target: number) => {
					state.updates.push({ section, key, value, target });
					if (target === TARGET.Global) {
						state.levels.globalValue = value as boolean | undefined;
					} else if (target === TARGET.Workspace) {
						state.levels.workspaceValue = value as boolean | undefined;
					} else {
						state.levels.workspaceFolderValue = value as boolean | undefined;
					}
				},
			}),
		},
		window: {
			showInformationMessage: async (message: string) => {
				state.messages.push(message);
				return undefined;
			},
		},
	};

	const moduleWithLoad = Module as unknown as { _load: (request: string, ...rest: unknown[]) => unknown };
	const original = moduleWithLoad._load;
	moduleWithLoad._load = function (request: string, ...rest: unknown[]) {
		if (request === 'vscode') {
			return stub;
		}
		return original.call(Module, request, ...rest);
	};
}

const logger = {
	info: () => undefined,
	warn: () => undefined,
	error: () => undefined,
	show: () => undefined,
} as unknown as Parameters<typeof import('../chatMic').toggleBuiltinChatMic>[1];

function context(): { readonly globalState: import('../chatMic').GlobalStateLike } {
	return {
		globalState: {
			get: <T>(_key: string, fallback?: T) => (state.applied ? (true as unknown as T) : fallback),
			update: async (_key: string, value: unknown) => {
				if (value === true) {
					state.applied = true;
				}
			},
		},
	} as { readonly globalState: import('../chatMic').GlobalStateLike };
}

describe('built-in chat microphone', () => {
	before(() => {
		installVscodeStub();
	});

	beforeEach(() => {
		state.levels = { globalValue: undefined, workspaceValue: undefined, workspaceFolderValue: undefined };
		state.hideBuiltin = true;
		state.updates.length = 0;
		state.messages.length = 0;
		state.applied = false;
	});

	it('maps the current state to the value to store', () => {
		const { micHideValue, isMicHidden } = require('../chatMic') as typeof import('../chatMic');

		assert.equal(micHideValue(false), false, 'visible -> store false');
		assert.equal(micHideValue(true), undefined, 'hidden -> remove the setting (default is visible)');
		assert.equal(isMicHidden(false), true);
		assert.equal(isMicHidden(undefined), false);
		assert.equal(isMicHidden(true), false);
	});

	it('hides the button on first install', async () => {
		const { applyChatMicDefault } = require('../chatMic') as typeof import('../chatMic');

		await applyChatMicDefault(context(), logger);

		assert.deepEqual(state.updates, [{ section: 'dictation', key: 'showButton', value: false, target: TARGET.Global }]);
		assert.equal(state.levels.globalValue, false);
		assert.equal(state.applied, true, 'the default is remembered as applied');
		assert.equal(state.messages.length, 0, 'install-time hiding is silent');
	});

	it('never hides it twice', async () => {
		state.applied = true;
		const { applyChatMicDefault } = require('../chatMic') as typeof import('../chatMic');

		await applyChatMicDefault(context(), logger);

		assert.deepEqual(state.updates, [], 'nothing is written on later activations');
	});

	it('respects an explicit "visible" choice', async () => {
		state.levels.globalValue = true;
		const { applyChatMicDefault } = require('../chatMic') as typeof import('../chatMic');

		await applyChatMicDefault(context(), logger);

		assert.deepEqual(state.updates, [], 'the user already decided');
		assert.equal(state.applied, true);
	});

	it('does nothing when the install-time switch is off', async () => {
		state.hideBuiltin = false;
		const { applyChatMicDefault } = require('../chatMic') as typeof import('../chatMic');

		await applyChatMicDefault(context(), logger);

		assert.deepEqual(state.updates, []);
		assert.equal(state.applied, true);
	});

	it('toggles the button back and remembers the user decision', async () => {
		state.levels.globalValue = false;
		const { toggleBuiltinChatMic } = require('../chatMic') as typeof import('../chatMic');

		await toggleBuiltinChatMic(context(), logger);

		assert.deepEqual(state.updates, [{ section: 'dictation', key: 'showButton', value: undefined, target: TARGET.Global }]);
		assert.equal(state.levels.globalValue, undefined, 'the default (visible) applies again');
		assert.equal(state.applied, true, 'the install-time default will not hide it again');
		assert.match(state.messages[0], /visible again/);
	});

	it('clears the workspace override that actually hides the button', async () => {
		state.levels.globalValue = false;
		state.levels.workspaceValue = false;
		const { toggleBuiltinChatMic } = require('../chatMic') as typeof import('../chatMic');

		await toggleBuiltinChatMic(context(), logger);

		assert.deepEqual(state.updates, [{ section: 'dictation', key: 'showButton', value: undefined, target: TARGET.Workspace }]);
		assert.equal(state.levels.workspaceValue, undefined);
	});

	it('knows which level hides the button', () => {
		const { hidingLevel, isExplicitlyVisible } = require('../chatMic') as typeof import('../chatMic');

		assert.equal(hidingLevel({ workspaceFolderValue: false, workspaceValue: false, globalValue: false }), 'folder');
		assert.equal(hidingLevel({ workspaceValue: false, globalValue: false }), 'workspace');
		assert.equal(hidingLevel({ globalValue: false }), 'global');
		assert.equal(hidingLevel({ globalValue: true }), undefined);
		assert.equal(hidingLevel(undefined), undefined);

		assert.equal(isExplicitlyVisible({ globalValue: true }), true);
		assert.equal(isExplicitlyVisible({ workspaceValue: true }), true);
		assert.equal(isExplicitlyVisible({ globalValue: false }), false);
		assert.equal(isExplicitlyVisible({}), false);
	});

	it('never touches dictation.enabled, which would disable dictation everywhere', async () => {
		const { applyChatMicDefault, toggleBuiltinChatMic } = require('../chatMic') as typeof import('../chatMic');

		await applyChatMicDefault(context(), logger);
		await toggleBuiltinChatMic(context(), logger);

		assert.equal(state.updates.every(update => update.key === 'showButton'), true);
	});

	it('is declared in the manifest together with its switch', () => {
		const manifest = JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8')) as {
			contributes: {
				commands: Array<{ command: string; title: string }>;
				configuration: { properties: Record<string, { default?: unknown }> };
			};
		};
		const command = manifest.contributes.commands.find(entry => entry.command === 'customDictation.toggleBuiltinMic');

		assert.ok(command, 'the toggle command is contributed');
		// Titles live in package.nls*.json; the manifest references them with %key%.
		assert.match(command.title, /^%command\.toggleBuiltinMic\.title%$/);
		assert.equal(manifest.contributes.configuration.properties['customDictation.chatMic.hideBuiltin']?.default, true);
	});
});
