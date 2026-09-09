"use strict";

/**
 * plugin-manager.js — DSH GUI 对 dsh 引擎 web profile 的第三方插件管理。
 *
 * 引擎从 0.1.2-rc.1 起内置官方插件机制：在 <DSH_HOME>/profiles/web 里用 pnpm
 * 安装声明 `dsh.bundle` 的 npm 包，并把包名登记进该 profile 的 package.json
 * `dsh.profile.bundles`（`dsh plugin --profile web add <pkg>` 完成安装+登记；
 * `remove` 反向）。引擎启动时按 bundles 列表加载每个包的 cordis.patch 补丁层。
 *
 * 本模块：
 *   - 维护一个“启动自动挂载”候选目录（经核实的社区插件）；
 *   - 按需用 bundled npm 自举 pnpm（`dsh plugin` 子命令内部转发给 pnpm）；
 *   - 以同一 DSH_HOME 运行 `node <engineBin> plugin --profile web <add|remove>`；
 *   - 提供已装状态（bundles 列表 + profile node_modules 实存）供设置页展示；
 *  - 引擎兼容性门控：目录条目声明 engineRange 且不满足当前引擎时，绝不安装；
 *     已装且由 GUI 勾选管理的会在 spawn 引擎前自动移除（这类插件会让 profile
 *     启动崩溃，如 dsh-agent-teams 0.1.15 ↔ dsh 0.1.2-rc.1）；非 GUI 勾选的
 *     已装插件保留不动，交给“启动失败诊断”弹窗由用户决定，避免误清理。
 *
 * 仓库自带的捆绑插件（CATALOG 中带 `localSource` 的项，位于 <repo>/plugins）
 * 不直接按 app.asar 内路径安装——打包后该目录在 app.asar 里，子进程 pnpm 无法
 * 读取（会把 app.asar 当普通文件，“as it does not exist”）。主进程 Electron fs
 * 能透明读 asar，因此先把捆绑插件 staging 成磁盘上的真实目录（主进程传的无空格
 * 根目录 <home>\.dsh-gui\bundled-plugins，必要时 8.3 短路径），再让 pnpm 安装
 * 那份拷贝（见 stageBundledPlugin / syncEnabledPlugins）。
 *
 * 安全说明：第三方插件=以你的权限在你的机器上运行的第三方代码。仅在你勾选后
 * 才自动安装；默认关闭。列表只收录在官方目录核实过的包名，避免同名误装。
 */

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { spawn } = require("node:child_process");
const semver = require("semver");

