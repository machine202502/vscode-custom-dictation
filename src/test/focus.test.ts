import assert from 'node:assert/strict';
import Module from 'node:module';
import { describe, it, before, beforeEach } from 'node:test';

const state = {
	/** Commands that throw, simulating an id the current window does not register. */
	failing: [] as string[],
	/** Every executed command, in order. */
	calls: [] as string[],
	warnings: [] as string[],
};

function installVscodeStub(): void {
	const stub = {
		commands: {
			executeCommand: async (command: string) => {
				state.calls.push(command);
				if (state.failing.includes(command)) {
					throw new Error(`command '${command}' not found`);
				}
				return undefined;
			},
		},
		env: { clipboard: { readText: async () => '', writeText: async () => undefined } },
		window: { get activeTextEditor() { return undefined; } },
		workspace: { getConfiguration: () => ({ get: (_key: string, fallback?: unknown) => fallback }) },
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
	warn: (message: string) => state.warnings.push(message),
	error: () => undefined,
	show: () => undefined,
} as unknown as Parameters<typeof import('../insert/inserter').focusChatInput>[0];

describe('chat focus', () => {
	before(() => {
		installVscodeStub();
	});

	beforeEach(() => {
		state.calls.length = 0;
		state.warnings.length = 0;
		state.failing.length = 0;
	});

	it('always runs chat.open, because focusInput silently does nothing without a widget', async () => {
		const { focusChatInput, CHAT_FOCUS_COMMANDS } = require('../insert/inserter') as typeof import('../insert/inserter');

		const focused = await focusChatInput(logger);

		assert.equal(focused, true);
		assert.deepEqual(state.calls, [...CHAT_FOCUS_COMMANDS]);
		assert.ok(state.calls.includes('workbench.action.chat.open'), 'chat.open reveals and focuses the widget');
		assert.equal(state.calls.filter(call => call === 'workbench.action.chat.focusInput').length, 2, 'focusInput is retried after the settle delay');
	});

	it('keeps going when the first attempt fails', async () => {
		state.failing = ['workbench.action.chat.focusInput'];
		const { focusChatInput, CHAT_FOCUS_COMMANDS } = require('../insert/inserter') as typeof import('../insert/inserter');

		const focused = await focusChatInput(logger);

		assert.equal(focused, true);
		assert.deepEqual(state.calls, [...CHAT_FOCUS_COMMANDS], 'every command is tried, nothing short-circuits');
	});

	it('reports failure only when none of the commands is available', async () => {
		state.failing = ['workbench.action.chat.focusInput', 'workbench.action.chat.open'];
		const { focusChatInput } = require('../insert/inserter') as typeof import('../insert/inserter');

		const focused = await focusChatInput(logger);

		assert.equal(focused, false);
		assert.equal(state.calls.length, 3, 'all attempts were made before giving up');
		assert.match(state.warnings.join(' '), /none of the focus commands is available/);
	});
});
