import * as vscode from 'vscode';
import { existsSync } from 'node:fs';
import { basename } from 'node:path';
import { listAudioDevices, execFileText } from './capture/devices';
import { readConfig, SECRET_KEYS, updateSetting } from './config';
import { DictationController } from './dictation/controller';
import { errorMessage, Logger } from './log';
import { t } from './i18n';
import { SpeechProviderBridge } from './speechProvider';
import { applyChatMicDefault, toggleBuiltinChatMic } from './chatMic';
import { ensureAgentsWindowSupport } from './agentsWindow';
import { snippet, httpRequest } from './util/http';
import type { ProviderId } from './configTypes';
import { transcriptionUrl } from './stt/openaiCompatible';
import { findWhisperExecutable, resolveModelFile } from './stt/localModel';
import { findSherpaExecutable, resolveOnnxModel, websocketServerBinary } from './stt/sherpaOnnx';

const SECTION = 'customDictation';

export function activate(context: vscode.ExtensionContext): void {
	const logger = new Logger();
	context.subscriptions.push(logger);

	const controller = new DictationController(context, logger);
	context.subscriptions.push(controller);
	controller.showIdle();

	const speechProvider = new SpeechProviderBridge(context, logger);
	context.subscriptions.push(speechProvider);

	context.subscriptions.push(
		vscode.commands.registerCommand('customDictation.toggle', () => controller.toggle()),
		vscode.commands.registerCommand('customDictation.start', () => controller.start()),
		vscode.commands.registerCommand('customDictation.stop', () => controller.stop()),
		vscode.commands.registerCommand('customDictation.stopAndCopy', () => controller.stopAndCopy()),
		vscode.commands.registerCommand('customDictation.showControls', () => controller.showControls()),
		vscode.commands.registerCommand('customDictation.cancel', () => controller.cancel()),
		vscode.commands.registerCommand('customDictation.selectProvider', () => selectProvider()),
		vscode.commands.registerCommand('customDictation.selectMicrophone', () => selectMicrophone(context, logger)),
		vscode.commands.registerCommand('customDictation.selectLocalModel', () => selectLocalModel(context, logger)),
		vscode.commands.registerCommand('customDictation.selectOnnxModel', () => selectOnnxModel(context, logger)),
		vscode.commands.registerCommand('customDictation.setApiKey', () => setApiKey(context)),
		vscode.commands.registerCommand('customDictation.setSaluteCredentials', () => setSaluteCredentials(context)),
		vscode.commands.registerCommand('customDictation.diagnostics', () => runDiagnostics(context, speechProvider)),
		vscode.commands.registerCommand('customDictation.showLog', () => logger.show()),
		vscode.commands.registerCommand('customDictation.registerSpeechProvider', () => registerSpeechProvider(context, speechProvider)),
		vscode.commands.registerCommand('customDictation.toggleBuiltinMic', () => toggleBuiltinChatMic(context, logger)),
	);

	// Hides the built-in chat microphone once, so the first run does not show two microphones.
	void applyChatMicDefault(context, logger).catch(error => logger.warn(errorMessage(error)));

	// The Agents window is a separate workbench with its own extension gate; this lets the
	// microphone we contribute appear there too.
	const agentsWindow = vscode.workspace.getConfiguration(SECTION).get<boolean>('chatMic.runInAgentsWindow', true);
	void ensureAgentsWindowSupport(context.extension.id, agentsWindow, logger)
		.catch(error => logger.warn(errorMessage(error)));

	if (vscode.workspace.getConfiguration(SECTION).get<boolean>('speechProvider.enabled', false)) {
		try {
			speechProvider.register();
		} catch (error) {
			logger.warn(errorMessage(error));
		}
	}
}

export function deactivate(): void {
	// Nothing to do: every disposable is registered on the extension context.
}

