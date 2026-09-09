"use strict";

/**
 * DSH GUI Shell — main process.
 *
 * Responsibilities:
 *  1. Ensure the DeepSeek Harness engine (@deepseek-ai/dsh) is the LATEST
 *     version: launch-time and periodic update checks (fixed 30-minute
 *     interval, not user-configurable), install into an app-owned directory
 *     per update policy, notify the user. The engine update settings (policy /
 *     channel / check enable) live in the Harness settings page, exposed to
 *     the embedded web UI through the dsh-gui IPC bridge.
 *  2. Settings window: data directory / close-window / auto-restore
 *     preferences, persisted in <userData>/settings.json. Quick settings also
 *     live in the app menu.
 *  3. Spawn `dsh web --no-open --port 0`, parse the authenticated loopback
 *     URL from stdout, and load it in an embedded BrowserWindow (no system
 *     browser is ever opened).
 *  4. Fresh per-launch session: in-memory (non-persist) session partition;
 *     every launch starts a brand-new dsh child process, killed (tree
 *     included) on quit. Settings / sessions / workspace records of the
 *     harness live under DSH_HOME, which defaults to the app's data dir.
 *  5. System tray: open window / settings / quit. Window close either hides
 *     to tray or quits, per the closeAction setting.
 *  6. Persistent update notice: frameless corner badge dismissed by the user.
 *
 * Node resolution order: bundled portable node (resources/node) ->
 * $DSH_SHELL_NODE -> Node on PATH. npm installs use a node that ships npm
 * (bundled node usually has one; otherwise the host Node, since npm is
 * ABI-safe pure JS).
 */

const { app, BrowserWindow, Menu, Tray, nativeImage, nativeTheme, dialog, screen, ipcMain, shell } = require("electron");
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const semver = require("semver");
const YAML = require("yaml");
const { defaultDshHome, hasHomeData, moveHomeData } = require("./home-migrate");
const { ensureEnginePatches } = require("./engine-patch");
const {
  CATALOG: PLUGIN_CATALOG,
  CATALOG_IDS: pluginCatalogIds,
  catalogStatus: pluginCatalogStatus,
  catalogEngineCompat: pluginEngineCompat,
  installedBundles: readInstalledProfileBundles,
  readProfilePnpmManager: readProfilePnpmManagerFn,
  syncEnabledPlugins,
  ensurePnpm: ensurePluginPnpm,
  removePlugin: removeEnginePlugin,
} = require("./plugin-manager");

const DSH_PACKAGE = "@deepseek-ai/dsh";
// 完整 packument（而非 dist-tag latest）：GitHub 的 v0.1.3-alpha.2 只挂在 npm 的
// `alpha` 标签上；读全量版本后由 fetchLatestVersion 取最高 semver（含预发布）。
// Overridable for regions where registry.npmjs.org is slow/unreachable.
const REGISTRY_LATEST_URL =
  process.env.DSH_SHELL_REGISTRY_URL || `https://registry.npmjs.org/${DSH_PACKAGE}`;

const UPDATE_POLICIES = {
  auto: "静默更新（每次使用最新版）",
  ask: "询问后再更新（默认）",
  notify: "仅提示，不自动更新",
};

/** 版本通道：决定“最新版本”怎么选（见 fetchLatestVersion）。 */
const UPDATE_CHANNELS = {
  all: "最新版（含 alpha/beta/rc 预发布）",
  rc: "跳过 alpha（取 rc/正式版最高）",
  npm: "跟随 npm latest 标签",
};

/** DSH GUI 应用自身的更新来源（GitHub Releases，仅检测+打开下载页）。 */
const GUI_REPO_API = "https://api.github.com/repos/itchenshi/DeepSeekHarnessGUI/releases/latest";
const GUI_RELEASES_URL = "https://github.com/itchenshi/DeepSeekHarnessGUI/releases/latest";

/** 引擎检查更新的固定频率：30 分钟（不再可设置）。 */
const ENGINE_CHECK_INTERVAL_MS = 30 * 60 * 1000;

const DSH_HOME_MODES = {
  app: "应用目录（随应用携带）",
  system: "跟随系统 ~/.dsh（默认）",
};

const CLOSE_ACTIONS = {
  tray: "隐藏到托盘",
  quit: "直接退出",
};

/**
 * UI 语言设置：跟随系统 / 中文 / English。
 * 缺省 "system"：以 Electron 的系统语言解析为 zh|en；同时把结果同步到引擎的
 * <DSH_HOME>/settings.yaml 的 locale.preference（引擎热发布该文件，内置页面跟随）。
 */
const UI_LOCALES = { system: "跟随系统", zh: "中文", en: "English" };