/** 候选目录：id 用于设置持久化；pkg 是 npm 安装名（需与目录核实一致）。 */
const CATALOG = [
  {
    id: "dsh-market",
    pkg: "dshmarket",
    zh: "插件市场（dsh-market）",
    en: "Plugin marketplace (dsh-market)",
    zhDesc: "Harness 内置的可视化插件市场：浏览、搜索、一键安装社区插件。",
    enDesc: "A visual plugin market inside DeepSeek Harness — browse, search, and one-click install community plugins.",
    url: "https://github.com/dsh-market/dsh-market",
  },
  {
    id: "dsh-better-sidebar",
    pkg: "dsh-better-sidebar",
    zh: "增强侧栏（dsh-better-sidebar）",
    en: "Better sidebar (dsh-better-sidebar)",
    zhDesc: "VSCode 风格右侧工作台：资源管理器 / 编辑器 / 终端 / Git / 浏览器。",
    enDesc: "A VSCode-like right sidebar (explorer / editor / terminal / git / browser).",
    url: "https://github.com/omdsh-dev/DSH-better-sidebar",
  },
  {
    id: "dsh-agent-teams",
    pkg: "@nanmicoder/dsh-agent-teams",
    // 引擎兼容性门控：npm `@latest` 的插件 0.1.15 只适配 Harness 0.1.2-alpha.2
    // 的宿主 API（ctx.subagents.registerContinuableSetup），对 RC/更新的宿主无
    // 适配层（插件 README 明示 “no adapter for the old RC host APIs”）；在
    // 0.1.2-rc.1 上会直接让引擎启动崩溃。GUI 默认引擎通道（npm latest）是
    // rc.1 → 版本固定为 0.1.15 并按 engineRange 拦截安装；若用户自己已装，
    // 启动前对账会把它移除（见 syncEnabledPlugins）。插件发布适配新版引擎的
    // 版本后，由目录维护者更新 version / engineRange。
    version: "0.1.15",
    engineRange: "0.1.2-alpha.2",
    zhEngine: "需要 dsh 0.1.2-alpha.2（插件 0.1.15 仅适配该宿主）",
    enEngine: "Requires dsh 0.1.2-alpha.2 (plugin v0.1.15 supports only that host)",
    zh: "智能体团队（dsh-agent-teams）",
    en: "Agent teams (dsh-agent-teams)",
    zhDesc: "多智能体团队协作：队长 / 成员 / 带依赖的任务与消息，网页内有树状监视器。",
    enDesc: "Multi-agent team collaboration (captain / members / tasks with dependencies) with a tree monitor in the web GUI.",
    url: "https://github.com/NanmiCoder/dsh-agent-teams",
  },
  {
    id: "dsh-opencode-go-session",
    // Local source install: this plugin is distributed in this repository under
    // plugins/<localSource> and is never fetched from the npm registry.
    // `pkg` is the TRUE package name (the key used in the profile bundles
    // registry / node_modules / settings UI). The bundled folder cannot be
    // installed straight from the app bundle: in packaged builds it lives
    // inside app.asar, which a child pnpm process cannot read (app.asar looks
    // like a plain file to it). plugin-manager therefore stages a real copy
    // under the pnpm tools dir first and installs that (see stageBundledPlugin).
    pkg: "dsh-opencode-go-session",
    localSource: "dsh-opencode-go-session",
    zh: "OpenCode 会话头（dsh-opencode-go-session）",
    en: "OpenCode session header (dsh-opencode-go-session)",
    zhDesc: "为发往 OpenCode / OpenCode Go 的模型请求自动附加稳定的按会话 x-opencode-session 头，修复 400 MissingSessionID。加固版：默认以不透明 UUID 替代内部会话 ID，杜绝内部标识泄露。",
    enDesc: "Attaches a stable per-conversation x-opencode-session header to OpenCode / OpenCode Go model requests — fixes 400 MissingSessionID. Hardened: defaults to an opaque UUID instead of the internal session id, so no internal identifier is sent to third parties.",
    url: "",
  },
];

const CATALOG_IDS = new Set(CATALOG.map((entry) => entry.id));

/** npm 包名 -> catalog 项。 */
function catalogByPkg() {
  const map = new Map();
  for (const entry of CATALOG) map.set(entry.pkg, entry);
  return map;
}

/** 当前引擎版本（<engineDir>/node_modules/@deepseek-ai/dsh 的 version），读不到返回 null。 */
function readEngineVersion(engineDir) {
  try {
    const file = path.join(engineDir, "node_modules", "@deepseek-ai", "dsh", "package.json");
    return JSON.parse(fs.readFileSync(file, "utf8")).version ?? null;
  } catch {
    return null;
  }
}

/**
 * 条目是否兼容指定引擎版本。未声明 engineRange、或引擎版本未知时不拦
 * （保持旧行为）；引擎版本不满足 range 时视为不兼容——这类插件在旧/新宿主上
 * 可能直接让 profile 启动崩溃（如 dsh-agent-teams 0.1.15 ↔ 0.1.2-rc.1）。
 */
function engineSatisfies(entry, engineVersion) {
  if (!entry.engineRange) return true;
  if (!engineVersion) return true;
  try {
    return semver.satisfies(engineVersion, entry.engineRange);
  } catch {
    return true;
  }
}

/** 引擎兼容性概览：id -> { ok: boolean|null, range: string|null }（设置页展示用）。 */
function catalogEngineCompat(engineVersion) {
  const out = {};
  for (const entry of CATALOG) {
    out[entry.id] = entry.engineRange
      ? { ok: engineSatisfies(entry, engineVersion), range: entry.engineRange }
      : { ok: true, range: null };
  }
  return out;
}

/** npm 目录条目的安装 spec：声明了 version 的条目装固定版本（目录核实过的组合）。 */
function registrySpec(entry) {
  return entry.version ? `${entry.pkg}@${entry.version}` : entry.pkg;
}

