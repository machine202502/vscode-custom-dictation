import assert from 'node:assert/strict';
import Module from 'node:module';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, before, beforeEach } from 'node:test';

const state = {
	current: {} as Record<string, unknown> | undefined,
	updates: [] as Array<{ section: string; key: string; value: unknown; target: number }>,
};

function installVscodeStub(): void {
	const stub = {
		ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
		workspace: {
			getConfiguration: (section: string) => ({
				get: () => state.current,
				update: async (key: string, value: unknown, target: number) => {
					state.updates.push({ section, key, value, target });
					state.current = value as Record<string, unknown>;
				},
			}),
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
} as unknown as Parameters<typeof import('../agentsWindow').ensureAgentsWindowSupport>[2];

describe('agents window support', () => {
	before(() => {
		installVscodeStub();
	});

	beforeEach(() => {
		state.current = {};
		state.updates.length = 0;
	});

	it('adds this extension to the support map without dropping other entries', () => {
		const { withExtensionSupport } = require('../agentsWindow') as typeof import('../agentsWindow');

		const map = withExtensionSupport({ 'other.extension': true, 'local.custom-dictation': false }, 'local.custom-dictation', true);

		assert.deepEqual(map, { 'other.extension': true, 'local.custom-dictation': true });
	});

	it('starts from an empty map when the setting is missing or malformed', () => {
		const { withExtensionSupport } = require('../agentsWindow') as typeof import('../agentsWindow');

		assert.deepEqual(withExtensionSupport(undefined, 'local.custom-dictation', true), { 'local.custom-dictation': true });
		assert.deepEqual(withExtensionSupport(['nope'], 'local.custom-dictation', true), { 'local.custom-dictation': true });
		assert.deepEqual(withExtensionSupport('nope', 'local.custom-dictation', true), { 'local.custom-dictation': true });
	});

	it('detects when the map already says what we want', () => {
		const { needsSupportUpdate } = require('../agentsWindow') as typeof import('../agentsWindow');

		assert.equal(needsSupportUpdate({ 'local.custom-dictation': true }, 'local.custom-dictation', true), false);
		assert.equal(needsSupportUpdate({ 'local.custom-dictation': false }, 'local.custom-dictation', true), true);
		assert.equal(needsSupportUpdate({}, 'local.custom-dictation', true), true);
		assert.equal(needsSupportUpdate(undefined, 'local.custom-dictation', true), true);
	});

	it('writes the setting only when it changes', async () => {
		const { ensureAgentsWindowSupport } = require('../agentsWindow') as typeof import('../agentsWindow');

		await ensureAgentsWindowSupport('local.custom-dictation', true, logger);
		assert.deepEqual(state.updates, [
			{ section: 'extensions', key: 'supportAgentsWindow', value: { 'local.custom-dictation': true }, target: 1 },
		]);

		state.updates.length = 0;
		await ensureAgentsWindowSupport('local.custom-dictation', true, logger);
		assert.deepEqual(state.updates, [], 'a second run is a no-op');
	});

	it('is declared as a setting that is on by default', () => {
		const manifest = JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8')) as {
			contributes: { configuration: { properties: Record<string, { default?: unknown }> } };
		};

		assert.equal(
			manifest.contributes.configuration.properties['customDictation.chatMic.runInAgentsWindow']?.default,
			true,
		);
	});
});