async function selectProvider(): Promise<void> {
	const items: Array<vscode.QuickPickItem & { id: ProviderId }> = [
		{
			id: 'openai-compatible',
			label: t('$(server) OpenAI-compatible server'),
			description: t('local Whisper / GigaAM / speaches / OpenAI'),
			detail: t('POST {0}/audio/transcriptions with a WAV file', '{baseUrl}'),
		},
		{
			id: 'salute',
			label: t('$(cloud) SaluteSpeech (Sber)'),
			description: t('GigaAM in the cloud'),
			detail: t('Sber REST API, shares the GigaChat OAuth flow'),
		},
		{
			id: 'command',
			label: t('$(terminal) Local command'),
			description: t('any CLI that prints the recognized text'),
			detail: t('e.g. whisper-cli with a local ggml model'),
		},
		{
			id: 'local-whisper',
			label: t('$(chip) Local whisper.cpp model'),
			description: t('no server, no HTTP — just a model file'),
			detail: t('point at a ggml-*.bin file or at a folder with models'),
		},
		{
			id: 'local-onnx',
			label: t('$(chip) Local GigaAM / ONNX model'),
			description: t('runs through sherpa-onnx, no server setup'),
			detail: t('point at a folder with model.onnx + tokens.txt'),
		},
	];

	const picked = await vscode.window.showQuickPick(items, {
		placeHolder: t('Speech-to-text backend'),
		matchOnDescription: true,
	});
	if (!picked) {
		return;
	}

	await updateSetting('provider', picked.id);
	if (picked.id === 'openai-compatible') {
		void vscode.commands.executeCommand('workbench.action.openSettings', 'customDictation.openai');
	} else if (picked.id === 'salute') {
		void vscode.commands.executeCommand('customDictation.setSaluteCredentials');
	} else if (picked.id === 'local-whisper') {
		void vscode.commands.executeCommand('customDictation.selectLocalModel');
	} else if (picked.id === 'local-onnx') {
		void vscode.commands.executeCommand('customDictation.selectOnnxModel');
	} else {
		void vscode.commands.executeCommand('workbench.action.openSettings', 'customDictation.command');
	}
}

async function selectLocalModel(context: vscode.ExtensionContext, logger: Logger): Promise<void> {
	const config = await readConfig(context.secrets);
	const value = await vscode.window.showInputBox({
		title: t('Custom Dictation: whisper.cpp model'),
		prompt: t('Path to a ggml-*.bin model, or to a folder that contains models'),
		value: config.local.modelPath,
		ignoreFocusOut: true,
	});
	if (value === undefined) {
		return;
	}

	const model = resolveModelFile(value);
	if (!model) {
		const choice = await vscode.window.showErrorMessage(
			t('No whisper.cpp model (.bin) found at "{0}".', value),
			t('Open Settings'),
		);
		if (choice === 'Open Settings') {
			void vscode.commands.executeCommand('workbench.action.openSettings', 'customDictation.local');
		}
		return;
	}

	await updateSetting('local.modelPath', value.trim());

	const executable = findWhisperExecutable({
		explicit: config.local.executablePath,
		modelFile: model,
	});
	logger.info(`Local model resolved to ${model}; whisper CLI: ${executable ?? 'not found'}`);

	if (!executable) {
		const choice = await vscode.window.showWarningMessage(
			t(
				'Model found: {0}. whisper-cli was not found next to the model or on PATH — '
				+ 'set "customDictation.local.executablePath" to whisper-cli.exe.',
				basename(model),
			),
			t('Open Settings'),
		);
		if (choice === t('Open Settings')) {
			void vscode.commands.executeCommand('workbench.action.openSettings', 'customDictation.local');
		}
		return;
	}

	void vscode.window.showInformationMessage(t('Custom Dictation will use {0} with {1}.', basename(model), basename(executable)));
}

async function selectOnnxModel(context: vscode.ExtensionContext, logger: Logger): Promise<void> {
	const config = await readConfig(context.secrets);
	const value = await vscode.window.showInputBox({
		title: t('Custom Dictation: GigaAM / sherpa-onnx model'),
		prompt: t('Folder with model.onnx + tokens.txt (for example converted GigaAM-v3), or the .onnx file'),
		value: config.onnx.modelPath,
		ignoreFocusOut: true,
	});
	if (value === undefined) {
		return;
	}

	const model = resolveOnnxModel(value, { precision: config.onnx.precision });
	if (!model) {
		const choice = await vscode.window.showErrorMessage(
			t('No sherpa-onnx model found at "{0}". The folder must contain an .onnx model and tokens.txt.', value),
			t('Open Settings'),
		);
		if (choice === 'Open Settings') {
			void vscode.commands.executeCommand('workbench.action.openSettings', 'customDictation.onnx');
		}
		return;
	}

	await updateSetting('onnx.modelPath', value.trim());

	const executable = findSherpaExecutable({
		explicit: config.onnx.executablePath,
		modelFile: model.modelFile,
	});
	logger.info(`ONNX model resolved to ${model.modelFile}; sherpa-onnx CLI: ${executable ?? 'not found'}`);

	if (!executable) {
		const choice = await vscode.window.showWarningMessage(
			t(
				'Model found: {0}. sherpa-onnx-offline was not found next to the model or on PATH — '
				+ 'download a sherpa-onnx release and set "customDictation.onnx.executablePath".',
				basename(model.modelFile),
			),
			t('Open Settings'),
		);
		if (choice === t('Open Settings')) {
			void vscode.commands.executeCommand('workbench.action.openSettings', 'customDictation.onnx');
		}
		return;
	}

	void vscode.window.showInformationMessage(
		t('Custom Dictation will use {0} with {1}.', basename(model.modelFile), basename(executable)),
	);
}

