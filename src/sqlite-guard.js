'use strict';

/**
 * node:sqlite 前置检查（启动即拦截，别让用户去读模块堆栈）
 *
 * 历史坑：Node 22.12 还没有 node:sqlite（实测报 ERR_UNKNOWN_BUILTIN_MODULE），
 * 但文档常写「22.5+」，实际门槛是 22.13+。这里在入口处主动探测，
 * 缺失时给出一句话修复指引并以退出码 1 结束。
 *
 * 用法：const { loadSqlite } = require('./sqlite-guard'); const { DatabaseSync } = loadSqlite();
 */

const MIN_MAJOR = 22;
const MIN_MINOR = 13; // 22.12 实测无 node:sqlite

function currentVersion() {
  return `v${process.versions.node}`;
}

function isSupported() {
  const [major, minor] = process.versions.node.split('.').map((n) => Number(n));
  if (Number.isNaN(major) || Number.isNaN(minor)) return true; // 版本号异常时不拦，交给真报错
  if (major > MIN_MAJOR) return true;
  return major === MIN_MAJOR && minor >= MIN_MINOR;
}

function fail(stream) {
  const out = stream || process.stderr;
  out.write(
    [
      '',
      '✖ taskcli 需要 Node.js >= 22.13（内置模块 node:sqlite）',
      `  当前版本：${currentVersion()}`,
      '',
      '  修复任选其一：',
      '    1. 升级 Node 到 22.13+ / 24.x / 26.x（推荐 nvm 或 brew upgrade node）',
      '    2. 用已装的新版本直接跑：',
      '       /opt/homebrew/bin/node /path/to/taskcli/bin/taskcli ...',
      '',
    ].join('\n')
  );
}

/**
 * 返回 { DatabaseSync }；不可用时打印指引并退出（不抛栈）。
 */
function loadSqlite() {
  try {
    return require('node:sqlite');
  } catch (err) {
    if (err && err.code === 'ERR_UNKNOWN_BUILTIN_MODULE') {
      fail();
      process.exit(1);
    }
    throw err;
  }
}

module.exports = { loadSqlite, isSupported, currentVersion, MIN_MAJOR, MIN_MINOR };