/** 各界面文案（zh / en）。key 全部集中在此，调用处经 L() 取当前语言。 */
const UI_STRINGS = {
  zh: {
    // tray / menu
    "tray.open": "打开窗口",
    "tray.guiUpdate": "检查 DSH GUI 更新…",
    "tray.settings": "设置",
    "tray.quit": "退出",
    "menu.settings": "设置",
    "menu.openSettings": "打开设置窗口…",
    "menu.dataDir": "数据目录",
    "menu.quit": "退出",
    "menu.home.app": "应用目录（随应用携带）",
    "menu.home.system": "跟随系统 ~/.dsh（默认）",
    // settings window
    "settings.title": "设置",
    "settings.autoSave": "修改后自动保存",
    "settings.language": "语言",
    "settings.language.hint": "界面语言：设置窗口 / 托盘菜单 / 内嵌 Harness 界面都会切换",
    "settings.dataDir": "数据目录",
    "settings.home.system": "跟随系统 ~/.dsh（默认）",
    "settings.home.app": "应用目录（设置 / 会话 / 工作区记录随应用携带）",
    "settings.home.moveHint": "切换时若源目录有数据会询问是否移动",
    "settings.close": "关闭窗口",
    "settings.close.tray": "隐藏到托盘（默认，从托盘恢复）",
    "settings.close.quit": "直接退出（关闭窗口即退出，托盘一并移除）",
    "settings.session": "会话",
    "settings.autoRestore": "启动后自动回到最近一次对话（关闭后每次启动从空白/新会话开始）",
    "settings.autoRestore.hint": "记录你最后打开/使用的会话，重启 DeepSeek Harness 后自动切回",
    "settings.saved": "已保存",
    "settings.titleBar": "设置 — DSH GUI",
    // status page
    "status.checking": "正在检查版本…",
    // update flows
    "update.check": "正在检查 DeepSeek Harness 版本…",
    "update.cantCheck": "无法检查更新",
    "update.cantReach": "无法连接更新服务器",
    "update.currentV": "当前版本 v{0}。请检查网络后重试。",
    "update.notInstalled": "尚未安装引擎。",
    "update.upToDate.title": "已是最新版本",
    "update.upToDate.msg": "DeepSeek Harness 已是最新版本 v{0}",
    "update.found.title": "发现新版本",
    "update.found.msg": "可更新到 DeepSeek Harness v{0}",
    "update.found.detail": "当前版本：v{0}。\n是否立即下载更新，并在完成后重启 DSH GUI 以使用新版本？",
    "update.notInstalled.detail": "引擎尚未安装。是否立即下载最新版本并安装？",
    "update.nowRestart": "立即更新并重启",
    "update.later": "暂不更新",
    "update.installing": "正在更新到 v{0}…",
    "update.installProgress": "下载并安装 DeepSeek Harness",
    "update.done.title": "更新完成",
    "update.done.msg": "已更新到 DeepSeek Harness v{0}",
    "update.done.detail": "重启 DSH GUI 后即使用新版本。现在重启吗？",
    "update.restartNow": "立即重启",
    "update.restartLater": "稍后重启",
    "update.failed.title": "更新失败",
    "update.failed.msg": "更新 DeepSeek Harness 失败",
    "update.failed.willUseCurrent": "将使用当前版本 v{0} 启动。",
    "update.gui.title": "发现新版本",
    "update.gui.msg": "DSH GUI 可更新到 v{0}",
    "update.gui.detail": "当前版本：v{0}。\n是否打开下载页面（GitHub Releases）？",
    "update.gui.open": "打开下载页",
    "update.gui.cancel": "取消",
    "update.gui.cant.title": "无法检查更新",
    "update.gui.cant.msg": "无法连接 GitHub 获取 DSH GUI 版本信息",
    "update.gui.upToDate": "DSH GUI 已是最新版本 v{0}",
    "update.notice.found": "发现新版本 v{0}",
    "update.notice.nextLaunch": "将于下次启动时更新",
    "update.notice.updated": "已更新到 v{0}",
    "update.notice.thisLaunch": "本次启动已使用最新版本",
    "update.notice.detailAuto": "可在设置中改为自动更新",
    "update.status.upToDate": "版本已是最新 v{0}",
    "update.status.ready": "已就绪 v{0}",
    "update.status.skipped": "跳过更新，使用 v{0}",
    "update.status.found": "发现新版本 v{0}（未自动更新）",
    "update.status.updated": "已更新到 v{0}",
    "update.status.failed": "更新失败，使用 v{0} 启动",
    "update.status.offline": "离线模式：使用 v{0}",
    "update.status.first": "首次运行：正在安装 DeepSeek Harness…",
    "update.firstInstall": "首次安装",
    "update.reinstallRuntime": "运行时已变更，重新安装",
    "update.reinstall": "重新安装",
    "update.runtimeChanged": "运行时已变更",
    "update.newVersion": "发现新版本 v{0}（当前 v{1}）",
    "update.bootQuestion.title": "发现新版本",
    "update.bootQuestion.msg": "发现 DeepSeek Harness 新版本 v{0}",
    "update.bootQuestion.detail": "当前版本 v{0}。是否现在更新？",
    "update.bootNow": "立即更新",
    "update.bootUseCurrent": "用当前版本启动",
    "update.autoUpdateFailed": "自动更新到 v{0} 失败",
    "update.checksOff": "（更新检查已关闭）",
    "update.starting": "正在启动 DeepSeek Harness…",
    "update.firstInit": "首次启动需要初始化本地配置",
    "update.loadingUi": "正在加载界面…",
    "update.startFailedExit": "进程退出码 {0} {1}",
    // 第三方插件：启动失败自动剔除
    "plugin.excluded.title": "插件导致启动失败，已自动剔除",
    "plugin.excluded.msg": "刚自动安装的插件导致 dsh 无法启动，已移除并在设置中取消勾选：{0}。下次启动将不再自动安装。",
    // 引擎意外退出 / GUI 托管重启
    "engine.autoRestartGaveUp": "引擎多次意外退出（已尝试 {0} 次自动重启），请检查日志或重启 DSH GUI",
    "engine.crash.title": "引擎意外退出",
    "engine.crash.msg": "dsh 多次意外退出（退出码 {0}），已停止自动重启。可在设置窗口点「重启引擎」手动重试。",
    // 启动失败诊断
    "diag.title": "DeepSeek Harness 启动失败",
    "diag.savedLog": "启动错误日志已保存：\n{0}",
    "diag.plugin.title": "疑似第三方插件导致启动失败",
    "diag.plugin.msg": "检测到以下插件可能是启动失败的原因：\n{0}\n\n是否禁用这些插件并重新启动？",
    "diag.plugin.disable": "禁用并重启",
    "diag.plugin.keep": "暂不禁用，查看日志",
    "diag.notPlugin.title": "DeepSeek Harness 启动失败",
    "diag.notPlugin.msg": "启动失败看起来不是第三方插件导致的。\n\n最后输出：\n{0}",
    "diag.openLogs": "打开日志目录",
    // home switch
    "home.switchTitle": "切换数据目录",
    "home.hasDataMsg": "源数据目录（{0}）包含数据",
    "home.hasDataDetail": "是否将数据移动到目标目录（{0}）？选择“仅切换”则数据保留在原位置。",
    "home.moveAndSwitch": "移动并切换",
    "home.switchOnly": "仅切换，不移动",
    "home.switching": "正在移动数据目录…",
    "home.switched": "数据目录已切换",
    "home.restarting": "正在重新启动 DeepSeek Harness…",
    "home.partial.title": "部分数据未移动",
    "home.partial.msg": "已移动 {0} 项，{1} 项未移动",
    "home.moved.title": "数据已移动",
    "home.moved.msg": "已将 {0} 项数据移动到 {1}",
    "home.modeLabel": "数据目录",
    // dialogs & misc
    "common.ok": "知道了",
    "common.okShort": "确定",
    "common.continue": "继续",
    "common.engine": "引擎",
    "common.engineShort": "Engine",
    "engine.installFailed": "引擎安装失败",
    "engine.startFailed": "dsh 启动失败",
    "common.startFailed": "启动失败",
    "startFailed": "无法启动 DeepSeek Harness",
    "engine.notFound": "引擎安装目录缺失或不可用：{0}",
  },
  en: {
    // tray / menu
    "tray.open": "Open Window",
    "tray.guiUpdate": "Check for DSH GUI Updates…",
    "tray.settings": "Settings",
    "tray.quit": "Quit",
    "menu.settings": "Settings",
    "menu.openSettings": "Open Settings Window…",
    "menu.dataDir": "Data Folder",
    "menu.quit": "Quit",
    "menu.home.app": "App folder (travels with the app)",
    "menu.home.system": "Follow system ~/.dsh (default)",
    // settings window
    "settings.title": "Settings",
    "settings.autoSave": "Changes are saved automatically",
    "settings.language": "Language",
    "settings.language.hint": "Applies to the settings window, tray & menus, in-page DSH GUI features, and the embedded Harness UI",
    "settings.dataDir": "Data Folder",
    "settings.home.system": "Follow system ~/.dsh (default)",
    "settings.home.app": "App folder (settings / sessions / workspace records travel with the app)",
    "settings.home.moveHint": "If the source folder holds data you will be asked whether to move it",
    "settings.close": "Close Window",
    "settings.close.tray": "Hide to tray (default; restore from tray)",
    "settings.close.quit": "Quit (closing the window quits and removes the tray)",
    "settings.session": "Session",
    "settings.autoRestore": "Automatically reopen the last conversation on launch (off = always start blank/new)",
    "settings.autoRestore.hint": "Remembers the conversation you last opened so it is reopened after restarting DeepSeek Harness",
    "settings.saved": "Saved",
    "settings.titleBar": "Settings — DSH GUI",
    // status page
    "status.checking": "Checking for updates…",
    // update flows
    "update.check": "Checking DeepSeek Harness version…",
    "update.cantCheck": "Cannot Check for Updates",
    "update.cantReach": "Cannot reach the update server",
    "update.currentV": "Installed: v{0}. Check your network and try again.",
    "update.notInstalled": "The engine is not installed yet.",
    "update.upToDate.title": "Already Up to Date",
    "update.upToDate.msg": "DeepSeek Harness is already up to date (v{0})",
    "update.found.title": "Update Available",
    "update.found.msg": "DeepSeek Harness v{0} is available",
    "update.found.detail": "Installed: v{0}.\nDownload and update now, then restart DSH GUI to use it?",
    "update.notInstalled.detail": "The engine is not installed yet. Download and install the latest version now?",
    "update.nowRestart": "Update & Restart",
    "update.later": "Not Now",
    "update.installing": "Updating to v{0}…",
    "update.installProgress": "Downloading and installing DeepSeek Harness",
    "update.done.title": "Update Complete",
    "update.done.msg": "Updated to DeepSeek Harness v{0}",
    "update.done.detail": "DSH GUI will use the new version after restart. Restart now?",
    "update.restartNow": "Restart Now",
    "update.restartLater": "Later",
    "update.failed.title": "Update Failed",
    "update.failed.msg": "Failed to update DeepSeek Harness",
    "update.failed.willUseCurrent": "DSH GUI will start with the current version v{0}.",
    "update.gui.title": "Update Available",
    "update.gui.msg": "DSH GUI v{0} is available",
    "update.gui.detail": "Installed: v{0}.\nOpen the download page (GitHub Releases)?",
    "update.gui.open": "Open Download Page",
    "update.gui.cancel": "Cancel",
    "update.gui.cant.title": "Cannot Check for Updates",
    "update.gui.cant.msg": "Cannot reach GitHub to check the DSH GUI version",
    "update.gui.upToDate": "DSH GUI is already up to date (v{0})",
    "update.notice.found": "New version v{0} available",
    "update.notice.nextLaunch": "Will update on next launch",
    "update.notice.updated": "Updated to v{0}",
    "update.notice.thisLaunch": "This launch already uses the latest version",
    "update.notice.detailAuto": "You can switch to automatic updates in Settings",
    "update.status.upToDate": "Up to date (v{0})",
    "update.status.ready": "Ready (v{0})",
    "update.status.skipped": "Update skipped, using v{0}",
    "update.status.found": "New version v{0} available (not installed automatically)",
    "update.status.updated": "Updated to v{0}",
    "update.status.failed": "Update failed, starting with v{0}",
    "update.status.offline": "Offline mode: using v{0}",
    "update.status.first": "First run: installing DeepSeek Harness…",
    "update.firstInstall": "First-time install",
    "update.reinstallRuntime": "Runtime changed; reinstalling",
    "update.reinstall": "Reinstall",
    "update.runtimeChanged": "Runtime changed",
    "update.newVersion": "New version v{0} available (installed: v{1})",
    "update.bootQuestion.title": "Update Available",
    "update.bootQuestion.msg": "A new DeepSeek Harness version v{0} is available",
    "update.bootQuestion.detail": "Installed: v{0}. Update now?",
    "update.bootNow": "Update Now",
    "update.bootUseCurrent": "Start with Current Version",
    "update.autoUpdateFailed": "Automatic update to v{0} failed",
    "update.checksOff": "(update checks are off)",
    "update.starting": "Starting DeepSeek Harness…",
    "update.firstInit": "First launch needs a one-time configuration",
    "update.loadingUi": "Loading interface…",
    "update.startFailedExit": "Process exit code {0} {1}",
    // third-party plugin start-failure exclusion
    "plugin.excluded.title": "Plugin broke startup — auto-excluded",
    "plugin.excluded.msg": "A plugin auto-installed this launch prevented dsh from starting. It was removed and unchecked in settings: {0}. It will not be auto-installed again.",
    // engine unexpected exit / GUI-managed restart
    "engine.autoRestartGaveUp": "Engine exited unexpectedly several times (auto-restarted {0}×) — check the logs or restart DSH GUI",
    "engine.crash.title": "Engine exited unexpectedly",
    "engine.crash.msg": "dsh exited unexpectedly (code {0}); auto-restart was stopped. Use “Restart Engine” in the settings window to retry.",
    // startup-failure diagnosis
    "diag.title": "DeepSeek Harness failed to start",
    "diag.savedLog": "Startup error log saved:\n{0}",
    "diag.plugin.title": "A third-party plugin may have broken startup",
    "diag.plugin.msg": "These plugins look like the likely cause of the startup failure:\n{0}\n\nDisable them and restart?",
    "diag.plugin.disable": "Disable & Restart",
    "diag.plugin.keep": "Keep for now, view log",
    "diag.notPlugin.title": "DeepSeek Harness failed to start",
    "diag.notPlugin.msg": "The failure does not look plugin-related.\n\nLast output:\n{0}",
    "diag.openLogs": "Open Logs Folder",
    // home switch
    "home.switchTitle": "Switch Data Folder",
    "home.hasDataMsg": "The source data folder ({0}) contains data",
    "home.hasDataDetail": "Move the data to the destination folder ({0})? Choose “Switch only” to keep the data where it is.",
    "home.moveAndSwitch": "Move & Switch",
    "home.switchOnly": "Switch Only",
    "home.switching": "Moving data folder…",
    "home.switched": "Data folder switched",
    "home.restarting": "Restarting DeepSeek Harness…",
    "home.partial.title": "Some Data Was Not Moved",
    "home.partial.msg": "{0} items moved, {1} items were not moved",
    "home.moved.title": "Data Moved",
    "home.moved.msg": "Moved {0} items to {1}",
    "home.modeLabel": "Data Folder",
    // dialogs & misc
    "common.ok": "OK",
    "common.okShort": "OK",
    "common.continue": "Continue",
    "common.engine": "Engine",
    "common.engineShort": "Engine",
    "engine.installFailed": "Engine Install Failed",
    "engine.startFailed": "Failed to Start dsh",
    "common.startFailed": "Startup Failed",
    "startFailed": "DeepSeek Harness could not be started",
    "engine.notFound": "Engine directory is missing or unusable: {0}",
  },
};

/** 格式化 {0} {1} … 占位符。 */
function fmt(template, ...args) {
  if (!template) return template;
  let out = template;
  args.forEach((value, i) => {
    out = out.split(`{${i}}`).join(String(value ?? ""));
  });
  return out;
}

// Test hook: redirect userData (engine dir / settings) for isolated smoke runs
// of packaged builds. Must run before anything reads app paths.
if (process.env.DSH_SHELL_USERDATA) {
  app.setPath("userData", process.env.DSH_SHELL_USERDATA);
}

const DEFAULT_SETTINGS = {
  updatePolicy: "ask", // 引擎更新策略（auto/ask/notify）
  updateChannel: "npm", // 引擎版本通道（默认=跟随 npm latest 标签）
  dshHomeMode: "system", // 数据目录默认跟随系统 ~/.dsh
  updateCheckEnabled: true, // 引擎更新检查开关
  closeAction: "tray", // 关闭窗口默认隐藏到托盘
  autoRestoreLastSession: true, // 启动后自动回到最近一次对话
  // 启动时自动安装/挂载的第三方插件（CATALOG id 列表；默认关闭=不自动装任何插件）。
  autoPlugins: [],
  locale: "system", // UI 语言：system=跟随系统 / zh=中文 / en=English
};

let ENGINE_DIR = null;
let NPM_CACHE_DIR = null;
let win = null;
let settingsWin = null;
let tray = null;
let hasTray = false;
let dshChild = null;
let uiSettled = false;
let quitting = false;
let dshHome = null;
let settings = { ...DEFAULT_SETTINGS };
let settingsPath = null;
let updateCheckTimer = null;
let checkingInProgress = false;
let engineStarted = false;
let lastEngineUrl = null;
// 本次启动刚自动安装的插件 id（用于“引擎启动失败 → 剔除”兜底）。
let pluginsInstalledThisLaunch = [];
let pluginFailureRecoveryDone = false;
let pluginReadyWatchdog = null;
// 启动失败诊断：本次启动只弹一次（无论是否自动剔除过）。
let startupDiagnosisDone = false;
// “重启引擎”请求/进行中的标记（页面或设置窗口触发 → 主进程杀掉并重拉 dsh）。
let engineRestartInFlight = false;
// 非退出场景下引擎意外退出 → 自动重拉一次（dsh 页面自己没法重启 GUI 的 dsh）。
let engineReady = false;
// 有意停止引擎（切换数据目录 / 更新流程等）时置位，避免被当成“意外退出”自动重拉。
let intentionalEngineStop = false;
// 就绪后连续意外退出的计数（>3 停止自动重拉并提示）。
let unexpectedEngineExits = 0;
// “启动后自动回到最近一次对话”：轮询 __dshOpenLast 就绪的计时器（窗口级一个即可，
// 页面每导航/重载一次即重置，避免多个页面周期叠加轮询）。
let openLastPollTimer = null;
let openLastPollTries = 0;
let openLastPollClosed = null; // 绑定到 win 'closed' 的清理函数

/** Test/CI hook: quit N ms after the web UI finished loading. */
const autoquitMs = Number(process.env.DSH_SHELL_AUTOQUIT_MS) || 0;

function scheduleAutoQuit() {
  if (autoquitMs > 0) {
    log(`auto-quit scheduled in ${autoquitMs}ms`);
    setTimeout(() => app.quit(), autoquitMs);
  }
}

// ---------------------------------------------------------------------------
// logging helpers
// ---------------------------------------------------------------------------

function log(...args) {
  console.log("[shell]", ...args);
}

function err(...args) {
  console.error("[shell]", ...args);
}

// ---------------------------------------------------------------------------
// paths
// ---------------------------------------------------------------------------

function userDataDir() {
  return app.getPath("userData");
}

function engineDshVersionPath() {
  return path.join(ENGINE_DIR, "node_modules", DSH_PACKAGE, "package.json");
}

/** 当前“正在运行/将运行”的引擎版本（首次安装前可能为 null）。 */
let engineVersion = null;

function installedVersionNow() {
  try {
    return JSON.parse(fs.readFileSync(engineDshVersionPath(), "utf8")).version || null;
  } catch {
    return null;
  }
}

