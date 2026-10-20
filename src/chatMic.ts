import * as vscode from 'vscode';
import { t } from './i18n';
import type { Logger } from './log';

/** Core `dictation` section: it owns the microphone in the chat input. */
const SECTION = 'dictation';
const SHOW_BUTTON = 'showButton';

export type SettingLevel = 'global' | 'workspace' | 'folder';

/** Explicit values of one setting, as reported by `WorkspaceConfiguration.inspect`. */
export interface InspectedSetting {
	readonly globalValue?: boolean;
	readonly workspaceValue?: boolean;
	readonly workspaceFolderValue?: boolean;
}

/**
 * `undefined` removes the setting and restores the default (`true`), `false` hides the button.
 * Written as a value-to-store pair so the decision stays testable without an editor.
 */
export function micHideValue(currentlyHidden: boolean): false | undefined {
	return currentlyHidden ? undefined : false;
}

export function isMicHidden(value: boolean | undefined): boolean {
	return value === false;
}

/**
 * The most specific level that explicitly hides the button, so showing it again removes the
 * override that actually applies instead of leaving a workspace value behind.
 */
export function hidingLevel(inspected: InspectedSetting | undefined): SettingLevel | undefined {
	if (!inspected) {
		return undefined;
	}
	if (inspected.workspaceFolderValue === false) {
		return 'folder';
	}
	if (inspected.workspaceValue === false) {
		return 'workspace';
	}
	if (inspected.globalValue === false) {
		return 'global';
	}
	return undefined;
}

function targetFor(level: SettingLevel | undefined): vscode.ConfigurationTarget {
	switch (level) {
		case 'workspace':
			return vscode.ConfigurationTarget.Workspace;
		case 'folder':
			return vscode.ConfigurationTarget.WorkspaceFolder;
		default:
			return vscode.ConfigurationTarget.Global;
	}
}

/** Set once so the install-time default never fights a later user choice. */
const APPLIED_KEY = 'chatMic.defaultApplied';
/** `customDictation.chatMic.hideBuiltin`: hide the built-in mic on first install. */
const HIDE_SETTING = 'chatMic.hideBuiltin';

export interface GlobalStateLike {
	get<T>(key: string, defaultValue?: T): T | undefined;
	update(key: string, value: unknown): Thenable<void> | Promise<void>;
}

export function isExplicitlyVisible(inspected: InspectedSetting | undefined): boolean {
	if (!inspected) {
		return false;
	}
	return inspected.globalValue === true || inspected.workspaceValue === true || inspected.workspaceFolderValue === true;
}

/**
 * Applied once on activation: hides the built-in microphone so it does not compete with ours.
 *
 * Deliberately one-shot (`globalState` marker): if the user later brings the button back with
 * the toggle command, the next window must not hide it again.
 */
export async function applyChatMicDefault(
	context: { readonly globalState: GlobalStateLike },
	logger: Logger,
): Promise<void> {
	if (context.globalState.get<boolean>(APPLIED_KEY, false)) {
		return;
	}

	const base = vscode.workspace.getConfiguration('customDictation');
	if (!base.get<boolean>(HIDE_SETTING, true)) {
		await context.globalState.update(APPLIED_KEY, true);
		return;
	}

	const config = vscode.workspace.getConfiguration(SECTION);
	const inspected = config.inspect<boolean>(SHOW_BUTTON);
	if (isExplicitlyVisible(inspected)) {
		// The user (or a policy) already decided; only remember that we are done.
		await context.globalState.update(APPLIED_KEY, true);
		logger.info('Built-in chat microphone kept visible: dictation.showButton is set to true explicitly');
		return;
	}

	await config.update(SHOW_BUTTON, false, vscode.ConfigurationTarget.Global);
	await context.globalState.update(APPLIED_KEY, true);
	logger.info('Built-in chat microphone hidden on first install (dictation.showButton = false)');
}

/**
 * Shows or hides the built-in microphone in the Copilot chat input.
 *
 * The button belongs to the core chat status bar entry: core renders it only when the chat
 * speech service is configured **and** `dictation.showButton` is not `false`
 * (`dictationAvailable = () => isConfigured && config.getValue('dictation.showButton') !== false`).
 * `dictation.enabled: false` would hide it too, but it also disables built-in dictation
 * everywhere (editor, terminal, voice), so only the button switch is used here.
 */
export async function toggleBuiltinChatMic(
	context: { readonly globalState: GlobalStateLike },
	logger: Logger,
): Promise<void> {
	const config = vscode.workspace.getConfiguration(SECTION);
	const inspected = config.inspect<boolean>(SHOW_BUTTON);
	const hidden = isMicHidden(config.get<boolean>(SHOW_BUTTON, true));

	const next = micHideValue(hidden);
	const level = hidingLevel(inspected);
	await config.update(SHOW_BUTTON, next, targetFor(level));
	// Whatever the user picked is final: the install-time default must not override it.
	await context.globalState.update(APPLIED_KEY, true);

	if (next === false) {
		logger.info('Built-in chat microphone hidden (dictation.showButton = false)');
	} else {
		logger.info(`Built-in chat microphone restored (dictation.showButton cleared on ${level ?? 'global'} level)`);
	}

	void vscode.window.showInformationMessage(
		next === false
			? t('Custom Dictation: the built-in chat microphone is hidden.')
			: t('Custom Dictation: the built-in chat microphone is visible again.'),
	);
}
