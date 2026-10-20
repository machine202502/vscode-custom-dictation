# Custom Dictation

Диктовка в Copilot Chat, редактор и терминал VS Code с **вашей** моделью распознавания речи:
локальный Whisper / GigaAM, SaluteSpeech (Sber) или любой OpenAI-совместимый сервер.

Расширение не «патчит» встроенный микрофон, а полностью заменяет его логику: запись звука,
нарезка на фразы, распознавание параллельно с записью и вставка текста по кнопке «стоп» —
всё под вашим контролем.

```
Ctrl+Alt+D  (Cmd+Alt+D на macOS) — начать / остановить диктовку
```

Интерфейс расширения двуязычный: русский и английский. Язык берётся из языка отображения
VS Code; любой третий язык показывает английский. Подробнее — раздел «Языки интерфейса».

---

## 1. Как устроен микрофон Copilot Chat в VS Code

Чтобы понять, что именно можно заменить, полезно знать, как это сделано в самом VS Code
(проверено по исходникам `microsoft/vscode`, ветка `main`).

### Встроенная диктовка чата

Микрофон в поле ввода чата — это **внутренний сервис ядра**, а не расширение:

| Что | Где |
| --- | --- |
| Оркестрация сессии, настройки, телеметрия | `src/vs/workbench/contrib/chat/browser/speechToText/chatSpeechToTextService.ts` |
| Захват микрофона (Web Audio `getUserMedia` + AudioWorklet, 16 кГц PCM) | `chatSpeechToTextService.ts` → `getMediaCaptureWindow()` / `pcmCaptureWorklet.ts` |
| On-device распознавание | `src/vs/platform/localTranscription/*` (модель NeMo, скачивается локально) |
| Облачное распознавание | голосовой сервис Copilot (`mai`, WebSocket) |
| Пост-обработка (пунктуация, списки) | небольшая LLM Copilot, настройка `dictation.experimental.llmCleanup` |

Ключевые настройки встроенной диктовки:

- `dictation.enabled` — выключить встроенную диктовку (kill switch);
- `dictation.model` — `mai` (облако) или id локальной модели;
- `dictation.showTranscript`, `dictation.showButton` — UI;
- `accessibility.voice.speechLanguage` — язык (это значение использует и наше расширение в режиме `auto`).

Вывод: **микрофон в чате не имеет точки расширения**. Он жёстко связан с бэкендами Copilot
(облако / локальная NeMo-модель), язык и модель выбрать нельзя.

### Точка расширения, которая всё-таки существует

В VS Code есть *proposed* API — `vscode.proposed.speech.d.ts`:

```ts
vscode.speech.registerSpeechProvider(id, {
  provideSpeechToTextSession(token, { language }) { /* свои события Started/Recognizing/Recognized/Stopped */ }
})
```

Плюс вклад `speechProviders` в `package.json`. Эти провайдеры использует `ISpeechService`, а через него —
**диктовка в редакторе** (`workbench.action.editorDictation.start`) и **голосовой ввод в терминале**.
Чат мимо: он ходит в собственный сервис.

Ограничения этого пути:

- API *proposed*: без запуска с `--enable-proposed-api <id>` объект `vscode.speech` не активен;
- несколько провайдеров одновременно — ядро берёт **первый зарегистрированный**;
- провайдер обязан сам добывать звук: ядро передаёт только события, не аудио.

### Почему нельзя просто взять микрофон в webview

Соблазнительный путь «скрытый webview + `getUserMedia`» не работает: в
`src/vs/code/electron-main/app.ts` для webview разрешены только `pointerLock`, `notifications` и
clipboard, а `media` разрешён лишь основному окну VS Code:

```ts
const allowedPermissionsInWebview = new Set([...alwaysAllowedPermissions, 'clipboard-read', 'clipboard-sanitized-write']);
const allowedPermissionsInCore    = new Set([...alwaysAllowedPermissions, 'media', 'local-fonts']);
```

Поэтому расширение обязано записывать звук **вне рендерера** — процессом ОС (ffmpeg) или своей
командой. Именно так и сделано здесь.

---

## 2. Что делает это расширение

```
микрофон ──ffmpeg/ваша команда──▶ PCM 16 кГц моно
        ──VAD-нарезка на фразы по паузам──▶ ваша модель (фразы уходят по ходу речи)
        ──«стоп» ──▶ дождаться хвоста ──▶
        ──вставка в чат одним сообщением / в редактор / в буфер обмена
```

- **Распознавание идёт параллельно с записью.** Фраза отправляется модели сразу, как только вы
  замолчали (`customDictation.audio.silenceMs`, по умолчанию 600 мс), — модель не простаивает.
- **Вставка — один раз, по кнопке «стоп».** Пока вы говорите, в чат ничего не пишется: после остановки
  вставляется весь текст целиком, одним сообщением.