/** 主窗口标题显示 DSH GUI 应用版本；托盘提示同时给出 GUI 与引擎版本。 */
function applyEngineVersionChrome() {
  const appV = app.getVersion() || "0.0.0";
  const engV = engineVersion ?? installedVersionNow();
  const label = `DSH GUI v${appV}`;
  if (win && !win.isDestroyed()) win.setTitle(label);
  if (tray && !tray.isDestroyed()) {
    const engineLabel = resolveUiLang() === "zh" ? "引擎" : "engine";
    tray.setToolTip(engV ? `DSH GUI v${appV} · ${engineLabel} v${engV}` : `DSH GUI v${appV}`);
  }
  return engV;
}

function engineDshBinPath() {
  return path.join(ENGINE_DIR, "node_modules", DSH_PACKAGE, "lib", "bin.js");
}

function iconPath(name) {
  // Icons live next to this file (src), packaged inside app.asar as well.
  return path.join(__dirname, name);
}

// ---------------------------------------------------------------------------
// settings
// ---------------------------------------------------------------------------

async function loadSettings() {
  settingsPath = path.join(userDataDir(), "settings.json");
  try {
    const raw = (await fsp.readFile(settingsPath, "utf8")).replace(/^\uFEFF/, "");
    const parsed = JSON.parse(raw);
    if (UPDATE_POLICIES[parsed.updatePolicy]) settings.updatePolicy = parsed.updatePolicy;
    if (UPDATE_CHANNELS[parsed.updateChannel]) settings.updateChannel = parsed.updateChannel;
    if (DSH_HOME_MODES[parsed.dshHomeMode]) settings.dshHomeMode = parsed.dshHomeMode;
    if (typeof parsed.updateCheckEnabled === "boolean") settings.updateCheckEnabled = parsed.updateCheckEnabled;
    if (parsed.closeAction === "tray" || parsed.closeAction === "quit") settings.closeAction = parsed.closeAction;
    if (typeof parsed.autoRestoreLastSession === "boolean") settings.autoRestoreLastSession = parsed.autoRestoreLastSession;
    if (Array.isArray(parsed.autoPlugins)) {
      settings.autoPlugins = parsed.autoPlugins.filter((id) => typeof id === "string" && pluginCatalogIds.has(id));
    }
    if (UI_LOCALES[parsed.locale]) settings.locale = parsed.locale;
    if (typeof parsed.engineNode === "string") settings.engineNode = parsed.engineNode;
    if (typeof parsed.lastNotifiedVersion === "string") settings.lastNotifiedVersion = parsed.lastNotifiedVersion;
    if (typeof parsed.lastCheckedAt === "number") settings.lastCheckedAt = parsed.lastCheckedAt;
  } catch {
    /* first run: keep defaults */
  }
  // Resolve the harness home per mode. DSH_SHELL_HOME (test) always wins.
  const explicitTestHome = process.env.DSH_SHELL_HOME;
  dshHome =
    (explicitTestHome && explicitTestHome.trim() !== "" && explicitTestHome) ||
    (settings.dshHomeMode === "system"
      ? null // null -> let dsh fall back to ~/.dsh
      : path.join(userDataDir(), "dsh-home"));
  log("settings:", JSON.stringify(settings), "| dshHome:", dshHome ?? "~/.dsh");
}

async function saveSettings(patch) {
  settings = { ...settings, ...patch };
  if (!settingsPath) settingsPath = path.join(userDataDir(), "settings.json");
  await fsp.mkdir(path.dirname(settingsPath), { recursive: true });
  await fsp.writeFile(settingsPath, JSON.stringify(settings, null, 2));
  broadcastSettings();
}

async function applySettingsPatch(patch) {
  const next = {};
  if (typeof patch.updatePolicy === "string" && UPDATE_POLICIES[patch.updatePolicy]) next.updatePolicy = patch.updatePolicy;
  if (typeof patch.updateChannel === "string" && UPDATE_CHANNELS[patch.updateChannel]) next.updateChannel = patch.updateChannel;
  if (typeof patch.updateCheckEnabled === "boolean") next.updateCheckEnabled = patch.updateCheckEnabled;
  if (patch.closeAction === "tray" || patch.closeAction === "quit") next.closeAction = patch.closeAction;
  if (typeof patch.autoRestoreLastSession === "boolean") next.autoRestoreLastSession = patch.autoRestoreLastSession;
  if (Array.isArray(patch.autoPlugins)) {
    next.autoPlugins = patch.autoPlugins.filter((id) => typeof id === "string" && pluginCatalogIds.has(id));
  }
  if (UI_LOCALES[patch.locale]) next.locale = patch.locale;
  if (Object.keys(next).length > 0) {
    await saveSettings(next);
    buildMenu();
    scheduleUpdateChecks();
    if (Object.prototype.hasOwnProperty.call(next, "locale")) {
      refreshTrayMenu();
      applyEngineVersionChrome();
      if (settingsWin && !settingsWin.isDestroyed()) {
        settingsWin.setTitle(L("settings.titleBar"));
      }
      await syncEngineUILocale().catch((error) => err("syncEngineUILocale failed:", error.message));
      if (win && !win.isDestroyed() && !win.webContents.isLoading()) {
        // 页面内文案跟随引擎 locale 服务；引擎设置文件热发布后由引擎自行切换。
        log("ui locale ->", resolveUiLang());
      }
    }
  }
  // Data-directory switches go through the guarded flow (data check + move).
  if (typeof patch.dshHomeMode === "string" && DSH_HOME_MODES[patch.dshHomeMode]) {
    await switchHomeMode(patch.dshHomeMode).catch((error) => err("switchHomeMode failed:", error));
  }
  return settings;
}

// ---------------------------------------------------------------------------
// harness home switching (with data check + optional move)
// ---------------------------------------------------------------------------

function effectiveHomePath() {
  // The active harness home the engine currently uses.
  return dshHome ?? defaultDshHome();
}

async function killEngineForSwitch() {
  if (!dshChild) return false;
  intentionalEngineStop = true;
  await new Promise((resolve) => killProcessTree(dshChild, resolve));
  dshChild = null;
  engineStarted = false;
  lastEngineUrl = null;
  log("engine stopped for home switch");
  return true;
}

async function restartEngineAfterSwitch(nodeExec) {
  setStatus(L("home.switched"), L("home.restarting"));
  await startEngine(nodeExec);
  // 新引擎就绪后清除“有意停止”标记（startEngine 内 onUrl 复位 isIntentional 也可以）。
  setTimeout(() => {
    intentionalEngineStop = false;
  }, 5000);
}

/**
 * Switch the harness data directory. If the current home holds data, ask the
 * user whether to move it; on consent (and safe, engine stopped) the data is
 * moved, then the engine is restarted against the new home.
 */
async function switchHomeMode(mode) {
  if (mode === settings.dshHomeMode) return;
  const srcPath = effectiveHomePath();
  const dstPath = mode === "system" ? defaultDshHome() : path.join(userDataDir(), "dsh-home");
  const parent = win ?? settingsWin;
  let doMove = false;

  const hasData = await hasHomeData(srcPath);
  if (hasData && path.resolve(srcPath) !== path.resolve(dstPath)) {
    const { response } = await dialog
      .showMessageBox(parent, {
        type: "question",
        title: L("home.switchTitle"),
        message: L("home.hasDataMsg", srcPath),
        detail: L("home.hasDataDetail", dstPath),
        buttons: [L("home.moveAndSwitch"), L("home.switchOnly")],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
      })
      .catch(() => ({ response: 1 }));
    doMove = response === 0;
  } else {
    log("home switch: source has no data (or same path), no move needed");
  }

  if (doMove) {
    await killEngineForSwitch(); // stop writers before moving files
    log("moving harness data:", srcPath, "->", dstPath);
    setStatus(L("home.switching"), "");
    const result = await moveHomeData(srcPath, dstPath);
    log("move result:", JSON.stringify(result));
    if (result.skipped.length > 0) {
      dialog
        .showMessageBox(parent, {
          type: "warning",
          title: L("home.partial.title"),
          message: L("home.partial.msg", result.moved, result.skipped.length),
          detail: result.skipped.join("\n"),
          buttons: [L("common.ok")],
        })
        .catch(() => {});
    } else {
      dialog
        .showMessageBox(parent, {
          type: "info",
          title: L("home.moved.title"),
          message: L("home.moved.msg", result.moved, dstPath),
          buttons: [L("common.ok")],
        })
        .catch(() => {});
    }
  } else if (hasData && path.resolve(srcPath) !== path.resolve(dstPath)) {
    log("home switch: user chose not to move data");
  }

  await saveSettings({ dshHomeMode: mode });
  // Re-resolve the effective home for the engine side.
  const testHome = process.env.DSH_SHELL_HOME;
  dshHome =
    mode === "system"
      ? null
      : testHome && testHome.trim() !== ""
        ? testHome
        : path.join(userDataDir(), "dsh-home");
  log("dshHome now:", dshHome ?? "~/.dsh");
  buildMenu();

  // If the engine was running against the old home (moved or not), restart it
  // so this session keeps working on the new home.
  if (doMove) {
    const nodeExec = resolveNodeExecutable();
    await restartEngineAfterSwitch(nodeExec);
  }
}

function broadcastSettings() {
  for (const target of [settingsWin]) {
    if (target && !target.isDestroyed()) {
      target.webContents.send("settings:changed", settingsPayload());
    }
  }
}

/** 设置窗口看到的数据：持久设置 + 界面语言 + 引擎版本信息 + 插件目录。 */
function settingsPayload() {
  const currentEngine = engineVersion ?? installedVersionNow();
  const compat = pluginEngineCompat(currentEngine);
  return {
    ...settings,
    uiLang: resolveUiLang(),
    installedEngine: currentEngine,
    checkIntervalMinutes: Math.round(ENGINE_CHECK_INTERVAL_MS / 60000),
    engineRunning: Boolean(engineStarted && dshChild),
    pluginCatalog: PLUGIN_CATALOG.map((entry) => ({
      id: entry.id,
      pkg: entry.pkg,
      zh: entry.zh,
      en: entry.en,
      zhDesc: entry.zhDesc,
      enDesc: entry.enDesc,
      url: entry.url,
      zhEngine: entry.zhEngine ?? null,
      enEngine: entry.enEngine ?? null,
      engineRange: entry.engineRange ?? null,
      engineOk: (compat[entry.id] && compat[entry.id].ok) ?? true,
    })),
    pluginStatus: pluginCatalogStatus(effectiveHomePath()),
  };
}

// ---------------------------------------------------------------------------
// node / npm resolution
// ---------------------------------------------------------------------------

/** Bundled portable Node shipped inside the app (resources/node). */
function bundledNodeExecutable() {
  const candidates =
    process.platform === "win32"
      ? [path.join(process.resourcesPath, "node", "node.exe")]
      : [path.join(process.resourcesPath, "node", "bin", "node")];
  return candidates.find((p) => fs.existsSync(p)) || null;
}

/**
 * Resolve the Node executable used to run the engine. Order:
 * bundled portable node -> $DSH_SHELL_NODE -> Node on PATH.
 */
function resolveNodeExecutable() {
  const bundled = bundledNodeExecutable();
  if (bundled) {
    log("using bundled node:", bundled);
    return bundled;
  }
  const explicit = process.env.DSH_SHELL_NODE;
  if (explicit && explicit.trim() !== "") {
    log("using DSH_SHELL_NODE:", explicit);
    return explicit.trim();
  }
  const probe = spawnSync("node", ["-p", "process.execPath"], { encoding: "utf8" });
  if (probe.status === 0 && probe.stdout.trim() !== "") return probe.stdout.trim();
  return process.platform === "win32" ? "node.exe" : "node";
}

