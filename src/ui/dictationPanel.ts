import * as vscode from 'vscode';
import { t } from '../i18n';

export type PanelState = 'idle' | 'listening' | 'working' | 'done';

interface LevelsMessage {
	readonly type: 'levels';
	readonly levels: readonly number[];
	readonly elapsedMs: number;
}

interface StateMessage {
	readonly type: 'state';
	readonly state: PanelState;
	readonly elapsedMs: number;
}

/**
 * Pinned dictation panel — the closest an extension can get to the Copilot status popover.
 *
 * The core popover cannot be reproduced: VS Code pins a status bar hover only for its own
 * `ToggleTooltipCommand` object, which is compared by identity, while an extension's command
 * is delivered as a `{ id, title }` DTO (see `statusbarItem.ts`: `command === ToggleTooltipCommand`).
 * A webview panel is the supported surface that "sticks" the same way: it stays open, keeps
 * receiving live data and rendering real `div` bars without any re-render flicker.
 */
export class DictationPanel implements vscode.Disposable {
	private panel: vscode.WebviewPanel | undefined;
	private lastLevels: LevelsMessage | undefined;
	private lastState: StateMessage | undefined;

	constructor(
		private readonly onAction: (action: 'stop' | 'copy' | 'cancel') => void,
	) { }

	dispose(): void {
		this.panel?.dispose();
		this.panel = undefined;
	}

	get isOpen(): boolean {
		return this.panel !== undefined;
	}

