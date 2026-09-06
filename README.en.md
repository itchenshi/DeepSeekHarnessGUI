# DSH GUI

> A desktop shell for DeepSeek Harness — embedded Web UI, always-latest engine, portable data directory, and a system tray.

[![中文](https://img.shields.io/badge/README-中文-blue)](README.md)
[![English](https://img.shields.io/badge/README-English-green)](README.en.md)
[![license](https://img.shields.io/github/license/itchenshi/DeepSeekHarnessGUI)](LICENSE)
[![release](https://img.shields.io/github/v/release/itchenshi/DeepSeekHarnessGUI)](https://github.com/itchenshi/DeepSeekHarnessGUI/releases)
[![stars](https://img.shields.io/github/stars/itchenshi/DeepSeekHarnessGUI)](https://github.com/itchenshi/DeepSeekHarnessGUI/stargazers)
[![platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-blue)]()
[![Gitee](https://img.shields.io/badge/Gitee-mirror-red)](https://gitee.com/itchenshi/DeepSeekHarnessGUI)

DSH GUI is an **unofficial** desktop shell for [DeepSeek Harness](https://www.deepseek.com/harness/) (DeepSeek's open-source agent framework, `@deepseek-ai/dsh`, currently a technical preview). It wraps Harness's Web UI in a native window: out-of-the-box, tray-resident, self-updating — while keeping 100% of Harness's capabilities because the shell runs the official engine untouched.

```
┌────────────────────────────────────────────┐
│  DSH GUI (Electron App Shell)             │
│  ├─ Embedded window (Harness UI via dsh web) │
│  ├─ System tray (Open window / Settings / Exit) │
│  ├─ Engine updater (startup + periodic checks) │
│  └─ Data directory (default ~/.dsh, switchable & migratable) │
└────────────────────────────────────────────┘
```

## ✨ Features

- **No external browser**: the shell spawns `dsh web --no-open --port 0`, parses the authenticated loopback URL from stdout, and loads it into the embedded Electron window.
- **Always the latest Harness**: checks the npm registry `latest` at startup and periodically (default every 1 hour). On a new version it follows the policy: **ask before updating (default) / silent update / notify only**; updates install into the app's private directory and a **persistent badge** pops up bottom-right when done.
- **Fresh session every launch**: the embedded window uses an in-memory session (cookies/login state never touch disk); a new `dsh` child process is spawned each launch, and the whole process tree is cleaned up on exit.
- **Controllable data directory**: defaults to the system `~/.dsh`; switchable to the app directory (`<userData>/dsh-home`). On switch, existing data is detected and you're asked whether to **move** it (stop engine → migrate → restart with the new directory).
- **Theme follows Harness**: reads `ui-theme.preference` (light / dark / system) from `$DSH_HOME/settings.yaml` at startup and applies it to the window and pages.
- **Main window starts maximized**, with no size flicker while hidden.
- **System tray**: right-click menu "Open window / Settings / Exit"; closing the window hides to tray by default (can be set to "quit directly", which removes the tray icon too).
- **Modal settings window**: while settings are open, the main window cannot be operated or closed.
- **Cross-platform**: Windows / macOS / Linux; app icon derived from the Harness site favicon (brand blue `#4D6BFE`), shipped at all sizes.
- **Zero-config runtime**: no installation, no system Node required — a portable Node (≥ v23, needed by the engine's zstd API) is bundled into the package.

## 📸 Screenshots

> TODO: add main window / settings window / tray menu / first-launch status page here.

## 🚀 Quick Start

Prerequisite (only for development / running from source): [Node.js](https://nodejs.org/) **≥ 23** (DeepSeek Harness engine relies on Node 23+'s zstd API; includes npm).
Packaged builds ship a portable Node — end users don't need any runtime installed.

```sh
npm install        # install electron / build dependencies
npm start          # start DSH GUI
```

On first launch, the DeepSeek Harness engine is installed automatically (about 1–2 minutes, progress shown on the status page); after that it's only re-installed when Harness ships a new version.

## ⚙️ Update Settings (defaults)

| Setting | Default | Description |
|---|---|---|
| Update policy | **ask before updating** | silent update / ask before updating / notify only |
| Check for updates | on | when off, the registry isn't queried; the local engine is used directly (first launch without an engine still installs once) |
| Check interval | **1 hour** | skipped at startup if the last check was more recent; checked periodically while running |
| Data directory | **system ~/.dsh** | if the source directory has data, you'll be asked whether to move it |
| Close window | **hide to tray** | the other option is "quit directly" (close to quit, tray removed) |

Settings persist to `<userData>/settings.json` and save on change; also reachable via menu `Settings → Open settings window…` (modal) or the tray "Settings" item.

## 📦 Architecture & Data

```
startup
 └─ single-instance lock → read settings.json → read Harness theme (ui-theme.preference)
     → create window (maximized, in-memory session)
         └─ boot()
             ├─ resolve Node: bundled portable → $DSH_SHELL_NODE → system PATH
             ├─ check for updates when needed (npm registry) → install/prompt per policy
             ├─ spawn node <engine>/lib/bin.js web --no-open --port 0
             ├─ parse `dsh web: <url>` from stdout → load embedded
             └─ exit: kill process tree + destroy tray
```

All DeepSeek Harness user data lives under `$DSH_HOME` (default `~/.dsh`):

| Content | Path |
|---|---|
| Model / system / plugin settings | `<DSH_HOME>/settings.yaml` (incl. `ui-theme.preference`) |
| Session history | `<DSH_HOME>/sessions/<encoded-project-path>/<session-id>/session.jsonl.zstd` |
| Workspace records | `<DSH_HOME>/storages/` (workspace business files stay in the real directory) |
| Profile config & overlays | `<DSH_HOME>/profiles/web/...` |
| Credentials / attachments / anonymous ID | `<DSH_HOME>/credentials…` etc. |

## 🔧 Environment variables (optional)

| Variable | Purpose |
|---|---|
| `DSH_SHELL_NODE` | Node executable used to run the engine (bundled Node preferred by default) |
| `DSH_SHELL_HOME` | Override `DSH_HOME` for this launch (test isolation) |
| `DSH_SHELL_USERDATA` | Redirect the whole userData (engine/settings/npm cache) |
| `DSH_SHELL_REGISTRY_URL` | Version check source (e.g. `https://registry.npmmirror.com/@deepseek-ai/dsh/latest`) |
| `DSH_SHELL_AUTOQUIT_MS` | Gracefully quit N ms after the UI loads (CI / smoke tests) |
| `DSH_SHELL_TEST_LATEST` / `DSH_SHELL_TEST_NOTICE` / `DSH_SHELL_TEST_OPEN_SETTINGS` | Test hooks |
| `DSH_NODE_VERSION` / `DSH_NODE_MIRROR` | Bundled Node version and download mirror used when packaging |
| `DSH_NODE_ARCH` / `DSH_NODE_PLATFORM` | Override the target platform/arch of the bundled Node (e.g. CI cross-builds the x64 macOS app on an Apple Silicon runner with `DSH_NODE_ARCH=x64`) |

## 🛠 Packaging

```sh
npm run make-icons    # render icons at all sizes (build/, src/)
npm run bundle:node   # download current-platform portable Node to resources/node
npm run dist          # combined win + linux build (platform limits apply — see below)
npm run dist:win      # Windows → dist/DSH-GUI-WIN/ + .zip + NSIS installer
npm run dist:mac      # macOS   → dist/DSH-GUI-MAC/ + .zip + .dmg (requires macOS)
npm run dist:linux    # Linux   → dist/DSH-GUI-LINUX/ + .zip + .AppImage
```

- **Directory naming**: electron-builder's `*-unpacked` dirs are renamed to `DSH-GUI-WIN` / `DSH-GUI-MAC` / `DSH-GUI-LINUX` by `scripts/fix-unpacked.mjs`, which also produces same-named **`.zip`** files (unzip = ready-to-run directory).
- **Bundled Node**: downloaded per platform by `scripts/bundle-node.mjs` (default v26; the engine's session persistence needs Node ≥ 23's zstd API). `scripts/after-pack.js` copies it into the app in full before packaging (`extraResources` can't be used — it drops `node_modules`, leaving bundled Node without npm). If the bundled Node has no npm, `npm` falls back to the host Node's npm-cli automatically.
- **Platform limits**: AppImage's `mksquashfs` only runs on Linux/macOS, so the linux step of `npm run dist` on Windows fails with `ENOENT`; build each platform on its own OS or in CI/Docker (e.g. `electronuserland/builder`).
- **Cross-arch macOS**: CI builds the x64 macOS package on an Apple Silicon runner by setting `DSH_NODE_ARCH=x64` (see `.github/workflows/build-all.yml`), so each dmg bundles a Node matching its architecture.

## 🗂 Directory structure

```
├─ src/                   # app source (main process / pages / utility modules)
│  ├─ main.js             # main process: engine updates, window, tray, settings, data migration
│  ├─ preload.js          # settings-window IPC bridge
│  ├─ settings.html       # settings window (modal)
│  ├─ status.html         # startup/update status page (follows Harness theme)
│  ├─ notice.html         # persistent update badge
│  └─ home-migrate.js     # data-dir detection & migration (pure Node, unit-testable)
├─ scripts/               # build & test scripts
│  ├─ make-icons.mjs      # official favicon → icons at all sizes
│  ├─ bundle-node.mjs     # portable Node download/unpack
│  ├─ fix-unpacked.mjs    # rename + generate zip
│  ├─ after-pack.js       # electron-builder hook: ship the bundled Node in full
│  └─ smoke-close.ps1、smoke-modal.ps1   # Windows E2E smoke tests
├─ resources/icons/       # official favicon sources (svg/ico)
├─ electron-builder.yml   # packaging config (win/mac/linux)
└─ dist/                  # build output (gitignored)
```

## 🧪 Testing

```sh
npm start                                   # run the app
# Windows E2E (real WM_CLOSE validating close/tray/modal behavior):
powershell -File scripts/smoke-close.ps1 -Mode quit   # "quit directly" mode
powershell -File scripts/smoke-close.ps1 -Mode tray   # "hide to tray" mode
powershell -File scripts/smoke-modal.ps1              # modal settings window
```

## ❓ FAQ

- **First launch is slow / the status page shows "Downloading and installing…"**: the DeepSeek Harness engine is being installed automatically; this only happens once.
- **`npm run dist` fails on Windows with `mksquashfs ENOENT`**: AppImage can only be built on Linux/macOS (or Docker/CI) — see Packaging → Platform limits.
- **Sessions disappear after switching the data directory**: when switching, you're asked whether to move existing data; choosing "switch only" keeps the data in place.
- **Want config/sessions to live entirely with the app directory**: switch the data directory to "app directory" in settings and confirm the migration; then backup/migrate/delete the whole package at once.
- **Relation to the official CLI**: this shell is only a launcher/wrapper — it runs the official `@deepseek-ai/dsh`; any Harness capability question should go to the [DeepSeek Harness docs](https://deepseek-harness.github.io/deepseek-harness/guide/quickstart).

## 📄 License

[MIT](LICENSE) · This is an independent open-source shell with no affiliation to the DeepSeek Harness team; DeepSeek Harness itself is [MIT](https://github.com/deepseek-ai/deepseek-harness).