function resolveNpmCli(nodeExec) {
  const installerDir = path.dirname(nodeExec);
  const prefixDir = path.dirname(installerDir);
  const candidates = [
    path.join(installerDir, "node_modules", "npm", "bin", "npm-cli.js"),
    path.join(prefixDir, "node_modules", "npm", "bin", "npm-cli.js"),
    path.join(prefixDir, "lib", "node_modules", "npm", "bin", "npm-cli.js"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  const probe = spawnSync(nodeExec, ["-e", "console.log(require.resolve('npm/bin/npm-cli.js'))"], { encoding: "utf8" });
  if (probe.status === 0 && probe.stdout.trim() !== "") return probe.stdout.trim();
  return null;
}

/**
 * A Node that carries npm, for installing the engine.
 */
function resolveNpmProvider() {
  const candidates = [];
  const explicit = process.env.DSH_SHELL_NODE;
  if (explicit && explicit.trim() !== "") candidates.push(explicit.trim());
  const bundled = bundledNodeExecutable();
  if (bundled) candidates.push(bundled);
  if (candidates.every((c) => resolveNpmCli(c) === null)) {
    // No explicit/bundled node carries npm -> use the host Node on PATH.
    const probe = spawnSync("node", ["-p", "process.execPath"], { encoding: "utf8" });
    if (probe.status === 0 && probe.stdout.trim() !== "") candidates.push(probe.stdout.trim());
  }
  for (const node of candidates) {
    const cli = resolveNpmCli(node);
    if (cli) return { node, cli };
  }
  throw new Error("cannot locate any Node that ships npm (npm-cli.js)");
}

function nodeVersionOf(nodeExec) {
  const probe = spawnSync(nodeExec, ["--version"], { encoding: "utf8" });
  return probe.status === 0 ? probe.stdout.trim() : null;
}

// ---------------------------------------------------------------------------
// bundled plugin staging root (space-free path required by pnpm install)
// ---------------------------------------------------------------------------

/**
 * 8.3 短路径：仅当路径含空格且系统能给出短路径时缩短，否则原样返回。
 * 引擎用 shell 转发参数给 pnpm（Node 26 起 shell:true 不再转义参数），
 * file: spec 里出现空格会被 cmd 拆词，所以含空格的路径必须先做短化。
 */
function shortPathIfSpaced(p) {
  if (!/\s/u.test(p)) return p;
  try {
    const probe = spawnSync(
      "cmd",
      ["/d", "/s", "/c", `for %I in ("${p}") do @echo %~sI`],
      { encoding: "utf8", windowsHide: true },
    );
    const short = probe.status === 0 ? String(probe.stdout ?? "").trim() : "";
    if (short && !/\s/u.test(short) && fs.existsSync(short)) return short;
  } catch {
    /* keep long path */
  }
  return p;
}

/**
 * 捆绑插件（随应用发布、源码在 app.asar/plugins 里的本地插件）安装前的
 * staging 根目录。必须是「稳定 + 无空格」的绝对路径：
 *  - 稳定：pnpm 把 `file:` spec 原样写进 profile 的 dependencies，之后该
 *    profile 里再跑 pnpm 仍要能解析到同一份拷贝；
 *  - 无空格：userData 通常是 "...\DSH GUI\..."（含空格），经引擎 shell 转发给
 *    pnpm 会被拆词。取 <home>\.dsh-gui\bundled-plugins，必要时 8.3 短化。
 */
function pluginBundledPluginsDir() {
  const dir = path.join(os.homedir(), ".dsh-gui", "bundled-plugins");
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (error) {
    err("plugin staging dir create failed:", error.message);
  }
  return shortPathIfSpaced(dir);
}

/**
 * 操作当前 profile 应使用的 pnpm spec：跟随「构建该 profile node_modules 的
 * pnpm 主版本」（marketplace 可能用 pnpm 12 建过；混用 pnpm 10 会
 * ERR_PNPM_UNEXPECTED_STORE），新 profile 回落 pnpm@10。
 */
function profilePnpmSpec() {
  return readProfilePnpmManagerFn(effectiveHomePath()) ?? "pnpm@10";
}

// ---------------------------------------------------------------------------
// version engine
// ---------------------------------------------------------------------------

async function fetchLatestVersion(timeoutMs = 8000) {
  // Test-only override so CI can exercise the update path deterministically.
  if (process.env.DSH_SHELL_TEST_LATEST) return process.env.DSH_SHELL_TEST_LATEST;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // 读全量 packument 并取“最高 semver（含预发布）”：GitHub 的 v0.1.3-alpha.2
    // 在 npm 上挂在 dist-tag `alpha`，而 `latest` 标签仍停留在旧版 —— 只读 /latest
    // 会漏掉新预发布版本。测试时可用 DSH_SHELL_REGISTRY_URL 指向完整 packument。
    const res = await fetch(REGISTRY_LATEST_URL, {
      signal: controller.signal,
      headers: { accept: "application/json" },
    });
    if (!res.ok) throw new Error(`registry responded ${res.status}`);
    const data = await res.json();
    const all = Object.keys(data.versions ?? {}).filter((v) => semver.valid(v));
    const channel = UPDATE_CHANNELS[settings?.updateChannel] ? settings.updateChannel : "all";

    // npm：跟随 dist-tag `latest`（发布方认可线）。
    if (channel === "npm") {
      const tag = data["dist-tags"] && data["dist-tags"].latest;
      if (tag && all.includes(tag)) return tag;
    }
    // rc：跳过 alpha，取 rc / 正式版最高。
    const list =
      channel === "rc"
        ? all.filter((v) => {
            const pre = semver.prerelease(v);
            return !pre || pre[0] !== "alpha";
          })
        : all; // all：最高合法版本（含 alpha/beta/rc 预发布）
    return list.sort((a, b) => (semver.lt(a, b) ? 1 : -1))[0] ?? null;
  } finally {
    clearTimeout(timer);
  }
}

async function readInstalledVersion() {
  try {
    const pkg = JSON.parse(await fsp.readFile(engineDshVersionPath(), "utf8"));
    return typeof pkg.version === "string" && pkg.version !== "" ? pkg.version : null;
  } catch {
    return null;
  }
}

/**
 * Install `@deepseek-ai/dsh` into ENGINE_DIR with a dedicated npm cache.
 * `version` may be null to install the latest (unversioned spec).
 */
function npmInstall(version, onProgress) {
  return new Promise((resolve, reject) => {
    let npm;
    try {
      npm = resolveNpmProvider();
    } catch (error) {
      reject(error);
      return;
    }
    const { node: nodeExec, cli: npmCli } = npm;
    const spec = version ? `${DSH_PACKAGE}@${version}` : DSH_PACKAGE;
    const args = [
      npmCli,
      "install",
      spec,
      "--prefix", ENGINE_DIR,
      "--no-audit", "--no-fund", "--no-save",
      "--loglevel", "error",
    ];
    log("npm", args.join(" "));
    const child = spawn(nodeExec, args, {
      env: {
        ...process.env,
        npm_config_cache: NPM_CACHE_DIR,
        npm_config_update_notifier: "false",
        npm_config_fund: "false",
        npm_config_audit: "false",
      },
      windowsHide: true,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let tail = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      tail = (tail + chunk).split(/\r?\n/u).slice(-6).join("\n");
      const line = chunk
        .split(/\r?\n/u)
        .filter((l) => l.trim() !== "")
        .pop();
      if (line) onProgress?.(line.trim());
    });
    child.on("error", (error) => reject(error));
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`npm install exited with ${code}\n${tail}`));
      }
    });
  });
}

// ---------------------------------------------------------------------------
// dsh child process
// ---------------------------------------------------------------------------

function spawnDsh(nodeExec, { onUrl, onExit, onError }) {
  const bin = engineDshBinPath();
  if (!fs.existsSync(bin)) {
    onError(new Error(`engine not found: ${bin}`));
    return null;
  }
  const env = {
    ...process.env,
    ...(dshHome ? { DSH_HOME: dshHome } : {}),
  };
  const child = spawn(
    nodeExec,
    [bin, "web", "--no-open", "--port", "0"],
    {
      cwd: os.homedir(), // default workspace root for dsh
      env,
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let buffer = "";
  const tail = [];
  const pushTail = (text) => {
    for (const line of String(text).split(/\r?\n/u)) {
      if (line.trim() === "") continue;
      tail.push(line);
      if (tail.length > 400) tail.shift();
    }
  };
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    process.stdout.write(chunk);
    pushTail(chunk);
    buffer += chunk;
    if (buffer.length > 64 * 1024) buffer = buffer.slice(-64 * 1024);
    const match = buffer.match(/^dsh web: (\S+)\s*$/m);
    if (match) onUrl(match[1]);
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    process.stderr.write(chunk);
    pushTail(chunk);
  });
  child.on("error", onError);
  child.on("exit", (code, signal) => onExit(code, signal));
  // 供启动失败诊断读取最近的引擎输出。
  child.__dshTail = () => tail.join("\n");
  return child;
}

function killProcessTree(child, done) {
  if (!child || child.pid === undefined) {
    done?.();
    return;
  }
  if (process.platform === "win32") {
    const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    });
    killer.on("close", () => done?.());
    killer.on("error", () => done?.());
  } else {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      /* already gone */
    }
    setTimeout(() => {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        /* already gone */
      }
      done?.();
    }, 2000);
  }
}

/**
 * GUI 托管的“重启引擎”：杀掉当前 dsh 子进程，再按既有流程重新拉起（重新加载
 * web profile → 新装/变更的插件在此生效）。与 app.relaunch 不同，不退出 DSH GUI，
 * 会话数据都在 $DSH_HOME 下，不受影响。
 */
function restartEngineNow(reason) {
  if (engineRestartInFlight) return { ok: false, reason: "already restarting" };
  if (!dshChild) return { ok: false, reason: "engine not running" };
  engineRestartInFlight = true;
  engineReady = false;
  intentionalEngineStop = true;
  log("restarting engine...", reason ?? "");
  const child = dshChild;
  dshChild = null;
  killProcessTree(child, () => {
    engineStarted = false;
    lastEngineUrl = null;
    const nodeExec = resolveNodeExecutable();
    startEngine(nodeExec)
      .catch((error) => {
        err("engine restart failed:", error);
        engineRestartInFlight = false;
        engineReady = false;
        intentionalEngineStop = false;
        fatalUi(error, L("engine.startFailed"));
      });
  });
  return { ok: true };
}

// ---------------------------------------------------------------------------
// window / status page
// ---------------------------------------------------------------------------

function setStatus(text, sub) {
  if (!win || win.isDestroyed()) return;
  const code = `(() => {
    const s = document.getElementById("status");
    if (s) s.textContent = ${JSON.stringify(text ?? "")};
    if (${JSON.stringify(sub ?? "")}) {
      const b = document.getElementById("sub");
      if (b) { b.textContent = ${JSON.stringify(sub ?? "")}; b.hidden = false; }
    }
  })()`;
  win.webContents.executeJavaScript(code).catch(() => {});
}

function fatalUi(error, title = L("common.startFailed")) {
  err(title, error);
  setStatus(title, String((error && error.message) || error));
  dialog
    .showMessageBox(win, {
      type: "error",
      title,
      message: `${title}：${L("startFailed")}`,
      detail: String((error && error.message) || error),
      buttons: [L("common.ok")],
    })
    .catch(() => {});
}

// ---------------------------------------------------------------------------
// 启动失败诊断：保存启动错误日志，判断是否由第三方插件引起，按结果提示并可选禁用。
// ---------------------------------------------------------------------------

/** <userData>/logs/ 下的启动失败日志文件。 */
function startupErrorLogPath(tag) {
  const dir = path.join(userDataDir(), "logs");
  const stamp = new Date()
    .toISOString()
    .replace(/[:T]/g, "-")
    .replace(/\.\d+Z$/, "");
  return path.join(dir, `dsh-start-${tag}-${stamp}.log`);
}

async function writeStartupErrorLog(file, { code, signal, tail }) {
  try {
    const lines = [
      `DSH GUI startup error log`,
      `time: ${new Date().toISOString()}`,
      `version: ${app.getVersion()}`,
      `engine: ${engineVersion ?? "unknown"}`,
      `exit: ${code ?? "?"} signal: ${signal ?? "none"}`,
      "",
      "---- engine output (tail) ----",
      String(tail ?? "").slice(-20000),
    ];
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, lines.join("\n"), "utf8");
    return file;
  } catch (error) {
    err("write startup log failed:", error.message);
    return null;
  }
}

/**
 * 从引擎输出里找“可能出问题的插件”：逐个对照 profile 里已装的非基础 bundle，
 * 只要包名出现在输出（报错/路径）里就列为可疑。返回 [{id?, pkg}]（目录外插件无 id）。
 */