- **Ничего не теряется на остановке.** «Стоп» отпускает микрофон мгновенно, но запросы, которые уже
  ушли в модель, не обрываются: расширение дожидается их и только потом вставляет текст. Пока идёт
  дообработка хвоста, микрофон в статус-баре крутится (`$(sync~spin)`) и недоступен.
- **Контекст.** Хвост уже распознанного текста уходит в `prompt` модели (как в Whisper), чтобы
  имена и термины писались одинаково (`openai.sendContextPrompt`).
- **Свой язык и модель.** `openai.model`, `openai.extraBody` (например `vad_filter`, `hotwords`),
  `language`.
- **Диагностика.** `Custom Dictation: Run Diagnostics` показывает ffmpeg, список микрофонов,
  доступность endpoint, состояние proposed API.

### Что заменяется, а что добавляется

| Поверхность VS Code | Что делает расширение |
| --- | --- |
| **Кнопка микрофона в поле ввода Copilot Chat** | **Не заменяется** — это сервис ядра без публичного API. Расширение даёт свой канал: микрофон в статус-баре (`Ctrl+Alt+D`) с индикатором и таймером. Штатную кнопку можно спрятать через `"dictation.showButton": false` (команда **Show / Hide Built-in Chat Microphone**) или выключить диктовку целиком через `"dictation.enabled": false`. |
| **Хоткей расширения** (`Ctrl+Alt+D`) | Полностью наш пайплайн: ffmpeg → ваша модель → вставка в чат/редактор/буфер. |
| **Диктовка в редакторе** (`Editor: Start Dictation`) | **Заменяется** через speech-провайдер: ядро берёт первый зарегистрированный провайдер. Нужен запуск с `--enable-proposed-api local.custom-dictation`. |
| **Голосовой ввод в терминале** | **Заменяется только если встроенная диктовка выключена** (`"dictation.enabled": false`): при включённой VS Code сначала пробует свой бэкенд и к провайдерам не обращается. |
| **Голосовой чат / voice chat** (`agentsVoice.startVoiceInChat`) | Идёт через speech-провайдер, то есть тоже на вашей модели (при `--enable-proposed-api`). |

Итого: «кнопку в чате» подменить нельзя, но можно спрятать её и пользоваться своим хоткеем;
диктовка редактора, терминала (при выключенной встроенной) и voice chat — реально переопределяются.


---

## 3. Установка

### Из исходников (F5)

```powershell
npm install
npm run compile
```

Затем `F5` (Run Extension) или:

```powershell
code --extensionDevelopmentPath="C:\path\to\vscode-russion-dictate"
```

### Как .vsix

```powershell
npm install
npx @vscode/vsce package --no-dependencies --allow-missing-repository
code --install-extension custom-dictation-0.1.0.vsix
```

### Требования

- **ffmpeg** в `PATH` (или укажите `customDictation.audio.ffmpegPath`).
  Windows: `winget install Gyan.FFmpeg`, macOS: `brew install ffmpeg`, Linux: пакет `ffmpeg`.
- Разрешение на микрофон для классических приложений
  (Windows: *Параметры → Конфиденциальность → Микрофон → Разрешить классическим приложениям*).

---

## 4. Подключение своей модели

### 4.1 Локальный Whisper / GigaAM через OpenAI-совместимый сервер (рекомендуется)