async function selectMicrophone(context: vscode.ExtensionContext, logger: Logger): Promise<void> {
	const config = await readConfig(context.secrets);
	const devices = await listAudioDevices(config.audio.ffmpegPath, config.audio.format)
		.catch(error => {
			logger.error('Listing audio devices failed', error);
			return [];
		});

	if (devices.length === 0) {
		const choice = await vscode.window.showWarningMessage(
			t('No audio input devices were found. Check that ffmpeg is installed and that microphone access is allowed for desktop apps.'),
			t('Diagnostics'), t('Open Settings'),
		);
		if (choice === t('Diagnostics')) {
			void vscode.commands.executeCommand('customDictation.diagnostics');
		} else if (choice === t('Open Settings')) {
			void vscode.commands.executeCommand('workbench.action.openSettings', 'customDictation.audio');
		}
		return;
	}

	const items: Array<vscode.QuickPickItem & { device: string }> = [
		{ label: t('$(sync) Automatic'), description: t('first available device'), device: '' },
		...devices.map(device => ({
			label: device.name,
			description: device.id === device.name ? undefined : device.id,
			device: device.id,
		})),
	];

	const picked = await vscode.window.showQuickPick(items, { placeHolder: 'Microphone used for dictation' });
	if (picked) {
		await updateSetting('audio.device', picked.device);
		logger.info(`Microphone set to "${picked.device || 'automatic'}".`);
	}
}

async function setApiKey(context: vscode.ExtensionContext): Promise<void> {
	const value = await vscode.window.showInputBox({
		title: t('Custom Dictation: API key'),
		prompt: 'Bearer token for the OpenAI-compatible endpoint. Leave empty to remove the stored key.',
		password: true,
		ignoreFocusOut: true,
	});
	if (value === undefined) {
		return;
	}
	if (value.trim()) {
		await context.secrets.store(SECRET_KEYS.openAiApiKey, value.trim());
	} else {
		await context.secrets.delete(SECRET_KEYS.openAiApiKey);
	}
	void vscode.window.showInformationMessage(t('Custom Dictation: API key updated.'));
}

async function setSaluteCredentials(context: vscode.ExtensionContext): Promise<void> {
	const mode = await vscode.window.showQuickPick([
		{ label: 'Authorization key', description: 'Base64 client id + secret from the Sber studio', id: 'key' },
		{ label: 'Client ID and Client Secret', description: 'two separate values', id: 'pair' },
		{ label: 'Remove stored credentials', id: 'clear' },
	], { placeHolder: 'How do you authenticate with SaluteSpeech?' });

	if (!mode) {
		return;
	}

	if (mode.id === 'clear') {
		await context.secrets.delete(SECRET_KEYS.saluteAuthorizationKey);
		await context.secrets.delete(SECRET_KEYS.saluteClientSecret);
		void vscode.window.showInformationMessage(t('Custom Dictation: SaluteSpeech credentials removed.'));
		return;
	}

	if (mode.id === 'key') {
		const key = await vscode.window.showInputBox({
			title: 'SaluteSpeech authorization key',
			prompt: 'Base64 value of "client_id:client_secret"',
			password: true,
			ignoreFocusOut: true,
		});
		if (key === undefined) {
			return;
		}
		await context.secrets.store(SECRET_KEYS.saluteAuthorizationKey, key.trim());
		await context.secrets.delete(SECRET_KEYS.saluteClientSecret);
	} else {
		const clientId = await vscode.window.showInputBox({
			title: 'SaluteSpeech client id',
			ignoreFocusOut: true,
		});
		if (clientId === undefined) {
			return;
		}
		const clientSecret = await vscode.window.showInputBox({
			title: 'SaluteSpeech client secret',
			password: true,
			ignoreFocusOut: true,
		});
		if (clientSecret === undefined) {
			return;
		}
		await updateSetting('salute.clientId', clientId.trim());
		await context.secrets.store(SECRET_KEYS.saluteClientSecret, clientSecret.trim());
		await context.secrets.delete(SECRET_KEYS.saluteAuthorizationKey);
	}

	void vscode.window.showInformationMessage(t('Custom Dictation: SaluteSpeech credentials saved.'));
}