function suspectPluginsFromTail(tail, extraBundlePkgs) {
  const hay = String(tail ?? "").toLowerCase();
  const found = [];
  for (const pkg of extraBundlePkgs) {
    if (hay.includes(String(pkg).toLowerCase())) {
      const entry = PLUGIN_CATALOG.find((c) => c.pkg === pkg);
      found.push(entry ? { id: entry.id, pkg: entry.pkg } : { id: undefined, pkg });
    }
  }
  if (found.length === 0) {
    // 兜底：输出提到 bundle 层加载失败（overlay / cordis.patch / profile bundle），
    // 且确实装过第三方插件 → 把所有非基础 bundle 都列为可疑。
    const bundleSignals = ["cordis.patch", "overlay", "profile bundle", "failed to read", "plugin"];
    if (bundleSignals.some((s) => hay.includes(s)) && extraBundlePkgs.length > 0) {
      for (const pkg of extraBundlePkgs) {
        if (!found.some((f) => f.pkg === pkg)) {
          const entry = PLUGIN_CATALOG.find((c) => c.pkg === pkg);
          found.push(entry ? { id: entry.id, pkg: entry.pkg } : { id: undefined, pkg });
        }
      }
    }
  }
  return found;
}

function suspectsLabel(list) {
  return list
    .map((s) => {
      const entry = PLUGIN_CATALOG.find((c) => c.pkg === s.pkg);
      if (!entry) return s.pkg;
      const zh = entry.zh;
      const label = resolveUiLang() === "en" ? entry.en ?? s.pkg : zh;
      return `${label}（${s.pkg}）`;
    })
    .join("\n");
}

/**
 * 引擎启动失败后的统一入口：保存错误日志 → 判定是否插件问题 →
 * 插件问题则询问“禁用并重启”，非插件问题则展示查到的原因。
 * @param {object} o { code, signal, error, tail }
 * @returns {Promise<void>}
 */
async function diagnoseStartFailure({ code, signal, error, tail }) {
  const logFile = await writeStartupErrorLog(startupErrorLogPath("fail"), { code, signal, tail });
  const parent = win && !win.isDestroyed() ? win : undefined;
  // 已装 bundle（含基础层），取“可疑”插件：基础层之外的都算第三方。
  const profileBundles = readInstalledProfileBundles(effectiveHomePath());
  const extraBundles = profileBundles.filter(
    (pkg) => pkg !== "@deepseek-ai/dsh-base" && pkg !== "@deepseek-ai/dsh-web-app",
  );
  const suspects = suspectPluginsFromTail(`${tail ?? ""}\n${error?.message ?? ""}`, extraBundles);

  const logHint = logFile ? `\n\n${L("diag.savedLog", logFile)}` : "";
  if (suspects.length > 0) {
    // 测试钩子：自动选择“禁用并重启”（用于无人工冒烟）。
    const autoDisable = process.env.DSH_SHELL_TEST_AUTODISABLE === "1";
    const { response } = autoDisable
      ? { response: 0 }
      : await dialog
          .showMessageBox(parent, {
            type: "warning",
            title: L("diag.plugin.title"),
            message: L("diag.plugin.msg", suspectsLabel(suspects)),
            detail: `${L("diag.savedLog", logFile ?? "?")}`,
            buttons: [L("diag.plugin.disable"), L("diag.plugin.keep")],
            defaultId: 0,
            cancelId: 1,
            noLink: true,
          })
          .catch(() => ({ response: 1 }));
    if (response === 0) {
      // 禁用并重启：移除可疑插件（profiles bundle + autoPlugins 勾选）后重拉引擎。
      try {
        const pnpmBinDir = await ensurePluginPnpm({
          installDir: path.join(userDataDir(), "pnpm-tools"),
          pnpmSpec: profilePnpmSpec(),
          nodeExec: resolveNodeExecutable(),
          log,
        });
        for (const suspect of suspects) {
          const res = await removeEnginePlugin({
            engineDir: ENGINE_DIR,
            dshHome: effectiveHomePath(),
            pnpmBinDir,
            pkg: suspect.pkg,
            nodeExec: resolveNodeExecutable(),
            log,
          });
          if (!res.ok) err("disable plugin failed:", suspect.pkg, res.output.slice(-200));
        }
      } catch (error) {
        err("disable plugin failed:", error);
      }
      await saveSettings({
        autoPlugins: (settings.autoPlugins ?? []).filter((id) => !suspects.some((s) => s.id === id)),
      }).catch((error) => err("persist plugin disable failed:", error.message));
      setStatus(L("diag.title"), L("diag.plugin.disable"));
      await startEngine(resolveNodeExecutable()).catch((error) => fatalUi(error, L("engine.startFailed")));
      return;
    }
    // 用户选择“保留”：给出日志路径，页面停留在失败信息。
    setStatus(L("engine.startFailed"), String(error?.message ?? code ?? ""));
    if (!autoDisable) {
      dialog
        .showMessageBox(parent, {
          type: "error",
          title: L("diag.plugin.title"),
          message: L("diag.plugin.msg", suspectsLabel(suspects)),
          detail: logHint,
          buttons: [L("common.ok")],
        })
        .catch(() => {});
    }
    return;
  }

  // 非插件问题：展示查到的最后输出/错误。
  const reason = String(error?.message ?? tail ?? "").trim().slice(0, 2000);
  setStatus(L("diag.title"), (reason || "?").slice(0, 200));
  dialog
    .showMessageBox(parent, {
      type: "error",
      title: L("diag.notPlugin.title"),
      message: L("diag.notPlugin.msg", reason || "?"),
      detail: logHint,
      buttons: [L("common.ok")],
    })
    .catch(() => {});
}

/**
 * 启动失败统一入口（防御性包装）：本次启动只诊断一次，避免 onExit/watchdog 重复弹窗。
 * 自动剔除（pluginFailureRecoveryDone）与诊断各自独立：即便本次已自动剔除并重试过，
 * 若仍失败，仍应弹窗让用户决定（手动禁用 or 查看原因）。
 */
async function handleStartupFailure({ code, signal, error, tail }) {
  if (startupDiagnosisDone) return;
  startupDiagnosisDone = true;
  clearTimeout(pluginReadyWatchdog);
  pluginReadyWatchdog = null;
  await diagnoseStartFailure({ code, signal, error, tail: tail ?? "" }).catch((e2) =>
    err("startup diagnosis failed:", e2.message),
  );
}

