import assert from 'node:assert/strict';
import Module from 'node:module';
import { describe, it, before } from 'node:test';

function installVscodeStub(): void {
	const stub = {
		window: {},
		ViewColumn: { Beside: -2 },
		ThemeIcon: class { constructor(readonly id: string) { } },
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

describe('dictation panel HTML', () => {
	before(() => {
		installVscodeStub();
	});

	it('renders a single row with the wave, the timer and two icon buttons', () => {
		const { renderHtml } = require('../ui/dictationPanel') as typeof import('../ui/dictationPanel');
		const html = renderHtml('abc123');

		assert.match(html, /class="row"/, 'everything lives in one flex row');
		for (const id of ['wave', 'timer', 'stop', 'copy']) {
			assert.ok(html.includes(`id="${id}"`), `missing #${id}`);
		}
		assert.ok(!html.includes('id="cancel"'), 'cancel is not a button in the compact row');
		assert.ok(!html.includes('class="transcript"'), 'the text block is gone');
		assert.ok(!html.includes('id="title"'), 'no header line');
	});

	it('applies the nonce to both the policy and the script', () => {
		const { renderHtml } = require('../ui/dictationPanel') as typeof import('../ui/dictationPanel');
		const html = renderHtml('nonce-value');

		assert.ok(html.includes("script-src 'nonce-nonce-value'"));
		assert.ok(html.includes('<script nonce="nonce-value">'));
		assert.ok(!html.includes('unsafe-eval'));
	});

	it('keeps the copy button labelled for the user', () => {
		const { renderHtml } = require('../ui/dictationPanel') as typeof import('../ui/dictationPanel');
		const html = renderHtml('abc123');

		assert.match(html, /id="copy" title="[^"]*[Cc]opy/);
		assert.match(html, /id="copy"[\s\S]*?<svg/, 'the copy button shows an icon, not text');
	});
});