/** 解析 bundled / 环境 npm 提供者（与主进程逻辑一致，可独立跑）。 */
function resolveNpmCli(nodeExec) {
  const candidates = [
    path.join(path.dirname(nodeExec), "node_modules", "npm", "bin", "npm-cli.js"),
    path.join(path.dirname(nodeExec), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
    process.env.DSH_SHELL_NPM_CLI,
  ].filter(Boolean);
  return candidates.find((p) => p && fs.existsSync(p)) || null;
}

function runNpm(nodeExec, cli, args, { cwd, envExtra = {}, log = () => {}, timeoutMs = 180000, npmCacheDir }) {
  return new Promise((resolve, reject) => {
    log("npm", [cli, ...args].join(" "));
    const child = spawn(nodeExec, [cli, ...args], {
      cwd,
      env: {
        ...process.env,
        ...(npmCacheDir ? { npm_config_cache: npmCacheDir } : {}),
        npm_config_update_notifier: "false",
        npm_config_fund: "false",
        npm_config_audit: "false",
        ...envExtra,
      },
      windowsHide: true,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let tail = "";
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch {}
    }, timeoutMs);
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      tail = (tail + chunk).split(/\r?\n/u).slice(-8).join("\n");
    });
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`npm exited with ${code}\n${tail}`));
    });
  });
}

/**
 * 自举 pnpm：按需用 bundled npm 安装 pnpm（已装且主版本匹配时直接复用）。
 *
 * pnpm 主版本决定 store 布局：pnpm 10 用 store v10，pnpm 12 用 store v11 等。
 * 一个 profile 的 node_modules 由哪个主版本构建（.modules.yaml 的
 * packageManager/pnpmVersion）就只能用同主版本的 pnpm 继续操作，混用会报
 * `ERR_PNPM_UNEXPECTED_STORE`。因此：
 *  - `pnpmSpec` 缺省 "pnpm@10"（GUI 自建 profile 的默认主版本）；
 *  - 非 10 主版本装到 <installDir>/pnpm-<major>/ 子目录，与默认的 pnpm 10
 *    共存，互不干扰；
 *  - 已装目录的主版本与请求不符时整目录重装。
 * @param {object} o
 * @param {string} [o.pnpmSpec] 例如 "pnpm@10" / "pnpm@12.3.4"。
 * @returns {Promise<string>} pnpm bin 目录（把该目录加到 PATH 即可让 `pnpm` 可解析）。
 */
async function ensurePnpm({ installDir, pnpmSpec = "pnpm@10", nodeExec, log = () => {}, npmCacheDir }) {
  const major = /^pnpm@(\d+)/.exec(pnpmSpec)?.[1] || "10";
  // 主版本 10 沿用既有目录布局（<installDir>/node_modules/...），其余主版本隔离
  // 到 <installDir>/pnpm-<major>/，这样同一台机器可同时服务不同 store 的 profile。
  const toolDir = major === "10" ? installDir : path.join(installDir, `pnpm-${major}`);
  const binDir = path.join(toolDir, "node_modules", ".bin");
  const pnpmMeta = path.join(toolDir, "node_modules", "pnpm", "package.json");
  const existingMajor = (() => {
    try {
      const version = JSON.parse(fs.readFileSync(pnpmMeta, "utf8")).version;
      return typeof version === "string" ? version.split(".")[0] : null;
    } catch {
      return null;
    }
  })();
  if (existingMajor === major) return binDir;
  if (existingMajor !== null) log("pnpm major changed, reinstalling:", existingMajor, "->", major);
  await fsp.rm(toolDir, { recursive: true, force: true });
  await fsp.mkdir(toolDir, { recursive: true });
  const npmCli = resolveNpmCli(nodeExec);
  if (!npmCli) throw new Error("npm CLI unavailable; cannot provision pnpm");
  await runNpm(
    nodeExec,
    npmCli,
    ["install", pnpmSpec, "--prefix", toolDir, "--no-save", "--no-audit", "--no-fund", "--loglevel", "error"],
    { log, timeoutMs: 240000, npmCacheDir },
  );
  if (!fs.existsSync(pnpmMeta)) throw new Error("pnpm provisioning failed");
  log("pnpm ready at", toolDir);
  return binDir;
}