/** 已退出/挂起的引擎输出尾部（若子进程还在则取它缓存的输出）。 */
function engineOutputTail() {
  try {
    return dshChild && typeof dshChild.__dshTail === "function" ? dshChild.__dshTail() : "";
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------
// harness appearance (theme) adoption
// ---------------------------------------------------------------------------

let windowThemeDark = true;

function themeQuery() {
  return windowThemeDark ? "dark" : "light";
}

/** Read the harness appearance preference from <DSH_HOME>/settings.yaml. */
async function readHarnessTheme() {
  const home = dshHome ?? defaultDshHome();
  const file = path.join(home, "settings.yaml");
  try {
    const text = await fsp.readFile(file, "utf8");
    const doc = YAML.parse(text);
    const pref = doc && doc["ui-theme"] && doc["ui-theme"].preference;
    if (pref === "light" || pref === "dark" || pref === "system") return pref;
  } catch (error) {
    log("harness settings.yaml unreadable, using system theme:", error.message);
  }
  return "system";
}

function applyHarnessTheme(preference) {
  nativeTheme.themeSource = preference === "light" || preference === "dark" ? preference : "system";
  windowThemeDark =
    preference === "dark" ||
    (preference !== "light" && nativeTheme.shouldUseDarkColors);
  log("harness theme:", preference, "| window dark:", windowThemeDark);
}

// ---------------------------------------------------------------------------
// UI 语言（GUI 与引擎同步）
// ---------------------------------------------------------------------------

/** 当前生效语言：zh | en（跟随系统时按 Electron 系统语言解析）。 */
function resolveUiLang() {
  if (settings.locale === "zh" || settings.locale === "en") return settings.locale;
  let sys = "en";
  try {
    const loc = String(app.getLocale() ?? "").toLowerCase();
    if (loc.startsWith("zh")) sys = "zh";
  } catch {
    /* fall back to en */
  }
  return sys;
}

/** 当前语言下的文案。 */
function L(key, ...args) {
  const lang = resolveUiLang();
  const table = UI_STRINGS[lang] ?? UI_STRINGS.en;
  return fmt(table[key] ?? UI_STRINGS.en[key] ?? key, ...args);
}

/**
 * 把生效语言写入引擎设置文件 <DSH_HOME>/settings.yaml 的 locale.preference
 * （zh|en）。引擎的 dsh-settings-file 会 watch 该文件并热发布，内置 Harness UI
 * 立即切换语言；因此页面内文案一并跟随。system 模式写入解析后的结果，
 * 保持 GUI 与引擎一致。文件不存在或不可写时静默跳过（非致命）。
 */
async function syncEngineUILocale() {
  const home = effectiveHomePath();
  const file = path.join(home, "settings.yaml");
  const preference = resolveUiLang();
  await fsp.mkdir(home, { recursive: true }).catch(() => {});
  let doc;
  try {
    const text = await fsp.readFile(file, "utf8");
    doc = YAML.parseDocument(text);
    const existing = doc.getIn(["locale", "preference"]);
    if (existing === preference) {
      log("engine UI locale already:", preference);
      return;
    }
  } catch {
    doc = YAML.parseDocument("");
  }
  doc.setIn(["locale", "preference"], preference);
  await fsp.writeFile(file, doc.toString(), "utf8");
  log("engine UI locale synced:", file, "->", preference);
}

// ---------------------------------------------------------------------------
// persistent update notice (corner badge window)
// ---------------------------------------------------------------------------

let noticeWin = null;

function showUpdateNotice(title, sub) {
  if (!win || win.isDestroyed()) return;
  if (noticeWin && !noticeWin.isDestroyed()) {
    noticeWin.close();
    noticeWin = null;
  }
  const W = 360;
  const H = 92;
  noticeWin = new BrowserWindow({
    width: W,
    height: H,
    frame: false,
    resizable: false,
    movable: true,
    skipTaskbar: true,
    show: false,
    backgroundColor: windowThemeDark ? "#0f151d" : "#ffffff",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  noticeWin.setAlwaysOnTop(true, "screen-saver");
  noticeWin.loadFile(path.join(__dirname, "notice.html"), { query: { theme: themeQuery(), lang: resolveUiLang() } });
  noticeWin.webContents.once("did-finish-load", () => {
    noticeWin.webContents
      .executeJavaScript(
        `document.getElementById("t").textContent = ${JSON.stringify(title)};
         document.getElementById("s").textContent = ${JSON.stringify(sub ?? "")};`,
      )
      .then(() => {
        const mainBounds = win.getBounds();
        const area = screen.getDisplayMatching(mainBounds).workArea;
        const x = area.x + area.width - W - 16;
        const y = area.y + area.height - H - 16;
        noticeWin.setBounds({ x, y, width: W, height: H });
        noticeWin.show();
        log("update notice shown:", title);
      })
      .catch((error) => err("notice render failed:", error));
  });
  noticeWin.on("closed", () => {
    noticeWin = null;
  });
}

// ---------------------------------------------------------------------------
// main window
// ---------------------------------------------------------------------------

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    show: false, // shown maximized below (avoid normal-size flicker)
    autoHideMenuBar: true,
    title: "DeepSeek Harness",
    icon: iconPath("icon.png"),
    backgroundColor: windowThemeDark ? "#0b0f14" : "#f0f2f5",
    webPreferences: {
      // Non-persist partition -> in-memory session, fresh on every launch.
      partition: `dsh-launch-${Date.now()}`,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // 页面内“重启回最近会话”的窄桥（记录/读取 last-session.json）。
      preload: path.join(__dirname, "workspace-preload.js"),
    },
  });
  // 主窗口启动最大化显示.
  win.maximize();
  win.show();
  applyEngineVersionChrome(); // 标题带上当前引擎版本（若有）
  win.loadFile(path.join(__dirname, "status.html"), { query: { theme: themeQuery(), lang: resolveUiLang() } });
  win.webContents.once("did-finish-load", () => {
    if (engineStarted && lastEngineUrl) {
      // Engine already running (window reopened from tray): reuse its URL.
      win.loadURL(lastEngineUrl).catch((error) => err("loadURL failed:", error));
      return;
    }
    boot().catch((error) => fatalUi(error));
  });
  win.webContents.on("page-title-updated", (event) => {
    // 页面想改标题时：阻止它，并把我们的“标题 + 版本号”设回去。
    event.preventDefault();
    applyEngineVersionChrome();
  });
  win.webContents.on("did-finish-load", () => {
    if (!win.isDestroyed() && win.webContents.getURL().startsWith("http")) {
      log("embedded web contents loaded:", win.webContents.getURL());
      // 引擎页加载完成后标题可能被页面短暂覆盖，再次固定。
      setTimeout(() => applyEngineVersionChrome(), 0);
      // 页面就绪后：设置开启时，请网页端插件尽早尝试自动打开“最近一次对话”
      // （减少“先显示空白对话再切回”的时长；false = 每次从空白/新会话开始）。
      // 注意：不能只试一次——会话页客户端模块（dsh-client-ui-conversation 补丁，
      // 暴露 window.__dshOpenLast）在页面加载数秒后才执行 apply()，固定延时 300ms
      // 的一次探测在插件较重/机器较慢时会错过，且再无重试 → “重启后不回上次会话”。
      // 这里按固定间隔轮询，直到 __dshOpenLast 就位并调用成功，或到达上限放弃。
      const stopOpenLastPoll = () => {
        if (openLastPollTimer) {
          clearTimeout(openLastPollTimer);
          openLastPollTimer = null;
        }
      };
      stopOpenLastPoll();
      openLastPollTries = 0;
      if (openLastPollClosed && !win.isDestroyed()) {
        win.removeListener("closed", openLastPollClosed);
      }
      openLastPollClosed = () => {
        stopOpenLastPoll();
        openLastPollClosed = null;
      };
      win.once("closed", openLastPollClosed);
      const tryOpenLast = () => {
        openLastPollTimer = null;
        if (win.isDestroyed() || settings.autoRestoreLastSession === false) return;
        if (openLastPollTries >= 100) {
          // ~30s 上限：足够覆盖冷启动最慢的模块加载。
          log("auto-restore: gave up waiting for __dshOpenLast");
          return;
        }
        openLastPollTries += 1;
        win.webContents
          .executeJavaScript("if (window.__dshOpenLast) { window.__dshOpenLast(); true } else { false }")
          .then((done) => {
            if (done === true) {
              log("auto-restore: __dshOpenLast invoked on try", openLastPollTries);
              return;
            }
            openLastPollTimer = setTimeout(tryOpenLast, 300);
          })
          .catch((error) => {
            // 页面仍在加载/导航：稍后重试（不是致命错误）。
            err("auto-restore probe failed (retrying):", error.message);
            openLastPollTimer = setTimeout(tryOpenLast, 300);
          });
      };
      setTimeout(tryOpenLast, 300);

      // 诊断钩子（DSH_SHELL_PAGE_DEBUG=1）：转发页面 console，检查页面桥与
      // “最近会话”补丁暴露的 __dshOpenLast 是否就位。
      if (process.env.DSH_SHELL_PAGE_DEBUG === "1") {
        win.webContents.on("console-message", (event, level, message) => {
          log(`[page console ${level}]`, String(message).slice(0, 500));
        });
        const probeScript = `(async () => {
          const out = {};
          try {
            out.dshGui = typeof window.__dshGui;
            out.guiKeys = Object.keys(window.__dshGui || {});
            out.openLast = typeof window.__dshOpenLast;
            out.title = document.title;
          } catch (e) { out.error = String((e && e.stack) || e); }
          return JSON.stringify(out);
        })()`;
        setTimeout(() => {
          win.webContents
            .executeJavaScript(probeScript)
            .then((res) => log("PAGE_DEBUG_PROBE:", res))
            .catch((error) => err("PAGE_DEBUG_PROBE failed:", error.message));
        }, 3000);
      }
    }
  });
  win.on("close", (event) => {
    // The main window must not close while the modal settings window is open.
    if (!quitting && settingsWin && !settingsWin.isDestroyed()) {
      event.preventDefault();
      log("main window cannot close while settings window is open");
      return;
    }
    // Close-to-tray: intercept unless the app is actually quitting.
    if (!quitting && settings.closeAction === "tray" && hasTray) {
      event.preventDefault();
      win.hide();
      log("window hidden to tray (closeAction=tray)");
    }
  });
  win.on("closed", () => {
    win = null;
  });
  return win;
}

function showMainWindow() {
  if (!win || win.isDestroyed()) {
    createWindow();
    return;
  }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

// ---------------------------------------------------------------------------
// settings window
// ---------------------------------------------------------------------------

function openSettingsWindow() {
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.show();
    settingsWin.focus();
    return;
  }
  const parent = win && !win.isDestroyed() ? win : undefined;
  const workArea = screen.getPrimaryDisplay().workAreaSize;
  settingsWin = new BrowserWindow({
    width: 800,
    height: Math.min(760, workArea.height - 40),
    // 双列布局：内容自适应高度（≤ 屏幕工作区），body 滚动仅作极短屏兜底。
    useContentSize: true,
    show: true,
    // Modal over the main window: while open, the main window cannot be
    // operated (clicked, minimized, or closed via its title bar).
    parent,
    modal: Boolean(parent),
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    autoHideMenuBar: true,
    title: L("settings.titleBar"),
    icon: iconPath("icon.png"),
    backgroundColor: windowThemeDark ? "#0f151d" : "#ffffff",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, "preload.js"),
    },
  });
  settingsWin.loadFile(path.join(__dirname, "settings.html"), {
    query: { theme: themeQuery(), lang: resolveUiLang() },
  });
  settingsWin.on("close", () => {
    // Guide the window back after the modal is gone (test/CI evidence).
    log("settings window closing");
  });
  settingsWin.on("closed", () => {
    settingsWin = null;
    if (win && !win.isDestroyed()) log("main window enabled again:", win.isEnabled());
  });
  log("settings modal open; main enabled:", win && !win.isDestroyed() ? win.isEnabled() : "no-main");
}

// ---------------------------------------------------------------------------
// system tray
// ---------------------------------------------------------------------------

function trayMenuTemplate() {
  return Menu.buildFromTemplate([
    { label: L("tray.open"), click: () => showMainWindow() },
    { label: L("tray.guiUpdate"), click: () => runGuiUpdate() },
    { label: L("tray.settings"), click: () => openSettingsWindow() },
    { type: "separator" },
    { label: L("tray.quit"), click: () => app.quit() },
  ]);
}

function refreshTrayMenu() {
  if (!tray || tray.isDestroyed()) return;
  try {
    tray.setContextMenu(trayMenuTemplate());
  } catch (error) {
    err("tray menu refresh failed:", error.message);
  }
}

function createTray() {
  try {
    const img = nativeImage.createFromPath(iconPath("tray-icon.png"));
    if (img.isEmpty()) throw new Error("tray icon is empty");
    tray = new Tray(img);
    hasTray = true;
    tray.setToolTip("DeepSeek Harness");
    tray.setContextMenu(trayMenuTemplate());
    tray.on("click", () => showMainWindow());
    applyEngineVersionChrome();
    log("tray created");
  } catch (error) {
    hasTray = false;
    err("tray unavailable:", error.message);
  }
}

// ---------------------------------------------------------------------------
// app menu
// ---------------------------------------------------------------------------

function buildMenu() {
  const currentHome = settings.dshHomeMode;
  const setHomeMode = (mode) => {
    if (mode === currentHome) return;
    // switchHomeMode handles: data check -> optional move -> save -> restart.
    applySettingsPatch({ dshHomeMode: mode }).then(() => {
      log("dsh home mode ->", mode);
      buildMenu();
    });
  };
  const template = [
    {
      label: L("menu.settings"),
      submenu: [
        { label: L("menu.openSettings"), click: () => openSettingsWindow() },
        { type: "separator" },
        { label: L("menu.dataDir"), enabled: false },
        {
          type: "radio",
          label: L("menu.home.app"),
          checked: currentHome === "app",
          click: () => setHomeMode("app"),
        },
        {
          type: "radio",
          label: L("menu.home.system"),
          checked: currentHome === "system",
          click: () => setHomeMode("system"),
        },
        { type: "separator" },
        { role: "quit", label: L("menu.quit") },
      ],
    },
  ];
  if (process.platform === "darwin") {
    template.unshift({ role: "appMenu" });
    template.push({ role: "editMenu" });
  }
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------------------------------------------------------------------------
// update checks (launch + periodic)
// ---------------------------------------------------------------------------

function scheduleUpdateChecks() {
  if (updateCheckTimer) {
    clearTimeout(updateCheckTimer);
    updateCheckTimer = null;
  }
  if (!settings.updateCheckEnabled) return;
  updateCheckTimer = setTimeout(() => {
    runPeriodicUpdateCheck().catch((error) => err("periodic check failed:", error));
  }, ENGINE_CHECK_INTERVAL_MS);
  log(`next periodic update check in ${Math.round(ENGINE_CHECK_INTERVAL_MS / 60000)}min`);
}

async function runPeriodicUpdateCheck() {
  scheduleUpdateChecks(); // re-arm before awaiting
  if (checkingInProgress) return;
  checkingInProgress = true;
  try {
    const latest = await fetchLatestVersion();
    const installed = await readInstalledVersion();
    if (latest === null) return;
    if (installed === null) return; // boot handles first install
    if (semver.gte(installed, latest)) return;
    if (settings.lastNotifiedVersion === latest) return; // already told the user
    log("periodic check found newer:", installed, "->", latest);
    await saveSettings({ lastNotifiedVersion: latest });
    showUpdateNotice(L("update.notice.found", latest), L("update.notice.nextLaunch"));
  } finally {
    checkingInProgress = false;
  }
}

let guiCheckBusy = false;

/** 托盘“检查 DSH GUI 更新…”：查 GitHub Releases，有新版则询问并打开下载页。 */
async function runGuiUpdate() {
  if (guiCheckBusy) return;
  guiCheckBusy = true;
  const parent = win && !win.isDestroyed() ? win : undefined;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);
    let res;
    try {
      res = await fetch(GUI_REPO_API, {
        signal: controller.signal,
        headers: { accept: "application/vnd.github+json" },
      });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) throw new Error(`GitHub responded ${res.status}`);
    const release = await res.json();
    const tag = String(release.tag_name || "").replace(/^v/i, "");
    const current = app.getVersion();
    if (!semver.valid(tag)) throw new Error("invalid release tag");
    if (!semver.lt(current, tag)) {
      dialog
        .showMessageBox(parent, {
          type: "info",
          title: L("update.upToDate.title"),
          message: L("update.gui.upToDate", current),
          buttons: [L("common.ok")],
        })
        .catch(() => {});
      return;
    }
    const { response } = await dialog
      .showMessageBox(parent, {
        type: "question",
        title: L("update.gui.title"),
        message: L("update.gui.msg", tag),
        detail: L("update.gui.detail", current),
        buttons: [L("update.gui.open"), L("update.gui.cancel")],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
      })
      .catch(() => ({ response: 1 }));
    if (response === 0) {
      shell.openExternal(GUI_RELEASES_URL).catch((error) => err("openExternal failed:", error.message));
    }
  } catch (error) {
    err("gui update check failed:", error);
    dialog
      .showMessageBox(parent, {
        type: "info",
        title: L("update.gui.cant.title"),
        message: L("update.gui.cant.msg"),
        detail: String((error && error.message) || error),
        buttons: [L("common.ok")],
      })
      .catch(() => {});
  } finally {
    guiCheckBusy = false;
  }
}

let engineCheckBusy = false;

