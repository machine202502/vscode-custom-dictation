import * as vscode from 'vscode';
import type { Logger } from './log';

/** Core (unschema'd) setting that decides whether an extension may run in the Agents window. */
export const AGENTS_WINDOW_SETTING = 'extensions.supportAgentsWindow';
const CONFIG_SECTION = 'extensions';
/** Same setting, relative to its `extensions` section — this is what `get`/`update` take. */
const SUPPORT_KEY = 'supportAgentsWindow';

export type SupportMap = Record<string, boolean>;

function asMap(value: unknown): SupportMap {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		return {};
	}
	const map: SupportMap = {};
	for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
		if (typeof entry === 'boolean') {
			map[key] = entry;
		}
	}
	return map;
}

/** Adds (or updates) one extension in the `{ "publisher.name": true }` map. */
export function withExtensionSupport(current: unknown, extensionId: string, enabled: boolean): SupportMap {
	const map = asMap(current);
	map[extensionId.toLowerCase()] = enabled;
	return map;
}

/** True when the map does not yet say what we want for this extension. */
export function needsSupportUpdate(current: unknown, extensionId: string, enabled: boolean): boolean {
	return asMap(current)[extensionId.toLowerCase()] !== enabled;
}

/**
 * Lets this extension run in the Agents window ("Sessions" window).
 *
 * The window is a separate workbench with its own extension gate:
 * `canExecuteOnSessionsWindow()` first checks `extensions.supportAgentsWindow`
 * (a `{ "publisher.name": boolean }` map) and only then falls back to the
 * `agentsWindowActivation` proposal + `capabilities.agentsWindow`, which a non-allowlisted
 * extension cannot use. So this map entry is the only way in for a third-party extension.
 *
 * Once enabled, the window renders extension status bar items and views like the main window
 * do, which is where our microphone lives.
 */
export async function ensureAgentsWindowSupport(
	extensionId: string,
	enabled: boolean,
	logger: Logger,
): Promise<void> {
	const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
	const current = config.get<SupportMap>(SUPPORT_KEY);
	if (!needsSupportUpdate(current, extensionId, enabled)) {
		return;
	}

	await config.update(
		SUPPORT_KEY,
		withExtensionSupport(current, extensionId, enabled),
		vscode.ConfigurationTarget.Global,
	);
	logger.info(`Agents window support for ${extensionId}: ${enabled ? 'enabled' : 'disabled'}`);
}