/**
 * 该 profile 的 node_modules 由哪个 pnpm 构建（读 .modules.yaml 的
 * packageManager / pnpmVersion，如 "pnpm@12.3.4"），读不到返回 null。
 * 调用方据此选用相同主版本的 pnpm，避免 ERR_PNPM_UNEXPECTED_STORE。
 */
function readProfilePnpmManager(dshHome) {
  try {
    const raw = fs.readFileSync(
      path.join(profileDir(dshHome), "node_modules", ".modules.yaml"),
      "utf8",
    );
    // key/value 都可能带 JSON 引号：`"packageManager": "pnpm@12.3.4",`
    // 或 YAML 风格 `packageManager: pnpm@12.3.4`（旧字段 pnpmVersion 值不带前缀）。
    const m = /"?((?:packageManager|pnpmVersion))"?\s*:\s*"?(?:pnpm@)?(\d+\.\d+\.\d+)/.exec(raw);
    return m ? `pnpm@${m[2]}` : null;
  } catch {
    return null;
  }
}

/** 返回 dsh 引擎 bin 路径。 */
function engineBin({ engineDir }) {
  const bin = path.join(engineDir, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js");
  return fs.existsSync(bin) ? bin : null;
}

function profileDir(dshHome) {
  return path.join(dshHome, "profiles", "web");
}

/** 读取 profile 清单（不存在返回 null）。 */
function readProfileManifest(dshHome) {
  const file = path.join(profileDir(dshHome), "package.json");
  try {
    const raw = fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function installedBundles(dshHome) {
  const manifest = readProfileManifest(dshHome);
  const bundles = manifest?.dsh?.profile?.bundles;
  return Array.isArray(bundles) ? bundles : [];
}

/** 每个候选目录项的已装状态：bundles 登记 + profile node_modules 实存 + 安装版本。 */
function catalogStatus(dshHome) {
  const modulesRoot = path.join(profileDir(dshHome), "node_modules");
  const bundles = new Set(installedBundles(dshHome));
  const out = {};
  for (const entry of CATALOG) {
    // The materialised name in node_modules / the bundles registry is the true
    // package name (bundles never contains a `file:` spec), so compare against
    // `pkg` (== the registry name for npm entries, == the localSource package
    // name for bundled entries).
    const bundleName = entry.pkg;
    const pkgDir = path.join(modulesRoot, bundleName);
    let installed = bundles.has(bundleName) && fs.existsSync(path.join(pkgDir, "package.json"));
    let version = null;
    if (installed) {
      try {
        version = JSON.parse(fs.readFileSync(path.join(pkgDir, "package.json"), "utf8")).version ?? null;
      } catch {
        version = null;
      }
    }
    out[entry.id] = { installed, version, bundle: bundles.has(bundleName), present: fs.existsSync(pkgDir) };
  }
  return out;
}

// ---------------------------------------------------------------------------
// bundled (local-source) plugins
// ---------------------------------------------------------------------------
//
// 打包版里 `plugins/` 随 src/ 一起打进 app.asar；子进程 pnpm 把 app.asar 当作
// 一个普通文件，读不到里面的目录，所以 `pnpm add file:<app.asar 内路径>` 会报
// “as it does not exist”。Electron 主进程的 fs 能透明读 asar 路径，因此这里
// 先把捆绑插件复制成 pnpm-tools 目录下的真实文件夹（staging），再装那份拷贝。
// 开发模式（electron .）下 source 本身就在磁盘上，逻辑完全相同。

/** 仓库内捆绑插件的根目录（本进程可读：开发=真实目录，打包=app.asar 内路径）。 */
function bundledPluginsRoot() {
  return path.join(__dirname, "..", "plugins");
}

/** 某个捆绑插件条目可读的源目录。 */
function bundledSourceDir(entry) {
  return path.join(bundledPluginsRoot(), entry.localSource ?? entry.pkg);
}

/** 递归复制目录（read/readdir/stat 均可被 Electron 的 asar fs 透明处理）。 */
async function copyDirRecursive(src, dst) {
  await fsp.mkdir(dst, { recursive: true });
  const names = await fsp.readdir(src);
  for (const name of names) {
    const from = path.join(src, name);
    const to = path.join(dst, name);
    const st = await fsp.stat(from);
    if (st.isDirectory()) await copyDirRecursive(from, to);
    else await fsp.writeFile(to, await fsp.readFile(from));
  }
}

/** 读取某目录 package.json 的 version（读不到返回 null）。 */
function readPackageVersion(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")).version ?? null;
  } catch {
    return null;
  }
}

/** 读取某目录 package.json 的 name（读不到返回 null）。 */
function readPackageName(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")).name ?? null;
  } catch {
    return null;
  }
}

/** 已装插件在 profile node_modules 里的版本（未装/不可读返回 null）。 */
function installedBundleVersion(dshHome, pkg) {
  return readPackageVersion(path.join(profileDir(dshHome), "node_modules", pkg));
}

/**
 * 把捆绑插件 staging 成 <stagingRoot>/<pkg> 的真实目录并返回该目录。
 * 每次安装前都整目录刷新，保证装的是当前随应用发布的代码。staging 路径必须
 * 稳定（pnpm 会把 `file:` spec 原样写进 profile 的 dependencies，之后在该
 * profile 里再跑 pnpm 仍要能解析到这份拷贝）。
 *
 * stagingRoot 还必须不含空格：引擎把 `pnpm <args>` 用 shell 转发（Node 26 起
 * shell:true 不再转义参数），file: spec 路径里出现空格会被拆词。主进程从
 * <home>\.dsh-gui\bundled-plugins（必要时 8.3 短路径）传入；这里仅作最后防线。
 * @returns {Promise<string>} 真实 staging 目录
 */
async function stageBundledPlugin(entry, { stagingRoot, log = () => {} }) {
  const name = entry.pkg;
  const sourceDir = bundledSourceDir(entry);
  if (!fs.existsSync(path.join(sourceDir, "package.json"))) {
    throw new Error(`bundled plugin source missing: ${sourceDir}`);
  }
  const sourceName = readPackageName(sourceDir);
  if (sourceName && sourceName !== name) {
    throw new Error(`bundled plugin name mismatch: ${sourceDir} is "${sourceName}", expected "${name}"`);
  }
  const stagingDir = path.join(stagingRoot, name);
  if (/\s/u.test(stagingDir)) {
    throw new Error(
      `bundled plugin staging path contains a space (${stagingDir}); pnpm cannot install ` +
        "file: specs with spaces through the engine — use a space-free stagingRoot",
    );
  }
  await fsp.rm(stagingDir, { recursive: true, force: true });
  await copyDirRecursive(sourceDir, stagingDir);
  log("bundled plugin staged:", sourceDir, "->", stagingDir);
  return stagingDir;
}

/**
 * 运行一次 `dsh plugin --profile web <args...>`（引擎会转发给 pnpm 并 reconcile bundles）。
 * @param {object} o
 * @returns {Promise<{ok:boolean, code:number, output:string}>}
 */
function runDshPlugin({ engineDir, dshHome, pnpmBinDir, args, nodeExec, log = () => {} }) {
  return new Promise((resolve) => {
    const bin = engineBin({ engineDir });
    if (!bin) return resolve({ ok: false, code: -1, output: "engine bin missing" });
    const env = {
      ...process.env,
      ...(dshHome ? { DSH_HOME: dshHome } : {}),
      // 让引擎子命令里 spawn 的 `pnpm` 解析到自举目录（win 上 shell:true 需要 pnpm.cmd）。
      PATH: pnpmBinDir ? `${pnpmBinDir}${path.delimiter}${process.env.PATH ?? ""}` : process.env.PATH,
    };
    log("dsh plugin", ["--profile", "web", ...args].join(" "));
    const child = spawn(nodeExec, [bin, "plugin", "--profile", "web", ...args], {
      cwd: dshHome || process.cwd(),
      env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    const sink = (chunk) => {
      const text = String(chunk ?? "");
      output = (output + text).split(/\r?\n/u).slice(-20).join("\n");
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", sink);
    child.stderr.on("data", sink);
    child.on("error", (error) => resolve({ ok: false, code: -1, output: String((error && error.message) || error) }));
    child.on("close", (code) => resolve({ ok: code === 0, code: code ?? -1, output }));
  });
}

/** 安装单个包（幂等：已在 bundles 则跳过）。`pkg` 是给 pnpm 的安装 spec。 */
async function installPlugin({ engineDir, dshHome, pnpmBinDir, pkg, name, nodeExec, log = () => {} }) {
  if (installedBundles(dshHome).includes(name ?? pkg)) {
    log("plugin already installed:", name ?? pkg);
    return { ok: true, already: true };
  }
  const res = await runDshPlugin({ engineDir, dshHome, pnpmBinDir, args: ["add", pkg], nodeExec, log });
  if (!res.ok) log("plugin install failed:", pkg, res.output);
  return res;
}

/** 移除单个包。 */
async function removePlugin({ engineDir, dshHome, pnpmBinDir, pkg, nodeExec, log = () => {} }) {
  const res = await runDshPlugin({ engineDir, dshHome, pnpmBinDir, args: ["remove", pkg], nodeExec, log });
  if (!res.ok) log("plugin remove failed:", pkg, res.output);
  return res;
}

/**
 * 启动时对账（每次引擎启动前 + 设置页手动同步时调用）：
 *  - 引擎兼容性门控：目录条目声明了 engineRange 且不满足当前引擎版本时——
 *      * 未装且被勾选：不安装，结果记入 result.skipped（避免装完即崩）；
 *      * 已装且被 GUI 勾选：启动前自动移除（GUI 管理的插件，移除仍走引擎的
 *        `dsh plugin remove`），结果记入 result.removed，调用方清勾选；
 *      * 已装但非 GUI 勾选（市场手动装/已取消勾选保留）：**不静默清理**，
 *        保留给“启动失败诊断”弹窗，由用户知情后点「禁用并重启」才移除，
 *        避免 GUI 误删用户自己装的同名插件。
 *  - 幂等：已装且版本未变则跳过；捆绑插件随新版本应用更新而变时会自动
 *    重新安装（先 remove 再 add，保证 profile 里的拷贝跟上随包发布的代码）。
 *  - 其余情况不做自动卸载——取消勾选只是“下次启动不再自动装”，已经装的插件
 *    保留（用户可在 dsh-market 或 `dsh plugin remove` 里手动移除）。
 *  - 捆绑（localSource）插件从不直接指向 app.asar 内的源目录安装：先 staging
 *    成真实目录（pnpm 子进程读不到 app.asar 内部），再装那份。
 * @param {object} o
 * @param {string} [o.stagingRoot] 捆绑插件的 staging 根目录。默认取
 *   <pnpmInstallDir>/bundled-plugins；主进程应传入无空格的路径（见 stageBundledPlugin）。
 * @returns {Promise<{installed:string[], removed:string[], skipped:string[], errors:string[]}>}
 */
async function syncEnabledPlugins({ enabledIds, engineDir, dshHome, nodeExec, pnpmInstallDir, stagingRoot, log = () => {} }) {
  const result = { installed: [], removed: [], skipped: [], errors: [] };
  const enabled = new Set((enabledIds ?? []).filter((id) => CATALOG_IDS.has(id)));
  let pnpmBinDir = null;
  // 用「构建该 profile node_modules 的 pnpm 主版本」操作它（marketplace 可能用
  // pnpm 12 建过，混用 pnpm 10 会 ERR_PNPM_UNEXPECTED_STORE）；新 profile 无
  // node_modules 时回落到默认 pnpm@10。
  const pnpmSpec = readProfilePnpmManager(dshHome) ?? "pnpm@10";
  try {
    pnpmBinDir = await ensurePnpm({ installDir: pnpmInstallDir, pnpmSpec, nodeExec, log });
  } catch (error) {
    result.errors.push(`pnpm provisioning failed: ${(error && error.message) || error}`);
    log("pnpm provisioning failed:", error);
    return result;
  }
  // 捆绑插件 staging 根目录（保持稳定：pnpm 会把 `file:` spec 原样写进 profile
  // 的 dependencies，之后在该 profile 里再跑 pnpm 仍需能解析到同一路径）。
  const bundledStagingRoot = stagingRoot ?? path.join(pnpmInstallDir, "bundled-plugins");
  const engineVersion = readEngineVersion(engineDir);
  for (const entry of CATALOG) {
    const name = entry.pkg;
    const has = installedBundles(dshHome).includes(name);
    const compatible = engineSatisfies(entry, engineVersion);

    // 引擎不兼容：绝不安装。
    if (!compatible) {
      if (!has) {
        if (enabled.has(entry.id)) {
          result.skipped.push(entry.id);
          log("plugin skipped (engine incompatible):", name, "engine", engineVersion, "needs", entry.engineRange);
        }
        continue;
      }
      if (enabled.has(entry.id)) {
        // GUI 勾选管理的目录插件：它在当前引擎上会让启动崩溃，启动前自动移除
        // 并清勾选（结果记入 removed）。来源无法 100% 区分（同 npm 包名可能也
        // 是用户通过 dsh-market 手动装的），所以只对“GUI 自己勾选过”的做静默
        // 移除；移除动作本身仍走引擎的 `dsh plugin remove`（与市场一致）。
        try {
          const rm = await removePlugin({ engineDir, dshHome, pnpmBinDir, pkg: name, nodeExec, log });
          if (rm.ok) {
            result.removed.push(entry.id);
            log("plugin removed (engine incompatible):", name, "engine", engineVersion, "needs", entry.engineRange);
          } else {
            result.errors.push(`${name}: remove failed (${rm.output.slice(-160)})`);
          }
        } catch (error) {
          result.errors.push(`${name}: ${(error && error.message) || error}`);
        }
      } else {
        // 非 GUI 勾选（市场手动装、或用户已取消勾选但保留）：不静默清理。
        // 若它确实让引擎启动崩溃，走既有的“启动失败诊断”弹窗，由用户点
        // 「禁用并重启」后才会移除（带日志与知情同意）。
        log("engine-incompatible plugin left in place (not GUI-managed):", name, "engine", engineVersion, "needs", entry.engineRange);
      }
      continue;
    }

    if (!enabled.has(entry.id)) continue;
    // 捆绑插件随应用更新：安装的版本落后于随包发布的源版本时强制重装。
    let wantsUpdate = false;
    if (has && entry.localSource) {
      const sourceVersion = readPackageVersion(bundledSourceDir(entry));
      const installedVersion = installedBundleVersion(dshHome, name);
      wantsUpdate = Boolean(sourceVersion && installedVersion && sourceVersion !== installedVersion);
      if (wantsUpdate) log("bundled plugin version changed:", name, installedVersion, "->", sourceVersion);
    }
    if (has && !wantsUpdate) continue;
    try {
      // 先准备好可安装的 spec（捆绑插件先 staging 成真实目录——子进程 pnpm
      // 读不到 app.asar 内部路径；npm 条目按目录声明的 version 固定），再做
      // remove/add，失败时不至于先拆了旧的。
      const spec = entry.localSource
        ? `file:${await stageBundledPlugin(entry, { stagingRoot: bundledStagingRoot, log })}`
        : registrySpec(entry);
      if (wantsUpdate) {
        const rm = await removePlugin({ engineDir, dshHome, pnpmBinDir, pkg: name, nodeExec, log });
        if (!rm.ok) {
          result.errors.push(`${name}: remove failed (${rm.output.slice(-160)})`);
          continue;
        }
      }
      const res = await installPlugin({ engineDir, dshHome, pnpmBinDir, pkg: spec, name, nodeExec, log });
      if (res.ok) result.installed.push(entry.id);
      else result.errors.push(`${name}: ${res.output.slice(-200)}`);
    } catch (error) {
      result.errors.push(`${name}: ${(error && error.message) || error}`);
    }
  }
  return result;
}

module.exports = {
  CATALOG,
  CATALOG_IDS,
  catalogByPkg,
  catalogEngineCompat,
  readEngineVersion,
  readProfilePnpmManager,
  ensurePnpm,
  engineBin,
  profileDir,
  readProfileManifest,
  installedBundles,
  catalogStatus,
  runDshPlugin,
  installPlugin,
  removePlugin,
  syncEnabledPlugins,
};