/** 设置窗口「立即检查引擎更新」：查新版 → 有则询问 → 下载安装 → 询问重启。 */
async function runManualEngineUpdate() {
  if (engineCheckBusy) return { busy: true };
  engineCheckBusy = true;
  const parent = settingsWin && !settingsWin.isDestroyed() ? settingsWin : win && !win.isDestroyed() ? win : undefined;
  try {
    const latest = await fetchLatestVersion();
    const installed = await readInstalledVersion();
    if (latest === null) {
      dialog
        .showMessageBox(parent, {
          type: "info",
          title: L("update.cantCheck"),
          message: L("update.cantReach"),
          detail: installed ? L("update.currentV", installed) : L("update.notInstalled"),
          buttons: [L("common.ok")],
        })
        .catch(() => {});
      return { ok: true, status: "unreachable" };
    }
    if (installed !== null && semver.gte(installed, latest)) {
      dialog
        .showMessageBox(parent, {
          type: "info",
          title: L("update.upToDate.title"),
          message: L("update.upToDate.msg", installed),
          buttons: [L("common.ok")],
        })
        .catch(() => {});
      return { ok: true, status: "up-to-date" };
    }
    const { response } = await dialog
      .showMessageBox(parent, {
        type: "question",
        title: L("update.found.title"),
        message: L("update.found.msg", latest),
        detail: L("update.found.detail", installed ?? L("update.notInstalled")),
        buttons: [L("update.nowRestart"), L("update.later")],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
      })
      .catch(() => ({ response: 1 }));
    if (response !== 0) return { ok: true, status: "deferred" };

    log("manual engine update: installing", DSH_PACKAGE, "@" + latest);
    await npmInstall(latest, () => {});
    const nowV = await readInstalledVersion();
    log("manual engine update: installed", nowV ?? latest);
    engineVersion = nowV;
    applyEngineVersionChrome();
    broadcastSettings();
    await saveSettings({
      engineNode: (() => {
        try {
          return nodeVersionOf(resolveNodeExecutable());
        } catch {
          return settings.engineNode;
        }
      })(),
      lastNotifiedVersion: undefined,
    });
    const { response: restart } = await dialog
      .showMessageBox(parent, {
        type: "question",
        title: L("update.done.title"),
        message: L("update.done.msg", nowV ?? latest),
        detail: L("update.done.detail"),
        buttons: [L("update.restartNow"), L("update.restartLater")],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
      })
      .catch(() => ({ response: 1 }));
    if (restart === 0) {
      log("manual engine update: restarting to use new engine");
      app.relaunch();
      app.quit();
    }
    return { ok: true, status: "installed", installed: nowV ?? latest };
  } catch (error) {
    err("manual engine update failed:", error);
    dialog
      .showMessageBox(parent, {
        type: "error",
        title: L("update.failed.title"),
        message: L("update.failed.msg"),
        detail: String((error && error.message) || error),
        buttons: [L("common.ok")],
      })
      .catch(() => {});
    return { ok: false, error: String((error && error.message) || error) };
  } finally {
    engineCheckBusy = false;
  }
}

// ---------------------------------------------------------------------------
// boot sequence
// ---------------------------------------------------------------------------

async function boot() {
  const nodeExec = resolveNodeExecutable();
  const nodeVersion = nodeVersionOf(nodeExec);

  ENGINE_DIR = path.join(userDataDir(), "dsh-engine");
  NPM_CACHE_DIR = path.join(userDataDir(), "npm-cache");
  await fsp.mkdir(ENGINE_DIR, { recursive: true });
  await fsp.mkdir(NPM_CACHE_DIR, { recursive: true });
  if (dshHome) await fsp.mkdir(dshHome, { recursive: true });

  // UI 语言：GUI 与引擎同步（system 模式在启动时解析一次并写入引擎设置文件）。
  try {
    await syncEngineUILocale();
  } catch (error) {
    err("engine UI locale sync skipped:", error.message);
  }

  log("userData:", userDataDir());
  log("node:", nodeExec, "(", nodeVersion, ")");

  const installed = await readInstalledVersion();
  log("installed:", installed ?? "none");
  engineVersion = installed;
  applyEngineVersionChrome();

  // Decide whether to query the registry.
  let latest = null;
  let checkedThisLaunch = false;
  if (settings.updateCheckEnabled) {
    const last = typeof settings.lastCheckedAt === "number" ? settings.lastCheckedAt : 0;
    const due = Date.now() - last >= ENGINE_CHECK_INTERVAL_MS;
    if (due || installed === null) {
      checkedThisLaunch = true;
      setStatus(L("update.check"));
      try {
        latest = await fetchLatestVersion();
      } catch (error) {
        err("registry check failed:", error.message);
      }
      await saveSettings({ lastCheckedAt: Date.now() });
    } else {
      log("update check skipped (within interval)");
    }
  } else {
    log("update checking is disabled");
  }
  log("latest:", latest ?? "unreachable");

  // A Node runtime change (e.g. first run with a bundled portable node) makes
  // the previously installed engine's native modules ABI-incompatible -> reinstall.
  const nodeChanged = Boolean(
    settings.engineNode && nodeVersion && settings.engineNode !== nodeVersion,
  );
  const updateNeeded =
    installed === null ||
    (latest !== null && semver.lt(installed, latest)) ||
    nodeChanged;
  log("updateNeeded:", updateNeeded, "| nodeChanged:", Boolean(nodeChanged));

  if (updateNeeded) {
    if (installed === null && latest === null && !settings.updateCheckEnabled) {
      // Update checks are off and we have no engine: one-time setup install.
      log("no engine and update checks disabled -> one-time install of latest");
      setStatus(L("update.status.first"), L("update.checksOff"));
      try {
        await npmInstall(null, (line) => setStatus(L("update.firstInstall"), String(line).slice(0, 120) || L("update.installProgress")));
        const installedNow = await readInstalledVersion();
        await saveSettings({ engineNode: nodeVersion ?? settings.engineNode, lastNotifiedVersion: undefined });
        log("engine installed:", installedNow);
        engineVersion = installedNow;
        applyEngineVersionChrome();
      } catch (error) {
        fatalUi(error, L("engine.installFailed"));
        return;
      }
    } else if (installed !== null && latest === null) {
      // Registry unreachable but engine present -> run what we have (offline).
      log("offline fallback");
      setStatus(L("update.status.offline", installed), L("update.starting"));
    } else {
      const verb =
        installed === null
          ? L("update.firstInstall")
          : nodeChanged
            ? L("update.reinstallRuntime")
            : L("update.newVersion", latest, installed);
      const policy = settings.updatePolicy;

      // "ask": let the user choose, unless we have no choice at all.
      if (policy === "ask" && installed !== null && !nodeChanged && latest !== null) {
        const { response } = await dialog
          .showMessageBox(win, {
            type: "question",
            title: L("update.bootQuestion.title"),
            message: L("update.bootQuestion.msg", latest),
            detail: L("update.bootQuestion.detail", installed),
            buttons: [L("update.bootNow"), L("update.bootUseCurrent")],
            defaultId: 0,
            cancelId: 1,
            noLink: true,
          })
          .catch(() => ({ response: 0 }));
        if (response === 1) {
          log("user skipped update");
          setStatus(L("update.status.skipped", installed), L("update.starting"));
          await startEngine(nodeExec);
          scheduleUpdateChecks();
          return;
        }
      }

      // "notify": only inform, never install (unless we must install to run at all).
      if (policy === "notify" && installed !== null && !nodeChanged && latest !== null) {
        log("notify-only policy: skipping install");
        showUpdateNotice(L("update.notice.found", latest), L("update.notice.detailAuto"));
        setStatus(L("update.status.found", latest), L("update.starting"));
        await startEngine(nodeExec);
        scheduleUpdateChecks();
        return;
      }

      // auto (or forced) -> install.
      log("installing", DSH_PACKAGE, latest ? `@${latest}` : "(latest)");
      setStatus(verb, L("update.installProgress"));
      try {
        await npmInstall(latest, (line) =>
          setStatus(verb, String(line).slice(0, 120) || L("update.installProgress")),
        );
        const installedNow = await readInstalledVersion();
        log("engine updated to", installedNow ?? latest);
        engineVersion = installedNow;
        applyEngineVersionChrome();
        await saveSettings({ engineNode: nodeVersion ?? settings.engineNode, lastNotifiedVersion: undefined });
        if (installedNow && installedNow !== installed) {
          showUpdateNotice(L("update.notice.updated", installedNow), L("update.notice.thisLaunch"));
        }
        setStatus(L("update.status.ready", installedNow ?? latest), L("update.starting"));
      } catch (error) {
        err("engine update failed:", error);
        if (installed !== null) {
          dialog
            .showMessageBox(win, {
              type: "warning",
              title: L("update.failed.title"),
              message: L("update.autoUpdateFailed", latest),
              detail: `${String((error && error.message) || error)}\n\n${L("update.failed.willUseCurrent", installed)}`,
              buttons: [L("common.continue")],
            })
            .catch(() => {});
          setStatus(L("update.status.failed", installed), L("update.starting"));
        } else {
          fatalUi(error, L("engine.installFailed"));
          return;
        }
      }
    }
  } else if (installed !== null) {
    if (checkedThisLaunch) {
      log("engine already up to date");
      setStatus(L("update.status.upToDate", installed), L("update.starting"));
    } else {
      log("engine present; skipped registry check (within interval / disabled)");
      setStatus(L("update.status.ready", installed), L("update.starting"));
    }
  }

  await startEngine(nodeExec);
  scheduleUpdateChecks();

  // Test-only hook: force an update notice for CI verification.
  if (process.env.DSH_SHELL_TEST_NOTICE) {
    showUpdateNotice(L("update.notice.updated", "9.9.9-test"), L("update.notice.thisLaunch"));
  }
}

