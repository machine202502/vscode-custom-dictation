import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import ts from 'typescript';
import { format } from '../i18n';

const ROOT = join(__dirname, '..', '..');

type Bundle = Record<string, string>;

function readBundle(name: string): Bundle {
	return JSON.parse(readFileSync(join(ROOT, 'l10n', name), 'utf8')) as Bundle;
}

/** Collects every literal passed as the first argument of `t(...)`, concatenations included. */
function collectKeys(): string[] {
	const keys = new Set<string>();

	const literal = (node: ts.Node | undefined): string | undefined => {
		if (!node) {
			return undefined;
		}
		if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
			return node.text;
		}
		if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
			const left = literal(node.left);
			const right = literal(node.right);
			return left === undefined || right === undefined ? undefined : left + right;
		}
		return undefined;
	};

	const visit = (file: string): void => {
		const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.ES2022, true);
		const walk = (node: ts.Node): void => {
			if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 't') {
				const text = literal(node.arguments[0]);
				assert.ok(text !== undefined, `unresolved t() key in ${file}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}`);
				keys.add(text);
			}
			ts.forEachChild(node, walk);
		};
		walk(source);
	};

	const walkDir = (dir: string): void => {
		for (const entry of require('node:fs').readdirSync(dir, { withFileTypes: true }) as Array<{ name: string; isDirectory(): boolean }>) {
			const full = join(dir, entry.name);
			if (entry.isDirectory()) {
				if (entry.name !== 'test') {
					walkDir(full);
				}
			} else if (entry.name.endsWith('.ts')) {
				visit(full);
			}
		}
	};
	walkDir(join(ROOT, 'src'));

	return [...keys];
}

function placeholders(text: string): string {
	return [...text.matchAll(/\{(\d+)\}/g)].map(match => match[1]).sort().join(',');
}

describe('translations', () => {
	it('formats placeholders without VS Code', () => {
		assert.equal(format('a {0} b {1}', ['X', 2]), 'a X b 2');
		assert.equal(format('no placeholders', []), 'no placeholders');
		assert.equal(format('missing {1}', ['only']), 'missing {1}');
	});

	it('ships English and Russian runtime bundles with identical keys', () => {
		const en = readBundle('bundle.l10n.json');
		const ru = readBundle('bundle.l10n.ru.json');

		assert.deepEqual(Object.keys(ru).sort(), Object.keys(en).sort(), 'the Russian bundle covers every key');
		for (const [key, value] of Object.entries(en)) {
			assert.equal(value, key, 'the default bundle maps each key to itself');
		}
		for (const [key, value] of Object.entries(ru)) {
			assert.equal(placeholders(value), placeholders(key), `placeholders differ for: ${key}`);
			assert.notEqual(value, key, `missing Russian translation for: ${key}`);
		}
	});

	it('translates every string the code asks for', () => {
		const keys = collectKeys();
		const en = readBundle('bundle.l10n.json');
		const ru = readBundle('bundle.l10n.ru.json');

		assert.ok(keys.length > 50, `found ${keys.length} translatable strings`);
		const missingEn = keys.filter(key => !(key in en));
		const missingRu = keys.filter(key => !(key in ru));
		assert.deepEqual(missingEn, [], 'every t() key is in l10n/bundle.l10n.json');
		assert.deepEqual(missingRu, [], 'every t() key is translated in l10n/bundle.l10n.ru.json');
	});

	it('ships English and Russian manifest bundles with identical keys', () => {
		const en = readBundle('../package.nls.json');
		const ru = readBundle('../package.nls.ru.json');
		// The product name is not translated on purpose.
		const sameInBoth = new Set(['displayName']);

		assert.deepEqual(Object.keys(ru).sort(), Object.keys(en).sort());
		assert.equal(en.displayName, 'Custom Dictation');
		for (const [key, value] of Object.entries(ru)) {
			if (!sameInBoth.has(key)) {
				assert.notEqual(value, en[key], `missing Russian translation for: ${key}`);
			}
			assert.equal(placeholders(value), placeholders(en[key]), `placeholders differ for: ${key}`);
		}
	});

	it('references every %key% in the manifest from package.nls.json', () => {
		const manifest = readFileSync(join(ROOT, 'package.json'), 'utf8');
		const en = readBundle('../package.nls.json');
		const referenced = [...manifest.matchAll(/"%([^"%]+)%"/g)].map(match => match[1]);

		assert.ok(referenced.length > 50, `found ${referenced.length} localized manifest strings`);
		const unknown = referenced.filter(key => !(key in en));
		assert.deepEqual(unknown, [], 'every %key% exists in package.nls.json');
		assert.equal(manifest.includes('"l10n"'), true, 'the manifest points VS Code at the l10n folder');
	});
});
