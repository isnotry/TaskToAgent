'use strict';

/**
 * 本地配置（~/.t2a/config.json，可用 T2A_CONFIG 覆盖）。
 *
 * 存在的理由：agent 名字总被填错（例如一律填 codebuddy）。靠提示不可靠，
 * 这里提供两级机制：
 *   1) agent：默认身份，CLI / MCP 都没显式指定时用它；
 *   2) agentAliases：错误名 → 正确名的映射，填错也会被自动纠正。
 */

const fs = require('fs');
const path = require('path');
const { resolveConfigPath, env } = require('./brand');

const CONFIG_PATH = resolveConfigPath();

const DEFAULTS = { agent: '', agentAliases: {} };

function load() {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    const obj = JSON.parse(raw);
    return { ...DEFAULTS, ...(obj || {}) };
  } catch {
    return { ...DEFAULTS };
  }
}

function save(patch) {
  const cur = load();
  const next = { ...cur, ...(patch || {}) };
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2) + '\n');
  return next;
}

function get(key) {
  return load()[key];
}

function set(key, value) {
  return save({ [key]: value });
}

/**
 * 规范化 agent 名：命中别名表则纠正。
 * 返回 { name, corrected, from }
 */
function normalizeAgent(name) {
  const cfg = load();
  const map = cfg.agentAliases || {};
  const hit = map[name];
  if (hit && hit !== name) return { name: String(hit), corrected: true, from: String(name) };
  return { name: String(name || ''), corrected: false };
}

/** 默认身份：env T2A_AGENT（兼容 TASKCLI_AGENT） > 配置 agent > 'agent' */
function defaultAgent() {
  const fromEnv = env('AGENT');
  if (fromEnv) return String(fromEnv);
  const a = load().agent;
  return a ? String(a) : 'agent';
}

module.exports = { CONFIG_PATH, load, save, get, set, normalizeAgent, defaultAgent };