async function startEngine(nodeExec) {
  setStatus(L("update.starting"), L("update.firstInit"));
  // 给引擎客户端打幂等小补丁（“重启回最近会话”页内逻辑；锚点不匹配跳过不阻塞）。
  try {
    ensureEnginePatches({ engineDir: ENGINE_DIR, log });
  } catch (error) {
    err("engine patch skipped:", error.message);
  }
  // 启动时自动安装/挂载已勾选的第三方插件（幂等；任一步失败只记日志，不影响启动）。
  // 同时做“引擎兼容性”预检：GUI 勾选、已装但当前引擎不兼容的目录插件（会在
  // profile 启动时把引擎打崩，如 dsh-agent-teams 0.1.15 ↔ 0.1.2-rc.1）在 spawn
  // 引擎之前移除，保证本次启动可用；非 GUI 勾选的已装插件不静默清理（交给启动
  // 失败诊断弹窗，由用户点「禁用并重启」）。autoPlugins 为空但 profile 里已有
  // 额外 bundle 时也要跑，因此按“有勾选或有已装额外插件”决定是否需要 pnpm 对账。
  pluginsInstalledThisLaunch = [];
  startupDiagnosisDone = false;
  const autoPluginIds = Array.isArray(settings.autoPlugins) ? settings.autoPlugins : [];
  const profileBundles = readInstalledProfileBundles(effectiveHomePath());
  const extraBundlesPresent = profileBundles.some(
    (pkg) => pkg !== "@deepseek-ai/dsh-base" && pkg !== "@deepseek-ai/dsh-web-app",
  );
  if (autoPluginIds.length > 0 || extraBundlesPresent) {
    try {
      const syncResult = await syncEnabledPlugins({
        enabledIds: autoPluginIds,
        engineDir: ENGINE_DIR,
        dshHome: effectiveHomePath(),
        nodeExec,
        pnpmInstallDir: path.join(userDataDir(), "pnpm-tools"),
        stagingRoot: pluginBundledPluginsDir(),
        log,
      });
      if (syncResult.installed.length > 0) {
        pluginsInstalledThisLaunch = syncResult.installed;
        log("auto-installed plugins:", syncResult.installed.join(", "));
        // 测试钩子：破坏刚装的插件 bundle（模拟“坏插件导致引擎启动失败”）。
        if (process.env.DSH_SHELL_TEST_BREAK_PLUGIN) {
          const fsx = require("node:fs");
          for (const id of syncResult.installed) {
            const entry = PLUGIN_CATALOG.find((c) => c.id === id);
            if (!entry) continue;
            const patch = path.join(effectiveHomePath(), "profiles", "web", "node_modules", entry.pkg, "cordis.patch.yml");
            try {
              fsx.rmSync(patch, { force: true });
              log("test hook: corrupted plugin bundle patch for", entry.pkg);
            } catch (error) {
              err("test hook: corrupt failed", error.message);
            }
          }
        }
      }
      if (syncResult.removed.length > 0) {
        log("auto-removed engine-incompatible plugins:", syncResult.removed.join(", "));
        await saveSettings({
          autoPlugins: autoPluginIds.filter((id) => !syncResult.removed.includes(id)),
        }).catch((error) => err("persist incompatible plugin removal failed:", error.message));
      }
      if (syncResult.skipped.length > 0) {
        log("skipped engine-incompatible plugins:", syncResult.skipped.join(", "));
      }
      if (syncResult.errors.length > 0) err("auto plugin install issues:", syncResult.errors.join(" | "));
    } catch (error) {
      err("auto plugin sync skipped:", error.message);
    }
  }
  let settled = false;

  // 引擎启动失败兜底：本次刚自动装过插件且 dsh 迟迟不就绪/提前退出/报错时，
  // 把刚装的插件逐个 remove 并从 autoPlugins 取消勾选，提示后重试一次。
  const clearWatchdog = () => {
    if (pluginReadyWatchdog) {
      clearTimeout(pluginReadyWatchdog);
      pluginReadyWatchdog = null;
    }
  };
  const recoverFromPluginFailure = async (reason) => {
    if (pluginFailureRecoveryDone) return;
    pluginFailureRecoveryDone = true;
    clearWatchdog();
    const ids = [...pluginsInstalledThisLaunch];
    pluginsInstalledThisLaunch = [];
    if (ids.length === 0) return;
    log("engine start failed after plugin auto-install (" + reason + ") — excluding plugins:", ids.join(", "));
    // 同样落一份启动错误日志（即使走自动剔除）。
    try {
      await writeStartupErrorLog(startupErrorLogPath("auto-exclude"), {
        code: null,
        signal: reason,
        tail: engineOutputTail(),
      });
    } catch (error) {
      err("write auto-exclude log failed:", error.message);
    }
    // 终止当前引擎进程（若还活着）。
    if (dshChild) {
      intentionalEngineStop = true;
      await new Promise((resolve) => killProcessTree(dshChild, resolve));
      dshChild = null;
    }
    let removed = [];
    try {
      const pnpmBinDir = await ensurePluginPnpm({
        installDir: path.join(userDataDir(), "pnpm-tools"),
        pnpmSpec: profilePnpmSpec(),
        nodeExec,
        log,
      });
      for (const id of ids) {
        const entry = PLUGIN_CATALOG.find((c) => c.id === id);
        if (!entry) continue;
        const res = await removeEnginePlugin({
          engineDir: ENGINE_DIR,
          dshHome: effectiveHomePath(),
          pnpmBinDir,
          pkg: entry.pkg,
          nodeExec,
          log,
        });
        if (res.ok) removed.push(id);
        else err("exclude plugin remove failed:", entry.pkg, res.output.slice(-200));
      }
    } catch (error) {
      err("plugin exclusion failed:", error);
    }
    if (removed.length > 0) {
      await saveSettings({
        autoPlugins: (settings.autoPlugins ?? []).filter((id) => !removed.includes(id)),
      }).catch((error) => err("persist plugin exclusion failed:", error.message));
      showUpdateNotice(
        L("plugin.excluded.title"),
        L("plugin.excluded.msg", removed.map((id) => PLUGIN_CATALOG.find((c) => c.id === id)?.pkg ?? id).join(", ")),
      );
    }
    setStatus(L("engine.startFailed"), L("plugin.excluded.title"));
    // 剔除后重试一次（autoPlugins 已去掉坏插件，不会再自动装回）。
    await startEngine(nodeExec);
  };

  dshChild = spawnDsh(nodeExec, {
    onUrl: (url) => {
      if (settled) return;
      settled = true;
      clearWatchdog();
      uiSettled = true;
      engineStarted = true;
      engineReady = true;
      engineRestartInFlight = false;
      intentionalEngineStop = false;
      unexpectedEngineExits = 0;
      lastEngineUrl = url;
      log("web UI URL:", url);
      setStatus(L("update.loadingUi"), "");
      win.loadURL(url).catch((error) => err("loadURL failed:", error));
      // 引擎页就绪后其 document.title 可能覆盖窗口标题，稍后把“标题+版本号”固定回去。
      setTimeout(() => applyEngineVersionChrome(), 1500);
      scheduleAutoQuit();
    },
    onExit: (code, signal) => {
      log("dsh exited code=", code, "signal=", signal ?? "");
      engineStarted = false;
      engineReady = false;
      lastEngineUrl = null;
      if (!settled) {
        // 尚未就绪就退出：本次刚自动装过插件 → 先自动剔除并重试（保留既有兜底）；
        // 已剔除过或本就没有本次新装插件 → 进入诊断（保存日志、判定插件/原因）。
        if (!pluginFailureRecoveryDone && pluginsInstalledThisLaunch.length > 0) {
          recoverFromPluginFailure(`exit ${code}`).catch((error) => err("plugin recovery failed:", error.message));
        } else {
          handleStartupFailure({ code, signal, tail: engineOutputTail() });
        }
        return;
      }
      // 曾成功就绪后退出：主动停止/切换目录/正在重启由调用方负责，这里不插手。
      if (quitting || engineRestartInFlight || intentionalEngineStop) return;
      // 本次刚装过插件且尚未剔除过 → 可能插件在运行后把引擎弄崩，先剔除再重拉。
      if (!pluginFailureRecoveryDone && pluginsInstalledThisLaunch.length > 0) {
        recoverFromPluginFailure(`exit-after-ready ${code}`).catch((error) =>
          err("plugin recovery failed:", error.message),
        );
        return;
      }
      // 其余意外退出（含 dsh 页面自身请求退出/插件市场的“重启”）：GUI 作为
      // supervisor 自动重拉引擎；连续失败 3 次后停止并提示。
      unexpectedEngineExits += 1;
      if (unexpectedEngineExits > 3) {
        setStatus(L("engine.startFailed"), L("engine.autoRestartGaveUp", unexpectedEngineExits));
        showUpdateNotice(L("engine.crash.title"), L("engine.crash.msg", String(code ?? signal ?? "")));
        return;
      }
      log(`engine exited after ready (${code} ${signal ?? ""}) — auto-restart ${unexpectedEngineExits}/3`);
      setTimeout(() => {
        if (!quitting && !engineRestartInFlight) restartEngineNow(`auto-restart after exit ${code}`);
      }, 600);
    },
    onError: (error) => {
      if (settled) return;
      settled = true;
      clearWatchdog();
      engineStarted = false;
      engineReady = false;
      if (!pluginFailureRecoveryDone && pluginsInstalledThisLaunch.length > 0) {
        recoverFromPluginFailure(String((error && error.message) || error)).catch((e2) =>
          err("plugin recovery failed:", e2.message),
        );
      } else {
        handleStartupFailure({ error, tail: engineOutputTail() });
      }
    },
  });
  // 看门狗：引擎装好但 90 秒未就绪（坏插件卡死或其它原因）→ 走剔除/诊断重试。
  pluginReadyWatchdog = setTimeout(() => {
    if (!settled && !pluginFailureRecoveryDone) {
      recoverFromPluginFailure("watchdog timeout").catch((error) => err("plugin recovery failed:", error.message));
    } else if (!settled && !startupDiagnosisDone) {
      // 无本次新装插件时引擎仍挂起 → 终止后诊断。
      intentionalEngineStop = true;
      if (dshChild) {
        const child = dshChild;
        dshChild = null;
        killProcessTree(child, () => {
          handleStartupFailure({ tail: engineOutputTail(), code: "timeout" });
        });
      } else {
        handleStartupFailure({ tail: engineOutputTail(), code: "timeout" });
      }
    }
  }, 90000);
  return dshChild;
}

// ---------------------------------------------------------------------------
// IPC (settings window)
// ---------------------------------------------------------------------------

function registerIpc() {
  ipcMain.handle("settings:get", () => settingsPayload());
  ipcMain.handle("settings:set", async (_event, patch) => {
    try {
      return await applySettingsPatch(patch ?? {});
    } catch (error) {
      err("settings:set failed:", error);
      throw error;
    }
  });

  // GUI 托管的引擎重启（页面/设置窗口用）：杀掉 dsh 子进程并按既有流程重拉。
  ipcMain.handle("dsh-gui:restart-engine", () => restartEngineNow("requested from page"));
  ipcMain.handle("settings:restart-engine", () => restartEngineNow("requested from settings"));

  // 设置窗口「立即检查引擎更新」：查新版 → 按选择下载安装（弹窗在主进程完成）。
  ipcMain.handle("settings:update-check", () => runManualEngineUpdate());

  // 设置窗口勾选插件后立即安装（幂等）；卸载需等下次启动前对账或手动移除。
  ipcMain.handle("settings:plugin-sync", async () => {
    try {
      const result = await syncEnabledPlugins({
        enabledIds: settings.autoPlugins ?? [],
        engineDir: ENGINE_DIR,
        dshHome: effectiveHomePath(),
        nodeExec: resolveNodeExecutable(),
        pnpmInstallDir: path.join(userDataDir(), "pnpm-tools"),
        stagingRoot: pluginBundledPluginsDir(),
        log,
      });
      broadcastSettings();
      return { ...result, status: pluginCatalogStatus(effectiveHomePath()) };
    } catch (error) {
      err("plugin sync failed:", error);
      return { installed: [], errors: [String((error && error.message) || error)] };
    }
  });

  // 设置窗口内容自适应高度：由页面在内容尺寸变化时上报（语言切换/主题等）。
  ipcMain.handle("settings:autosize", (_event, height) => {
    if (!settingsWin || settingsWin.isDestroyed()) return;
    if (_event.sender !== settingsWin.webContents) return;
    const workArea = screen.getPrimaryDisplay().workAreaSize;
    const target = Math.min(Math.max(480, Math.round(Number(height) || 560)), Math.max(480, workArea.height - 40));
    settingsWin.setContentSize(800, target);
  });

  // “最近一次对话”记忆：记录 / 读取用户最后使用的会话（重启后自动打开）。
  function lastSessionFile() {
    return path.join(userDataDir(), "last-session.json");
  }
  ipcMain.handle("dsh-gui:set-last-session", async (_event, sessionId) => {
    if (typeof sessionId !== "string" || !sessionId.startsWith("session-")) throw new Error("invalid session id");
    await fsp.writeFile(lastSessionFile(), JSON.stringify({ sessionId, updatedAt: Date.now() }), "utf8");
    return { ok: true };
  });
  ipcMain.handle("dsh-gui:get-last-session", async () => {
    try {
      const data = JSON.parse(await fsp.readFile(lastSessionFile(), "utf8"));
      if (typeof data.sessionId === "string" && data.sessionId.startsWith("session-")) return data;
    } catch {
      /* none yet */
    }
    return null;
  });
}

// ---------------------------------------------------------------------------
// app lifecycle
// ---------------------------------------------------------------------------

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    showMainWindow();
  });

  app.whenReady().then(async () => {
    await loadSettings();
    // Read DeepSeek Harness' own appearance setting first, then show windows
    // according to it (requirement: 窗口启动时先读取外观设置再显示).
    const harnessTheme = await readHarnessTheme();
    applyHarnessTheme(harnessTheme);
    registerIpc();
    buildMenu();
    createTray();
    createWindow();
    // Test/CI hook: open the settings window right after startup.
    if (process.env.DSH_SHELL_TEST_OPEN_SETTINGS) {
      setImmediate(() => openSettingsWindow());
    }
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0 || !win || win.isDestroyed()) showMainWindow();
    });
  });

  app.on("window-all-closed", () => {
    // With "隐藏到托盘" the main window's close event is intercepted, so this
    // fires only while the app is already quitting. With "直接退出" a closed
    // window reaches here -> quit the whole app (tray removed on quit too).
    app.quit();
  });

  app.on("before-quit", () => {
    quitting = true;
    if (tray) {
      tray.destroy();
      tray = null;
      hasTray = false;
      log("tray destroyed");
    }
  });

  // Async tree-kill of the dsh child before the app actually exits.
  app.on("will-quit", (event) => {
    if (!dshChild) return;
    event.preventDefault();
    log("stopping dsh engine…");
    killProcessTree(dshChild, () => {
      dshChild = null;
      app.quit();
    });
  });

  // Test/CI hook: if the UI never becomes ready, quit after a generous
  // watchdog so automated runs cannot hang. Only active when AUTOQUIT is set.
  if (autoquitMs > 0) {
    setTimeout(() => {
      if (!uiSettled) {
        err("autoquit watchdog: web UI never loaded");
        app.quit();
      }
    }, autoquitMs + 120000);
  }

  app.disableHardwareAcceleration();
}