async function registerSpeechProvider(context: vscode.ExtensionContext, bridge: SpeechProviderBridge): Promise<void> {
	if (bridge.isRegistered) {
		void vscode.window.showInformationMessage(t('Custom Dictation is already registered as a VS Code speech provider.'));
		return;
	}

	try {
		bridge.register();
	} catch (error) {
		const message = errorMessage(error);
		const choice = await vscode.window.showErrorMessage(`Custom Dictation: ${message}`, t('Copy command'));
		if (choice === t('Copy command')) {
			await vscode.env.clipboard.writeText(`code --enable-proposed-api ${context.extension.id}`);
		}
		return;
	}

	await updateSetting('speechProvider.enabled', true);
	const choice = await vscode.window.showInformationMessage(
		t('Custom Dictation is now VS Code\'s speech provider. Editor and terminal dictation use it. Reload the window so it is registered before the built-in provider.'),
		t('Reload Window'),
	);
	if (choice === t('Reload Window')) {
		void vscode.commands.executeCommand('workbench.action.reloadWindow');
	}
}

async function runDiagnostics(context: vscode.ExtensionContext, bridge: SpeechProviderBridge): Promise<void> {
	const config = await readConfig(context.secrets);
	const builtinDictation = vscode.workspace.getConfiguration('dictation');
	const builtinEnabled = builtinDictation.get<boolean>('enabled', true);
	const lines: string[] = [
		'# Custom Dictation diagnostics',
		'',
		`- VS Code: \`${vscode.version}\``,
		`- Platform: \`${process.platform}\` (\`${process.arch}\`)`,
		`- Extension: \`${context.extension.id}@${String(context.extension.packageJSON.version ?? '?')}\``,
		`- Provider: \`${config.provider}\``,
		`- Language: \`${config.language ?? 'auto'}\``,
		`- Target: \`${config.insert.target}\` (chat mode: ${config.insert.chatMode})`,
		`- Speech provider registered: ${bridge.isRegistered ? 'yes' : 'no'}`,
		`- Proposed \`speech\` API visible: ${(vscode as unknown as { speech?: unknown }).speech ? 'yes' : 'no'}`,
		`- Built-in dictation \`dictation.enabled\`: \`${builtinEnabled}\` (model: \`${builtinDictation.get<string>('model', '') || 'n/a'}\`)`,
		`- Built-in chat microphone button \`dictation.showButton\`: \`${builtinDictation.get<boolean>('showButton', true)}\``,
		`- Runs in the Agents window (\`extensions.supportAgentsWindow\`): \`${String(
			(vscode.workspace.getConfiguration('extensions').get<Record<string, boolean>>('supportAgentsWindow') ?? {})[
				context.extension.id.toLowerCase()
			] ?? false,
		)}\``,
		'',
		'> The chat input microphone is a core service and is **not** replaced by this extension.',
		'> Editor dictation and voice chat use the registered speech provider (needs `--enable-proposed-api`).',
		dictationScopeNote(builtinEnabled),
		'',
		'## Audio capture',
	];

	const version = await execFileText(config.audio.ffmpegPath, ['-version'], 5000);
	const versionLine = version.split(/\r?\n/).find(line => /ffmpeg version/i.test(line));
	lines.push(`- ffmpeg: ${versionLine ? `\`${versionLine.trim()}\`` : `not available (${snippet(version) || 'no output'})`}`);
	lines.push(`- Capture format: \`${config.audio.format}\``);
	lines.push(`- Recorder override: ${config.command.capture ? `\`${config.command.capture}\`` : 'none (ffmpeg)'}`);

	const devices = await listAudioDevices(config.audio.ffmpegPath, config.audio.format).catch(() => []);
	lines.push(`- Microphones found: ${devices.length}`);
	for (const device of devices.slice(0, 20)) {
		lines.push(`  - ${device.name} → \`${device.id}\``);
	}
	lines.push(`- Selected microphone: \`${config.audio.device || 'automatic'}\``);
	lines.push(`- Voice activity: silence ${config.audio.silenceMs} ms, threshold ${config.audio.noiseThreshold || 'adaptive'}`);

	lines.push('', '## Transcription');
	if (config.provider === 'openai-compatible') {
		lines.push(`- Endpoint: \`${transcriptionUrl(config.openai.baseUrl)}\``);
		lines.push(`- Model: \`${config.openai.model}\``);
		lines.push(`- API key: ${config.openai.apiKey ? 'set' : 'not set'}`);
		lines.push(`- Extra fields: \`${JSON.stringify(config.openai.extraFields)}\``);
		try {
			const probe = await httpRequest(`${config.openai.baseUrl.replace(/\/+$/, '')}/models`, {
				timeoutMs: 5000,
			});
			lines.push(`- Reachability: HTTP ${probe.status}${probe.status === 200 ? '' : ` (${snippet(probe.text, 120)})`}`);
		} catch (error) {
			lines.push(`- Reachability: failed (${errorMessage(error)})`);
		}
	} else if (config.provider === 'salute') {
		lines.push(`- Token endpoint: \`${config.salute.tokenUrl}\``);
		lines.push(`- Recognizer: \`${config.salute.recognizeUrl}\``);
		lines.push(`- Scope: \`${config.salute.scope}\`, TLS verification: ${config.salute.insecureTLS ? 'off' : 'on'}`);
		const hasCredentials = Boolean(config.salute.authorizationKey || (config.salute.clientId && config.salute.clientSecret));
		lines.push(`- Credentials: ${hasCredentials ? 'set' : 'missing (run "Custom Dictation: Set SaluteSpeech Credentials")'}`);
	} else if (config.provider === 'local-onnx') {
		const model = resolveOnnxModel(config.onnx.modelPath, { precision: config.onnx.precision });
		lines.push(`- Model path setting: \`${config.onnx.modelPath || 'not set'}\``);
		lines.push(`- Resolved model: ${model ? `\`${model.modelFile}\`` : 'not found'}`);
		lines.push(`- Tokens: ${model ? `\`${model.tokensFile}\`` : 'not found'}`);
		const executable = model
			? findSherpaExecutable({ explicit: config.onnx.executablePath, modelFile: model.modelFile })
			: undefined;
		lines.push(`- sherpa-onnx CLI: ${executable ? `\`${executable}\`` : 'not found (set customDictation.onnx.executablePath)'}`);
		if (executable) {
			const serverBinary = websocketServerBinary(executable);
			lines.push(`- Warm server binary: ${existsSync(serverBinary) ? `\`${serverBinary}\`` : 'not found (will start a process per phrase)'}`);
		}
		lines.push(`- Mode: \`${config.onnx.mode}\`, precision: \`${config.onnx.precision}\`, extra args: \`${config.onnx.extraArgs}\``);
	} else if (config.provider === 'local-whisper') {
		const model = resolveModelFile(config.local.modelPath);
		lines.push(`- Model path setting: \`${config.local.modelPath || 'not set'}\``);
		lines.push(`- Resolved model: ${model ? `\`${model}\`` : 'not found'}`);
		const executable = model
			? findWhisperExecutable({ explicit: config.local.executablePath, modelFile: model })
			: undefined;
		lines.push(`- whisper.cpp CLI: ${executable ? `\`${executable}\`` : 'not found (set customDictation.local.executablePath)'}`);
		lines.push(`- Extra args: \`${config.local.extraArgs}\``);
	} else {
		lines.push(`- Command: ${config.command.transcribe ? `\`${config.command.transcribe}\`` : 'not configured'}`);
	}

	const document = await vscode.workspace.openTextDocument({ content: lines.join('\n'), language: 'markdown' });
	await vscode.window.showTextDocument(document, { preview: false });
}

function dictationScopeNote(builtinEnabled: boolean): string {
	return builtinEnabled
		? '> Terminal voice input prefers the built-in dictation while `dictation.enabled` is true. Set it to `false` to route the terminal through this extension.'
		: '> Terminal voice input uses this extension\'s speech provider (built-in dictation is disabled).';
}
