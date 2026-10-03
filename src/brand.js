'use strict';

/**
 * 品牌与路径解析（TaskToAgent，命令 t2a）。
 *
 * 2026-10-03 由 taskcli 改名而来。改名遵循「一次改到位、旧名不失效」原则：
 *   - 产品名：TaskToAgent（展示用）
 *   - 命令名：t2a（日常手敲），taskcli 保留为兼容别名
 *   - 数据目录：~/.t2a/t2a.db；旧目录 ~/.taskcli 会被自动沿用（不搬动用户数据）
 *   - 环境变量：T2A_* 优先，TASKCLI_* 继续被识别（老脚本/MCP 配置不会断）
 *
 * 集中放在这里，是为了让「名字」只有一个真相来源，日后再次改名只改本文件。
 */

const os = require('os');
const fs = require('fs');
const path = require('path');

/** 产品名（文档、标题、doctor 抬头） */
const PRODUCT = 'TaskToAgent';

/** 一句话定位 */
const TAGLINE = '本地任务看板 —— 任务分发给 agent 的调度中枢';

/** 主命令名 */
const CMD = 't2a';

/** 旧命令名，保留兼容 */
const LEGACY_CMD = 'taskcli';

/** 数据目录名（新） */
const HOME_DIRNAME = '.t2a';

/** 旧数据目录名（仅用于沿用与提示，不主动搬动） */
const LEGACY_HOME_DIRNAME = '.taskcli';

const HOME_DIR = path.join(os.homedir(), HOME_DIRNAME);
const LEGACY_HOME_DIR = path.join(os.homedir(), LEGACY_HOME_DIRNAME);

/**
 * 读环境变量：新名优先，旧名兜底。
 * 例：env('DB', 'PORT') => T2A_DB ?? TASKCLI_DB
 */
function env(key) {
  const up = key.toUpperCase();
  return process.env[`T2A_${up}`] || process.env[`TASKCLI_${up}`] || '';
}

/**
 * 解析数据目录：
 *   1. T2A_DB / TASKCLI_DB 显式指定 -> 直接用它
 *   2. 旧目录 ~/.taskcli 已存在且新目录还没有 -> 沿用旧目录（避免「数据消失」）
 *   3. 否则用新目录 ~/.t2a（自动创建）
 *
 * 返回 { dir, legacy }：legacy=true 表示当前在用旧目录，供库文件名对齐与提示使用。
 */
function resolveHome() {
  if (env('DB')) return { dir: path.dirname(path.resolve(env('DB'))), legacy: false };
  let legacyHasData = false;
  try {
    legacyHasData = fs.readdirSync(LEGACY_HOME_DIR).some((f) => f.endsWith('.db'));
  } catch {
    legacyHasData = false;
  }
  if (!fs.existsSync(HOME_DIR) && legacyHasData) return { dir: LEGACY_HOME_DIR, legacy: true };
  fs.mkdirSync(HOME_DIR, { recursive: true });
  return { dir: HOME_DIR, legacy: false };
}

function resolveHomeDir() {
  return resolveHome().dir;
}

/**
 * 解析数据库文件路径。
 * 沿用旧目录时优先继续使用旧库文件（如 ~/.taskcli/taskcli.db），
 * 避免「目录沿用了、库名却变了」导致读到空库。
 */
function resolveDbPath() {
  const explicit = env('DB');
  if (explicit) return explicit;
  const { dir, legacy } = resolveHome();
  const legacyDb = path.join(dir, 'taskcli.db');
  if (legacy && fs.existsSync(legacyDb)) return legacyDb;
  return path.join(dir, 't2a.db');
}

/** 解析配置文件路径 */
function resolveConfigPath() {
  const explicit = env('CONFIG');
  if (explicit) return explicit;
  return path.join(resolveHomeDir(), 'config.json');
}

/** 网页服务端口 */
function resolvePort() {
  return Number(env('PORT') || 3979);
}

/**
 * 文档/提示里的命令写法：新名开头，括号里带上旧名。
 * 用在 usageError / hint 等面向人的文案里。
 */
function cmd(text) {
  return `${CMD} ${text}`;
}

module.exports = {
  PRODUCT,
  TAGLINE,
  CMD,
  LEGACY_CMD,
  HOME_DIRNAME,
  HOME_DIR,
  LEGACY_HOME_DIRNAME,
  LEGACY_HOME_DIR,
  env,
  resolveHome,
  resolveHomeDir,
  resolveDbPath,
  resolveConfigPath,
  resolvePort,
  cmd,
};