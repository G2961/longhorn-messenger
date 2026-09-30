# Longhorn Messenger — Tauri 2 (Windows)

Десктоп-обёртка: статический фронтенд из `../ui` в системном WebView2,
Rust-бэкенд минимальный (одна команда + плагин opener).

## Структура

```
src-tauri/
├── tauri.conf.json       конфиг Tauri 2 (schema v2)
├── Cargo.toml            tauri 2, serde, serde_json, tauri-plugin-opener
├── build.rs              tauri_build (генерирует контекст из tauri.conf.json)
├── capabilities/
│   └── default.json      разрешения для кастомного тайтлбара (drag/min/max/close)
├── icons/                PNG + ICO, сгенерировано tools/gen_icons.py
└── src/
    ├── main.rs           точка входа (windows_subsystem = "windows")
    └── lib.rs            команда connect_server + запуск приложения
```

## Команда `connect_server`

```js
import { invoke } from "@tauri-apps/api/core";
const info = await invoke("connect_server", { url: "http://127.0.0.1:8080" });
// { ok: true, url, scheme, host, port } — либо throws с текстом ошибки
```

Проверка **синтаксическая** (http/https), сеть не трогается — reqwest не
подключён ради скорости сборки. Фронт сам ставит WebSocket/HTTP-соединение
(CSP: `wss://*`, `http://localhost:*`, `http://127.0.0.1:*`).

## Сборка

Один раз установить CLI:

```
npm i -D @tauri-apps/cli
```

Дальше из корня проекта:

```
npx tauri build          # релиз: exe + установщики nsis/msi в target/release/bundle/
npx tauri dev            # отладка (откроет ../ui как есть, без dev-сервера)
npx tauri icon           # перегенерировать иконки из icon.png (см. ниже)
```

Готовые артефакты:

- EXE: `src-tauri/target/release/longhorn-messenger.exe`
- Установщики: `src-tauri/target/release/bundle/nsis/` и `.../msi/`

Иконка и версия берутся из `tauri.conf.json` → `bundle.icon` и `version`.

## Иконки

Текущие — программный плейсхолдер (голубой градиент + белый круг),
сгенерирован `python tools/gen_icons.py` (stdlib, без зависимостей).

Чтобы заменить на дизайн:

1. Положите квадратный PNG ≥ 512×512, например `src-tauri/app-icon.png`.
2. `npx tauri icon src-tauri/app-icon.png` — CLI перегенерирует весь
   набор (`icons/`, все размеры + `.ico`).
3. Либо запустите свой генератор: `python tools/gen_icons.py`.

`.ico` собран как PNG-in-ICO (Vista+) — Windows 10/11 понимает нормально.

## Подпись (опционально)

Без подписи Windows SmartScreen будет предупреждать. Подписать установщик:

```
signtool sign /fd SHA256 /tr http://timestamp.digicert.com /td SHA256 ^
  /f cert.pfx /p <пароль> src-tauri/target/release/bundle/nsis/*.exe
```

`signtool` входит в Windows SDK. Для CI положите PFX в секреты.
Tauri сам подхватит подпись, если задать переменные окружения
`TAURI_SIGNING_PRIVATE_KEY` (updater-подпись, не путать с code signing).

## Заметки

- Окно: 980×680, min 420×540, `decorations: false` — тайтлбар рисует
  фронтенд (`data-tauri-drag-region` + кнопки minimize/toggle-maximize/close,
  разрешения уже выданы в `capabilities/default.json`).
- `frontendDist: "../ui"` — билд фронтенда не нужен, каталог статический.
- single-instance и shell-плагины сознательно не подключены (минимум зависимостей).
