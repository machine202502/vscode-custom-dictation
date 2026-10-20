const REGIONS: Record<string, string> = {
	en: 'en-US',
	ru: 'ru-RU',
	de: 'de-DE',
	fr: 'fr-FR',
	es: 'es-ES',
	it: 'it-IT',
	pt: 'pt-PT',
	uk: 'uk-UA',
	kk: 'kk-KZ',
	pl: 'pl-PL',
	nl: 'nl-NL',
	tr: 'tr-TR',
	ja: 'ja-JP',
	ko: 'ko-KR',
	zh: 'zh-CN',
};

/** `ru-RU` -> `ru`; anything unusable -> undefined (let the model auto-detect). */
export function toShortLanguage(language: string | undefined): string | undefined {
	if (!language || language === 'auto') {
		return undefined;
	}
	const match = /^([A-Za-z]{2,3})(?:[-_].*)?$/.exec(language.trim());
	return match ? match[1].toLowerCase() : undefined;
}

/** `ru` -> `ru-RU`, `en-US` -> `en-US`. */
export function toBcp47(language: string | undefined, fallback = 'ru-RU'): string {
	if (!language || language === 'auto') {
		return fallback;
	}
	const match = /^([A-Za-z]{2,3})(?:[-_]([A-Za-z]{2,4}))?$/.exec(language.trim().replace('_', '-'));
	if (!match) {
		return fallback;
	}
	const languageCode = match[1].toLowerCase();
	if (match[2]) {
		return `${languageCode}-${match[2].toUpperCase()}`;
	}
	return REGIONS[languageCode] ?? `${languageCode}-${languageCode.toUpperCase()}`;
}

/**
 * Resolves `customDictation.language`. `auto` follows the built-in
 * `accessibility.voice.speechLanguage` setting and then the OS locale.
 */
export function resolveConfiguredLanguage(
	configured: string | undefined,
	speechLanguageSetting: string | undefined,
	osLocale: string | undefined,
): string | undefined {
	if (configured && configured !== 'auto') {
		return configured;
	}
	if (speechLanguageSetting && speechLanguageSetting !== 'auto') {
		return speechLanguageSetting;
	}
	if (osLocale) {
		return osLocale;
	}
	return undefined;
}

/** Merges phrase text into a readable transcript. */
export function joinTranscript(previous: string, addition: string): string {
	const next = addition.trim();
	if (!next) {
		return previous;
	}
	if (!previous) {
		return next;
	}
	return `${previous} ${next}`;
}