Подходит любой сервер с `POST /v1/audio/transcriptions`:
[speaches](https://github.com/speaches-ai/speaches) (бывший faster-whisper-server),
`whisper-server` из whisper.cpp, LocalAI, vLLM-обёртки, корпоративные шлюзы и т. п.

```powershell
pip install speaches
speaches --port 8000
```

`settings.json`:

```jsonc
{
  "customDictation.provider": "openai-compatible",
  "customDictation.openai.baseUrl": "http://127.0.0.1:8000/v1",
  "customDictation.openai.model": "Systran/faster-whisper-large-v3",
  "customDictation.language": "ru",
  // подсказки для распознавания ваших терминов
  "customDictation.openai.prompt": "Это диктовка по-русски про код: Copilot, VS Code, TypeScript.",
  "customDictation.openai.extraBody": { "vad_filter": "true", "hotwords": "Copilot,GigaChat" }
}
```

`whisper.cpp` (сервер):

```powershell
whisper-server -m models\ggml-large-v3-turbo.bin --host 127.0.0.1 --port 8080
```

```jsonc
{ "customDictation.openai.baseUrl": "http://127.0.0.1:8080/v1", "customDictation.openai.model": "whisper-1" }
```

Если сервер требует ключ — `Custom Dictation: Set API Key` (ключ лежит в `SecretStorage`, не в
`settings.json`).

### 4.2 Локальная модель без сервера (whisper.cpp)

Самый простой локальный вариант: расширению нужен только файл модели — `baseUrl` не нужен.

1. Скачайте сборку whisper.cpp (например `whisper-bin-x64.zip` из релизов) и распакуйте.
2. Скачайте модель, например `ggml-large-v3-turbo.bin` (или `ggml-medium.bin` для слабого CPU),
   из [huggingface.co/ggerganov/whisper.cpp](https://huggingface.co/ggerganov/whisper.cpp).
3. В VS Code: `Custom Dictation: Select whisper.cpp Model` → укажите **папку** с моделями или сам `.bin`.

```jsonc
{
  "customDictation.provider": "local-whisper",
  "customDictation.local.modelPath": "C:/whisper/models",      // папка или C:/whisper/models/ggml-medium.bin
  "customDictation.local.executablePath": "",                   // пусто = найти whisper-cli.exe самому
  "customDictation.language": "ru"
}
```

Как это работает:

- Если указана **папка**, расширение выбирает самую сильную модель по имени:
  `turbo` → `large-v3` → `large-v2` → `large` → `medium` → `small` → `base` → `tiny`.
  То есть `ggml-large-v3-turbo-q5_0.bin` выиграет у `ggml-small.bin`.
- `whisper-cli.exe` ищется рядом с моделью, в `bin/`, `bin/Release/`, `Release/`, `build/bin/`
  (раскладка официального zip-релиза) и затем в `PATH`. Можно задать путь явно.
- Каждая фраза распознаётся отдельным запуском CLI (`-nt`, без таймстемпов); текст читается из stdout.

Если хочется без перезапуска процесса на каждую фразу (быстрее для больших моделей) — используйте
вариант 4.1 с `whisper-server`: он держит модель в памяти.

### 4.3 GigaAM локально (ONNX + sherpa-onnx)

GigaAM — **не Whisper**: это Conformer-модель Sber в формате NeMo `.ckpt` / `.onnx`, поэтому
whisper.cpp её не загрузит. Локально она запускается через **sherpa-onnx** (он умеет NeMo-CTC ONNX).

1. Скачайте сборку sherpa-onnx для своей ОС (`sherpa-onnx-v…-win-x64-…no-tts.tar.bz2` из релизов
   [k2-fsa/sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx/releases)) и распакуйте.
2. Скачайте готовый sherpa-onnx-экспорт GigaAM, например
   [`Smirnov75/GigaAM-v3-sherpa-onnx`](https://huggingface.co/Smirnov75/GigaAM-v3-sherpa-onnx)
   → `gigaam_v3_e2e_ctc_int8.onnx` + `gigaam_v3_e2e_ctc_tokens.txt` (переименуйте в `tokens.txt`),
   либо сконвертируйте сами скриптами из `sherpa-onnx/scripts/nemo/GigaAM`.
3. В VS Code: `Custom Dictation: Select ONNX Model` → укажите **папку** с `.onnx` и `tokens.txt`.

```jsonc
{
  "customDictation.provider": "local-onnx",
  "customDictation.onnx.modelPath": "C:/gigaam",              // папка с .onnx + tokens.txt
  "customDictation.onnx.executablePath": "C:/sherpa/bin/sherpa-onnx-offline.exe",
  "customDictation.onnx.mode": "auto",                        // auto | server | cli
  "customDictation.language": "ru"
}
```

Как это работает:

- `mode: "auto"` — если рядом с CLI есть `sherpa-onnx-offline-websocket-server`, расширение держит
  **тёплый сервер**: модель загружается один раз, каждая фраза распознаётся за ~0.2 с.
  Иначе — запуск `sherpa-onnx-offline` на каждую фразу (модель перезагружается, ~1–2 с).
- `precision: "auto"` выбирает `*int8.onnx` (меньше памяти, быстрее на CPU), `fp32` — полную точность.
  RNNT-части (`*_encoder/_decoder/_joint`) игнорируются: используется CTC-голова.
- Сервер живёт только во время сессии диктовки и убивается при её завершении — «сирот» не остаётся.

Замер на этой машине (GigaAM-v3 e2e CTC int8, 7.2 с речи): тёплый сервер — **177 мс** на фразу,
CLI — **1.1–1.2 с**. Итоговый текст: «Привет. Это проверка локального распознавания речи в
Vishual Studio Cod» (пунктуация и заглавные — от `e2e`-модели).

### 4.4 Локальный CLI (`whisper-cli`, свой скрипт)

```jsonc
{
  "customDictation.provider": "command",
  "customDictation.command.transcribe":
    "whisper-cli -m C:/models/ggml-large-v3-turbo.bin -f ${file} -l ru -nt"
}
```

`${file}` подменяется на WAV (16 кГц, моно), `${out}` — на путь текстового файла, если ваша
команда пишет результат в файл. Иначе читается stdout.

### 4.5 GigaChat / SaluteSpeech (Sber, облако)

Важно: **GigaChat API — это чат-модель** (`/chat/completions`), распознавания речи в нём нет.
ASR в экосистеме Sber — **SaluteSpeech** (акустическая модель GigaAM), OAuth там общий с GigaChat.
Расширение поддерживает его напрямую:

1. Получите credentials в Sber Studio (scope `SALUTE_SPEECH_PERS`).
2. `Custom Dictation: Set SaluteSpeech Credentials` → «Authorization key» (Base64 `id:secret`)
   или пара Client ID / Client Secret.
3. `"customDictation.provider": "salute"`, `"customDictation.language": "ru-RU"`.

Если сертификаты Sber (Russian Trusted Root CA) не проходят проверку в Node —
включите `"customDictation.salute.insecureTLS": true`.

Endpoint-ы можно переопределить (`salute.tokenUrl`, `salute.recognizeUrl`), чтобы ходить через
корпоративный прокси или собственный шлюз.

### 4.6 Свой рекордер

Если ffmpeg не подходит, укажите команду, которая пишет **raw s16le 16 кГц моно** в stdout:

```jsonc
{ "customDictation.command.capture": "sox -q -t waveaudio default -r 16000 -c 1 -b 16 -e signed-integer -t raw -" }
```

---

## 5. Куда вставлять текст

| `customDictation.insert.target` | Поведение |
| --- | --- |
| `chat` (по умолчанию) | Фокус в поле ввода Copilot Chat + вставка через `editor.action.clipboardPasteAction`; буфер обмена восстанавливается. Черновик в поле сохраняется. |
| `editor` | Вставка в позицию курсора активного редактора через API редактора (фокус не перехватывается). |
| `clipboard` | Только буфер обмена — вставьте сами куда нужно. |

`insert.chatMode: "replace"` — альтернатива: поле чата целиком заполняется через
`workbench.action.chat.open` (перезаписывает черновик, зато не трогает буфер обмена).

---

## 6. Команды

| Команда | Что делает |
| --- | --- |
| `Custom Dictation: Start / Stop Dictation` | `Ctrl+Alt+D`, основной хоткей |
| `Custom Dictation: Cancel Dictation` | прервать и выбросить текст |
| `Custom Dictation: Stop Dictation and Copy to Clipboard` | стоп + копирование в буфер (`Ctrl+Alt+Shift+C`) |
| `Custom Dictation: Show / Hide Dictation Panel` | показать окно записи (или подсказку, если не активно) |
| `Custom Dictation: Select Speech-to-Text Provider` | быстрый выбор бэкенда |
| `Custom Dictation: Select Microphone` | список устройств через ffmpeg → записывает `audio.device` |
| `Custom Dictation: Select whisper.cpp Model` | указать `.bin`-модель или папку с моделями |
| `Custom Dictation: Select ONNX Model` | указать папку с GigaAM/NeMo ONNX + `tokens.txt` |
| `Custom Dictation: Set API Key` | ключ для OpenAI-совместимого сервера (SecretStorage) |
| `Custom Dictation: Set SaluteSpeech Credentials` | credentials Sber (SecretStorage) |
| `Custom Dictation: Run Diagnostics` | отчёт: ffmpeg, устройства, endpoint, proposed API |
| `Custom Dictation: Show Log` | канал вывода «Custom Dictation» |
| `Custom Dictation: Register as VS Code Speech Provider` | заменить диктовку **редактора/терминала** |
| `Custom Dictation: Show / Hide Built-in Chat Microphone` | скрыть/вернуть штатный микрофон в поле ввода чата |

### Как убрать штатный микрофон в чате

При первой установке расширение **само скрывает** микрофон в поле ввода чата
(`"dictation.showButton": false`), чтобы не было двух микрофонов. Это делается **один раз**:
флаг `chatMic.defaultApplied` в `globalState` не даёт потом навязывать это снова, поэтому если
вернуть кнопку командой, она останется на месте. Отключить сам авто-скрытый шаг:
`"customDictation.chatMic.hideBuiltin": false`.

Микрофон в поле ввода Copilot Chat рисует ядро, и его видимость определяется двумя настройками
ядра (обе читаются на лету, перезагрузка не нужна):

| Настройка | Что делает |
| --- | --- |
| `dictation.showButton: false` | **только прячет кнопку** микрофона в чате; диктовка остаётся доступной через `workbench.action.chat.toggleSpeechToText` |
| `dictation.enabled: false` | выключает встроенную диктовку целиком (редактор, терминал, чат) — кнопка тоже исчезает |

Команда **Custom Dictation: Show / Hide Built-in Chat Microphone** переключает первую:
пишет `"dictation.showButton": false` в пользовательские настройки, а при повторном вызове
**удаляет** ключ и возвращает значение по умолчанию (`true`). Вторую настройку команда не
трогает намеренно: она задела бы ещё и диктовку редактора.

Проверить, что сейчас: `Custom Dictation: Run Diagnostics` показывает `dictation.showButton`
и `dictation.enabled`.

### Микрофон в окне Agents (Sessions Window)

Окно Agents — это **отдельный workbench** (`out/vs/sessions/sessions.desktop.main.js`), не вкладка
основного окна. Что в нём реально есть (проверено по его бандлу):

| Возможность | В окне Agents |
| --- | --- |
| штатный микрофон в поле ввода чата (`chatSpeechToTextService`, `dictation.showButton`) | **есть**, скрывается тем же флагом |
| `workbench.action.chat.open`, `focusInput`, `editor.action.clipboardPasteAction` | есть — вставка текста работает |
| уведомления и прогресс (`MainThreadMessageService`, `MainThreadProgress`) | есть |
| webview-**панель** в области редактора (`MainThreadWebweview`) | есть — наш режим `panel` откроется |
| **статус-бар** | **нет.** В `getLayoutClasses()` класс `"nostatusbar"` добавляется безусловно, а `isVisible("workbench.parts.statusbar") → false` |
| **вкладки-представления расширений** | **нет.** Канала `MainThreadViews` в бандле окна нет вовсе |
| поле ввода чата как контейнер для своих кнопок | **нет** — это core-виджет, API тулбара не существует |

По умолчанию сторонние расширения в этом окне **не выполняются**:

```js
canExecuteOnSessionsWindow(manifest, isBuiltin) {
  const configured = getConfiguredSessionsWindowSupport(manifest); // extensions.supportAgentsWindow[id]
  if (configured !== undefined) return configured;
  ...
  return manifest.main || manifest.browser ? false : …;  // наш случай: есть main → false
}
```

плюс `product.json → sessionsWindowAllowedExtensions` — белый список из ~30 расширений.

Поэтому расширение при активации прописывает себя в `extensions.supportAgentsWindow`
(настройка `customDictation.chatMic.runInAgentsWindow`, по умолчанию `true`):

```jsonc
"extensions.supportAgentsWindow": { "local.custom-dictation": true }
```

**Практический итог:** в окне Agents наша диктовка доступна только с клавиатуры —
`Ctrl+Alt+D` (старт/стоп), `Ctrl+Alt+Shift+C` (стоп и копирование), плюс режим `panel`
открывается вкладкой в области редактора. Кнопку-микрофон туда положить некуда: статус-бар
скрыт по дизайну, вкладки расширений не поддерживаются, а поле ввода чата — core.

### Фокус в поле ввода чата

Текст вставляется в конце записи, поэтому перед вставкой расширение возвращает фокус в поле
ввода. Делается это каскадом команд, а не одной:

| Команда | Что делает в ядре |
| --- | --- |
| `workbench.action.chat.focusInput` | `lastFocusedWidget?.focusInput()` |
| `workbench.action.chat.open` | `lastFocusedWidget` → если его нет или он не виден: `revealWidget()`, затем `focusInput()` |
| `workbench.action.chat.focusInput` (ещё раз, через 60 мс) | повтор после того, как созданный виджет успел построить поле ввода |

Причина каскада: `focusInput` при отсутствии «последнего виджета чата» **молча ничего не
делает** и не бросает ошибку. В окне Agents чат часто ещё ни разу не был в фокусе, поэтому
раньше вызов считался успешным, а фокус никуда не переходил. Теперь `chat.open` выполняется
всегда, даже если `focusInput` «прошёл».

### Диктовка в редакторе и терминале

Чтобы встроенная диктовка редактора/терминала шла через вашу модель:

```powershell
code --enable-proposed-api local.custom-dictation
```

затем `Custom Dictation: Register as VS Code Speech Provider` и перезагрузите окно
(`Developer: Reload Window`). Расширение регистрируется на `onStartupFinished`, чтобы успеть
раньше встроенного провайдера (ядро берёт первый зарегистрированный).

Для терминала дополнительно нужно выключить встроенную диктовку, иначе VS Code использует свой
бэкенд и до провайдеров не доходит:

```jsonc
{ "dictation.enabled": false }
```

Чат-кнопку микрофона это не затрагивает: она всегда встроенная. Если она мешает — тот же
`"dictation.enabled": false` её уберёт, а диктовку в чат даст хоткей расширения.

Если нужно наоборот — вернуть встроенный микрофон в чате, оставив своё распознавание только
для чата через хоткей, ничего делать не нужно: чат никогда не использовал speech-провайдеров.

### Замена хоткея встроенного микрофона

`keybindings.json`:

```jsonc
[
  { "key": "ctrl+alt+v", "command": "customDictation.toggle", "when": "chatInputFocused" },
  // и/или отключить встроенную диктовку совсем:
  { "key": "ctrl+alt+v", "command": "-workbench.action.chat.toggleSpeechToText" }
]
```

---

## 7. Микрофон и всплывающее окно

В статус-баре — **только микрофон**:

| Состояние | Вид |
| --- | --- |
| Простой | `$(mic)` |
| Запись | `$(mic-filled)` **красный** |
| Распознавание | `$(sync~spin)` |
| Не вставилось | `$(warning)` красный |
| Готово | `$(check)` / `$(clippy)` / `$(info)` → через 4 с снова `$(mic)` |

Текст меняется только при смене состояния, никогда на каждом кадре звука.

**При старте диктовки всплывает окно** прямо над статус-баром, поверх редактора:

```
Dictation  0:07                                            ✕
```

- внутри **только таймер** (и `распознавание…`, пока модель дорабатывает хвост): в тосте нельзя
  рисовать волну, а символьная «волна» прыгала по ширине. Иконки вида `$(sync~spin)` в тексте
  уведомления не рендерятся — они видны буквально, поэтому состояние пишется словами;
- окно **не забирает фокус**: текст вставляется в чат после остановки;
- висит, пока идёт запись, и закрывается, когда модель доработала хвост;
- подсказки при наведении на микрофон в этом режиме **не показываются вовсе** — всё видно в окне.

Остановить: клик по микрофону в статус-баре, `Ctrl+Alt+D`, или `✕` (отмена).
Остановить и скопировать: `Ctrl+Alt+Shift+C`.

### Режим `panel`

`"customDictation.controls": "panel"` — закреплённая вкладка, всё в одну строку:

```
▁▂▃▅▆▇▆▅▃▂▁▁▂▃▅▆▇▆▅▃▂▁   0:07   (■)  (⧉)
```

- волна из `div`-столбиков, едет справа налево;
- `(■)` — остановить и вставить;
- `(⧉)` — остановить и **скопировать в буфер обмена** (текст в чат не вставляется).

### Почему окно именно такое

Окошко, которое вы показываете у Copilot (карточка с «клювиком», привязанная к иконке и
закрепляющаяся по клику), — это **внутренний hover работы ядра**. В `statusbarItem.ts`:

```ts
const isTooltipCommand = command === ShowTooltipCommand || command === ToggleTooltipCommand;
```

закрепление делает только `ToggleTooltipCommand`, и сравнение идёт **по идентичности объекта**.
Команда расширения приходит из `extHostStatusBar` как DTO `{ id, title }` через
`CommandsConverter.toInternal` — она никогда не совпадёт с внутренним объектом ядра. Значит
закрепить подсказку из расширения нельзя: так умеет только встроенный Copilot, чей элемент
создаётся в ядре.

Отсюда же было и мерцание: при любом изменении `status.tooltip` ядро вызывает
`hover.update(...)` для **уже открытой** подсказки. Поэтому в подсказке теперь только статичный
текст, а всё живое — в отдельном всплывающем окне.

Альтернативы, если тост не нравится (`"customDictation.controls"`):

| Значение | Что делает |
| --- | --- |
| `toast` (по умолчанию) | всплывающее окно над статус-баром |
| `panel` | закреплённая панель-вкладка: всё одной строкой — div-волна, таймер, кнопка «стоп» и иконка «копировать в буфер» |
| `none` | только микрофон в статус-баре |

### Если вставить не удалось
Вставка проверяется, а не предполагается:

- поле чата не открылось (`workbench.action.chat.open`/`focusInput` бросили ошибку) — фиксируется сбой;
- `editor.action.clipboardPasteAction` не выполнилась — сбой;
- редактор не принял вставку (`edit()` вернул `false` или длина документа не изменилась) — сбой.

Тогда расширение **явно сообщает**: всплывает предупреждение «Текст не попал в поле ввода чата…»,
а сам текст по умолчанию **копируется в буфер обмена** (`insert.fallbackToClipboard`), чтобы ничего
не потерялось. В статус-баре загорается красный `$(warning)`, в tooltip — причина. Если фолбэк
выключен, в уведомлении есть кнопка *Copy to clipboard*. Всё дублируется в лог
(*Custom Dictation: Show Log*).

### Авто-остановка по тишине

`"customDictation.audio.autoStopSilenceMs": 60000` — если 60 секунд нет голоса, запись
останавливается сама (текст при этом вставляется как обычно), а в уведомлении написано
«запись остановлена — N с без речи». Значение в миллисекундах: `60000` — минута, `30000` — 30 с.
`0` отключает авто-остановку совсем.

Отсчёт начинается заново с каждой голосовой фразы, поэтому долгая диктовка с паузами не
обрывается — стоп случится только после минуты полной тишины.

### Звуковые сигналы

При старте записи играется короткий сигнал, при остановке — другой, помягче.
Два готовых звука лежат в `sounds/` (CC0, см. `sounds/CREDITS.md`), синтеза нет.

| Настройка | По умолчанию | Смысл |
| --- | --- | --- |
| `audio.cues.start` | `true` | сигнал в начале записи |
| `audio.cues.end` | `true` | сигнал в конце записи (в том числе авто-стоп и отмена) |
| `audio.cues.volume` | `15` | громкость сигналов в процентах (`0` — тишина, `100` — как записан файл) |

Выключаются независимо, например «только на старте»:

```jsonc
"customDictation.audio.cues.end": false
```

Громкость применяется к самим сэмплам, а не флагом плеера: иначе `SoundPlayer` на Windows и
`aplay` на Linux играли бы в полную силу, а `ffplay` — тихо. Поэтому при громкости ниже 100 %
один раз готовится приглушённая копия во временной папке, и играет уже она.

Играет `ffplay` рядом с вашим `ffmpeg` (он нужен диктовке и так). Если `ffplay` нет —
системный плеер: `powershell`/`SoundPlayer` на Windows, `afplay` на macOS, `paplay` или `aplay`
на Linux. Если плеер не нашёлся, диктовка работает как обычно — в лог пишется одно
предупреждение, и всё.

Важное ограничение: поповер, который VS Code показывает по клику на иконку Copilot
(`div.chat-status-bar-entry-tooltip`), — внутренний DOM workbench. В extension API его нет:
в `src/vscode-dts` 173 proposed-API и ни одного про popover. Поэтому «как у Copilot» у расширения
не получится, но статичный hover-тултип с кнопками полностью решает задачу (и не мерцает,
потому что не обновляется).

---

## 8. Все настройки

| Настройка | По умолчанию | Смысл |
| --- | --- | --- |
| `provider` | `openai-compatible` | `openai-compatible` \| `local-whisper` \| `local-onnx` \| `salute` \| `command` |
| `language` | `auto` | `auto` → `accessibility.voice.speechLanguage` → локаль ОС |
| `insert.target` | `chat` | куда вставлять: `chat` \| `editor` \| `clipboard` |
| `insert.chatMode` | `paste` | `paste` (сохраняет черновик) или `replace` |
| `insert.fallbackToClipboard` | `true` | если вставка не удалась — скопировать текст в буфер и сообщить |
| `audio.ffmpegPath` | `ffmpeg` | путь к бинарю (или имя в PATH) |
| `audio.inputFormat` | `auto` | `dshow` (Win), `avfoundation` (mac), `pulse`/`alsa` (Linux) |
| `audio.device` | `""` | имя/индекс/`@device_...`; пусто — первое устройство |
| `audio.cues.start` / `audio.cues.end` | `true` / `true` | звуковые сигналы в начале и в конце записи |
| `audio.cues.volume` | `15` | громкость сигналов, % |
| `audio.silenceMs` | `600` | пауза, закрывающая фразу (фраза сразу уходит модели) |
| `audio.minSegmentMs` | `400` | короче — считается шумом |
| `audio.maxSegmentMs` | `15000` | принудительный разрез длинной речи |
| `audio.noiseThreshold` | `0` | `0` — авто-шумовой порог; `0.01` ≈ −40 dBFS |
| `audio.autoStopSilenceMs` | `60000` | авто-стоп после N мс без голоса (`60000` — минута); `0` — выключено |
| `openai.baseUrl` / `openai.model` | `http://127.0.0.1:8000/v1` / `whisper-1` | OpenAI-совместимый endpoint |
| `openai.extraBody` | `{}` | доп. поля multipart (`vad_filter`, `hotwords`, …) |
| `openai.prompt` | `""` | подсказка/словарь |
| `openai.sendContextPrompt` | `true` | добавлять хвост распознанного в prompt |
| `openai.requestTimeoutMs` | `60000` | таймаут запроса |
| `salute.*` | Sber endpoints | `tokenUrl`, `recognizeUrl`, `scope`, `clientId`, `insecureTLS` |
| `command.capture` | `""` | свой рекордер (raw PCM в stdout) |
| `command.transcribe` | `""` | CLI-распознаватель для `provider: command` |
| `local.modelPath` | `""` | `.bin`-модель или папка с `ggml-*.bin` (`provider: local-whisper`) |
| `local.executablePath` | `""` | путь к `whisper-cli`; пусто — искать рядом с моделью и в `PATH` |
| `local.extraArgs` | `""` | доп. аргументы whisper.cpp (например `--threads 8`) |
| `onnx.modelPath` | `""` | папка с GigaAM/NeMo `.onnx` + `tokens.txt` (`provider: local-onnx`) |
| `onnx.executablePath` | `""` | путь к `sherpa-onnx-offline`; пусто — искать рядом с моделью и в `PATH` |
| `onnx.precision` / `onnx.mode` | `auto` / `auto` | `int8`\|`fp32`; `server` (тёплый) \| `cli` |
| `onnx.extraArgs` | `""` | доп. аргументы sherpa-onnx |
| `statusBar.enabled` | `true` | микрофон в статус-баре |
| `controls` | `toast` | окно записи: `toast` \| `panel` \| `none` |
| `chatMic.hideBuiltin` | `true` | при первой установке скрыть штатный микрофон в чате (один раз) |
| `chatMic.runInAgentsWindow` | `true` | разрешить работу расширения в окне Agents (`extensions.supportAgentsWindow`) |
| `speechProvider.enabled` | `false` | регистрировать речь-провайдер при старте |

---

## 9. Языки интерфейса

Расширение поставляется с двумя языками — **русским и английским**. Язык берётся из языка
отображения VS Code (`Configure Display Language`): `ru` → русский, всё остальное → английский.
Отдельной настройки нет — так же ведут себя встроенные расширения.

Два независимых набора строк:

| Что переводится | Где лежит | Как подключается |
| --- | --- | --- |
| уведомления, ошибки, статус-бар, подсказки | `l10n/bundle.l10n.json` + `l10n/bundle.l10n.ru.json` | `"l10n": "./l10n"` в `package.json`, вызовы `t('English text')` из `src/i18n.ts` |
| названия команд, описания настроек, `displayName`/`description` | `package.nls.json` + `package.nls.ru.json` | в манифесте вместо строк стоят `%ключи%` |

Английский текст является ключом: в русском файле — та же строка ключом и перевод значением.
Если для языка нет файла (немецкий, французский, …), VS Code берёт `bundle.l10n.json`,
где ключ равен самому себе, — то есть английский.

Добавить третий язык: скопировать `l10n/bundle.l10n.ru.json` в `bundle.l10n.<locale>.json`
и `package.nls.ru.json` в `package.nls.<locale>.json`, перевести значения. Код менять не нужно.

Тесты (`src/test/i18n.test.ts`) проверяют, что каждый `t('…')` в коде есть в обоих бандлах,
что ключи совпадают, что `{0}`/`{1}` не потерялись при переводе и что каждый `%ключ%`
из манифеста есть в `package.nls.json`.

---

## 10. Диагностика проблем

1. `Custom Dictation: Run Diagnostics` — покажет, видит ли расширение ffmpeg, микрофоны и endpoint.
2. `Custom Dictation: Show Log` — каждая фраза, её длительность и текст; ошибки HTTP.
3. Ничего не распознаётся:
   - тихий микрофон → уменьшите `audio.noiseThreshold` (например `0.006`);
   - шумная комната → увеличьте (`0.02`), фразы будут резаться реже;
   - проверьте `audio.device` — на Windows имена устройств локализованы, расширение подставляет
     ASCII-имя `@device_cm_...`, потому что CRT в ffmpeg декодирует аргументы в ANSI-кодировке.
4. Диктовка «залипает»: `Ctrl+Alt+D` ещё раз, затем `Cancel Dictation`, лог покажет, где встало.

---

## 11. Структура проекта

```
src/extension.ts              активация, команды, диагностика
src/speechProvider.ts         мост в proposed API `vscode.speech`
src/config.ts, configTypes.ts настройки + секреты
src/capture/devices.ts        перечисление устройств (dshow/avfoundation/pactl) и парсинг
src/capture/source.ts         ffmpeg/команда → PCM в stdout
src/audio/wav.ts              PCM16 ↔ WAV, RMS
src/audio/segmenter.ts        VAD и нарезка на фразы
src/dictation/recognition.ts  конвейер: запись → фразы → распознавание (параллельно записи)
src/dictation/session.ts      сессия диктовки (вставка текста)
src/dictation/controller.ts   микрофон, панель, авто-стоп, ошибки
src/ui/dictationPanel.ts      закрепляемая панель: одна строка — волна, таймер, стоп, копирование
src/insert/inserter.ts        чат / редактор / буфер обмена
src/stt/*.ts                  клиенты: OpenAI-compatible, SaluteSpeech, CLI, whisper.cpp, sherpa-onnx
src/util/websocket.ts         минимальный RFC 6455 клиент для тёплого sherpa-onnx сервера
src/test/*.test.ts            юнит- и HTTP-тесты (node --test)
```

Тесты:

```powershell
npm test          # tsc + node --test out/test/*.test.js
```

---

## 12. Ограничения

- Кнопку микрофона в поле ввода чата нельзя подменить «изнутри»: она — часть ядра. Расширение даёт
  свой канал (хоткей + статус-бар, свой захват звука и свой бэкенд); кнопку можно скрыть через
  `"dictation.enabled": false`. Диктовка редактора, voice chat и (при выключенной встроенной
  диктовке) терминала переопределяются через speech-провайдер.
- Захват идёт через ffmpeg: задержка складывается из буфера записи (100 мс) и паузы,
  закрывающей фразу (`audio.silenceMs`).
- Вставка происходит один раз, по остановке: если модель дорабатывает последнюю фразу, окно
  диктовки ещё висит, а микрофон в статус-баре показывает спиннер и не запускается заново.
- `vscode.speech` — proposed API: без `--enable-proposed-api` он недоступен, остальные режимы
  расширения работают всегда.
- Стриминговые ASR с partial-результатами не используются: фразы уходят в модель целиком,
  но параллельно с записью, поэтому на остановку остаётся только хвост.
- `local-whisper` запускает `whisper-cli` на каждую фразу: модель загружается заново (быстро для
  `tiny`/`base`, заметно для `large`). Для больших моделей выгоднее `whisper-server` из п. 4.1.
- `local-onnx` работает только с NeMo-CTC ONNX (GigaAM и подобные). Whisper-модели в ONNX сюда не
  подходят — для них есть `local-whisper` или OpenAI-совместимый сервер.