	/** Opens the panel, or just focuses it when it is already visible. */
	show(): void {
		if (this.panel) {
			this.panel.reveal(undefined, true);
			return;
		}

		const panel = vscode.window.createWebviewPanel(
			'customDictation.panel',
			'Dictation',
			{ viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
			{ enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [] },
		);

		panel.iconPath = new vscode.ThemeIcon('mic');
		panel.webview.html = renderHtml(nonce());
		panel.onDidDispose(() => {
			if (this.panel === panel) {
				this.panel = undefined;
			}
		});
		panel.webview.onDidReceiveMessage(raw => {
			const command = (raw as { command?: unknown } | undefined)?.command;
			if (command === 'stop' || command === 'copy' || command === 'cancel') {
				this.onAction(command);
			}
		});

		this.panel = panel;
		if (this.lastState) {
			void panel.webview.postMessage(this.lastState);
		}
		if (this.lastLevels) {
			void panel.webview.postMessage(this.lastLevels);
		}
	}

	hide(): void {
		const panel = this.panel;
		this.panel = undefined;
		this.lastLevels = undefined;
		panel?.dispose();
	}

	levels(levels: readonly number[], elapsedMs: number): void {
		this.lastLevels = { type: 'levels', levels: [...levels], elapsedMs };
		void this.panel?.webview.postMessage(this.lastLevels);
	}

	state(state: PanelState, elapsedMs: number): void {
		this.lastState = { type: 'state', state, elapsedMs };
		void this.panel?.webview.postMessage(this.lastState);
	}
}

function nonce(): string {
	const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	let value = '';
	for (let i = 0; i < 32; i++) {
		value += alphabet[Math.floor(Math.random() * alphabet.length)];
	}
	return value;
}

/** Exported for the HTML structure test. */
export function renderHtml(scriptNonce: string): string {
	const stopTitle = t('Stop and insert');
	const copyTitle = t('Stop and copy to the clipboard');
	return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${scriptNonce}';">
<style>
	:root {
		--bar: var(--vscode-descriptionForeground, #9d9d9d);
		--bar-hot: var(--vscode-foreground, #d4d4d4);
	}
	* { box-sizing: border-box; }
	body {
		margin: 0;
		padding: 10px 14px;
		font-family: var(--vscode-font-family, system-ui, sans-serif);
		font-size: var(--vscode-font-size, 13px);
		color: var(--vscode-foreground, #cccccc);
		background: transparent;
		overflow: hidden;
	}
	.row {
		display: flex;
		align-items: center;
		gap: 10px;
		white-space: nowrap;
	}
	.wave {
		flex: 1 1 auto;
		min-width: 40px;
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 2px;
		height: 56px;
		overflow: hidden;
	}
	.bar {
		flex: 0 1 2px;
		width: 2px;
		min-width: 1px;
		min-height: 4px;
		border-radius: 1px;
		background: var(--bar);
		transition: height 70ms linear, background-color 120ms linear, opacity 120ms linear;
	}
	.bar.hot { background: var(--bar-hot); }
	body:not(.listening) .bar { opacity: .45; }
	.timer {
		flex: 0 0 auto;
		font-family: var(--vscode-editor-font-family, ui-monospace, Consolas, monospace);
		font-variant-numeric: tabular-nums;
		font-size: 15px;
		min-width: 4ch;
		text-align: right;
		color: var(--vscode-foreground, #cccccc);
	}
	button {
		flex: 0 0 auto;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 34px;
		height: 34px;
		padding: 0;
		border: 1px solid transparent;
		border-radius: 50%;
		cursor: pointer;
		background: transparent;
		color: var(--vscode-icon-foreground, var(--vscode-foreground, #cccccc));
		transition: background-color 90ms ease, opacity 90ms ease;
	}
	button:focus-visible { outline: 1px solid var(--vscode-focusBorder, #007fd4); outline-offset: 2px; }
	#stop {
		background: var(--vscode-button-secondaryBackground, rgba(128, 128, 128, .25));
		color: var(--vscode-button-secondaryForeground, var(--vscode-foreground, #cccccc));
	}
	#stop:hover:not([disabled]) { background: var(--vscode-button-secondaryHoverBackground, rgba(128, 128, 128, .4)); }
	#copy { border-color: var(--vscode-button-border, rgba(128, 128, 128, .35)); }
	#copy:hover:not([disabled]) { background: var(--vscode-toolbar-hoverBackground, rgba(90, 93, 94, .4)); }
	button[disabled] { opacity: .35; cursor: default; }
</style>
</head>
<body class="idle">
	<div class="row">
		<div class="wave" id="wave"></div>
		<span class="timer" id="timer">0:00</span>
		<button id="stop" title="${stopTitle}">
			<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
				<rect x="1" y="1" width="10" height="10" rx="2" fill="currentColor"></rect>
			</svg>
		</button>
		<button id="copy" title="${copyTitle}">
			<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor"
				stroke-width="1.3" stroke-linejoin="round" aria-hidden="true">
				<rect x="5.75" y="5.75" width="7.5" height="7.5" rx="1.4"></rect>
				<path d="M10.25 5.75V4.15A1.4 1.4 0 0 0 8.85 2.75H4.15A1.4 1.4 0 0 0 2.75 4.15v4.7a1.4 1.4 0 0 0 1.4 1.4h1.6"></path>
			</svg>
		</button>
	</div>

<script nonce="${scriptNonce}">
	const vscode = acquireVsCodeApi();
	const CELLS = 64;
	const MIN_H = 4;
	const MAX_H = 52;

	const wave = document.getElementById('wave');
	const timer = document.getElementById('timer');
	const stopButton = document.getElementById('stop');
	const copyButton = document.getElementById('copy');

	const bars = [];
	for (let i = 0; i < CELLS; i++) {
		const bar = document.createElement('div');
		bar.className = 'bar';
		bar.style.height = MIN_H + 'px';
		wave.appendChild(bar);
		bars.push(bar);
	}

	function formatTimer(ms) {
		const total = Math.min(99 * 60 + 59, Math.max(0, Math.floor(ms / 1000)));
		return Math.floor(total / 60) + ':' + String(total % 60).padStart(2, '0');
	}

	function setBar(bar, level) {
		const value = Math.min(1, Math.max(0, level || 0));
		bar.style.height = Math.round(MIN_H + value * (MAX_H - MIN_H)) + 'px';
		bar.classList.toggle('hot', value > 0.55);
	}

	function clearBars() {
		for (const bar of bars) {
			bar.dataset.level = '0';
			setBar(bar, 0);
		}
	}

	window.addEventListener('message', event => {
		const data = event.data;
		if (!data) {
			return;
		}

		if (data.type === 'levels' && Array.isArray(data.levels)) {
			const incoming = data.levels.slice(-CELLS);
			const shift = incoming.length;
			// Existing bars slide left, new samples land on the right.
			for (let i = 0; i < CELLS - shift; i++) {
				const previous = bars[i + shift];
				const level = previous.dataset.level || '0';
				bars[i].dataset.level = level;
				setBar(bars[i], parseFloat(level));
			}
			for (let i = 0; i < shift; i++) {
				const level = incoming[i];
				const bar = bars[CELLS - shift + i];
				bar.dataset.level = String(level);
				setBar(bar, level);
			}
			timer.textContent = formatTimer(data.elapsedMs || 0);
			return;
		}

		if (data.type === 'state') {
			document.body.className = data.state || 'idle';
			timer.textContent = formatTimer(data.elapsedMs || 0);
			const listening = data.state === 'listening';
			stopButton.disabled = !listening;
			copyButton.disabled = !listening;
			if (!listening) {
				clearBars();
			}
		}
	});

	stopButton.addEventListener('click', () => vscode.postMessage({ command: 'stop' }));
	copyButton.addEventListener('click', () => vscode.postMessage({ command: 'copy' }));
</script>
</body>
</html>`;
}
