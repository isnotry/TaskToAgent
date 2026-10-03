import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';

/**
 * 界面文案国际化（中英双语）。
 *
 * 为什么单独一个文件：文案集中一处，改语言只改这张表；
 * 组件里一律用useI18n() 取 t()，不散落三元表达式。
 *
 * 语言判定优先级：
 *   1. localStorage里用户手动选过的（t2a-lang）
 *   2. 浏览器语言（navigator.language，zh-* 视为中文，其余视为英文）
 *   3. 兜底中文（项目主语言）
 */
const LANG_KEY = 't2a-lang';
export const LANGS = [
  { value: 'zh', label: '简体中文' },
  { value: 'en', label: 'English' },
];

const DICT = {
  zh: {
    // 状态 / 优先级（列名、标签、详情共用）
    status: {
      idea: '灵感区',
      todo: '待办',
      doing: '进行中',
      blocked: '阻塞',
      review: '待验收',
      done: '已完成',
      archive: '存档',
    },
    priority: { low: '低', normal: '普通', high: '高' },

    // 通用
    loading: '加载中…',
    cancel: '取消',
    add: '添加',
    save: '保存',
    edit: '编辑',
    delete: '删除',
    rename: '重命名',
    name: '名称',
    title: '标题',
    content: '内容',
    description: '描述',
    optional: '可选',
    settings: '设置',
    search: '搜索',

    // 侧栏
    boards: '看板',
    newBoard: '新建看板',
    collapseSidebar: '收起侧栏',
    showProjectList: '显示项目列表',
    collapseProjectList: '收起项目列表',
    noBoards: '还没有项目',
    deleteBoardConfirm: '删除该项目及其任务？',
    taskCount: '{n} 个任务',
    loading: '加载中…',
    renameBoard: '重命名',
    collapseTaskList: '收起任务清单',
    expandTaskList: '展开任务清单',
    repoLink: 'GitHub 开源仓库',

    // 任务
    newTask: '新建任务',
    editTask: '编辑任务',
    newTaskTitle: '新建任务',
    taskTitle: '任务标题',
    taskTitlePlaceholder: '输入任务标题，回车添加',
    taskContent: '任务内容',
    searchTasksTooltip: '搜索任务（编号 / 标题 / 内容 / 项目）',
    searchPlaceholder: '模糊搜索任务（编号 / 标题 / 内容 / 项目）',
    noProjectSelected: '未选择项目',
    pickProject: '请选择左侧项目，或新建一个看板',
    emptyBoard: '这个看板还没有任务',
    noSearchResult: '没有匹配的任务',
    searchResults: '搜索结果',
    searching: '搜索中…',
    countSuffix: '({n} 条)',
    searchAgain: '重新搜索',
    addInGroup: '在此分组添加任务',
    addInColumn: '在此列添加任务',
    moveToGroup: '移动到其他分组',
    moveToPanel: '移动到其他面板',
    deleteTaskConfirm: '删除该任务？',
    status: '状态',
    priority: '优先级',
    noErrorDetail: '尚无错误详情',
    expiredSuffix: '超时',
    leaseExpiredTip: '租约已过期，随时会被回收',
    leaseHeldTip: '由 {who} 持有至 {when}',

    // 任务详情
    createdAt: '创建',
    updatedAt: '更新',
    assignee: '认领人',
    leaseExpiredTag: '（租约超时）',
    failedTimes: '失败 {n} 次',
    lastError: '最近错误：',
    result: '产出：',
    tracks: '跟踪记录',
    noTracks: '暂无跟踪记录',
    addTrackPlaceholder: '添加一条跟踪记录，回车提交',

    // 复制
    copyCode: '点击复制任务编号',
    copiedCode: '已复制编号 {code}',
    copyFailed: '复制失败，请手动选择复制',
    requestFailed: '请求失败 ({status})',

    // 设置菜单
    theme: '主题',
    light: '浅色',
    dark: '深色',
    viewMode: '任务列表展现形式',
    viewBoard: '竖版看板',
    viewList: '横版分组',
    viewBoardHint: '竖版：状态列并排，适合宽屏。',
    viewListHint: '横版：按状态分组、组内列表，整行可点，手机更顺手。',
    viewNarrowHint: ' 手机上建议用横版。',
    language: '界面语言',
    sync: '数据同步',
    lastSync: '上次同步 {time}',
    syncing: '实时同步中，正在建立连接',
    syncHint: '数据有变化时才刷新（服务端每秒探测一次），没变化不会打扰。',

    // 提示消息
    needProjectName: '请输入项目名',
    renamed: '已重命名',
    boardCreated: '已创建项目',
    boardDeleted: '已删除项目',
    needProjectFirst: '请先选择或创建项目',
    needTitle: '请输入标题',
    updated: '已更新',
    added: '已添加',
    deleted: '已删除',
    trackAdded: '已添加跟踪记录',

    // 页面标题
    docTitle: 'TaskToAgent · 任务看板',
  },

  en: {
    status: {
      idea: 'Ideas',
      todo: 'Todo',
      doing: 'In progress',
      blocked: 'Blocked',
      review: 'In review',
      done: 'Done',
      archive: 'Archive',
    },
    priority: { low: 'Low', normal: 'Normal', high: 'High' },

    loading: 'Loading…',
    cancel: 'Cancel',
    add: 'Add',
    save: 'Save',
    edit: 'Edit',
    delete: 'Delete',
    rename: 'Rename',
    name: 'Name',
    title: 'Title',
    content: 'Content',
    description: 'Description',
    optional: 'optional',
    settings: 'Settings',
    search: 'Search',

    boards: 'Boards',
    newBoard: 'New board',
    collapseSidebar: 'Collapse sidebar',
    showProjectList: 'Show board list',
    collapseProjectList: 'Collapse board list',
    noBoards: 'No boards yet',
    deleteBoardConfirm: 'Delete this board and all its tasks?',
    taskCount: '{n} tasks',
    renameBoard: 'Rename board',
    collapseTaskList: 'Collapse task list',
    expandTaskList: 'Expand task list',
    repoLink: 'Open source on GitHub',

    newTask: 'New task',
    editTask: 'Edit task',
    newTaskTitle: 'New task',
    taskTitle: 'Task title',
    taskTitlePlaceholder: 'Task title, press Enter to add',
    taskContent: 'Task content',
    searchTasksTooltip: 'Search tasks (code / title / content / board)',
    searchPlaceholder: 'Fuzzy search (code / title / content / board)',
    noProjectSelected: 'No board selected',
    pickProject: 'Pick a board on the left, or create a new one',
    emptyBoard: 'This board has no tasks yet',
    noSearchResult: 'No matching tasks',
    searchResults: 'Search results',
    searching: 'searching…',
    countSuffix: '({n})',
    searchAgain: 'Search again',
    addInGroup: 'Add a task to this group',
    addInColumn: 'Add a task to this column',
    moveToGroup: 'Move to another group',
    moveToPanel: 'Move to another column',
    deleteTaskConfirm: 'Delete this task?',
    status: 'Status',
    priority: 'Priority',
    noErrorDetail: 'No error details',
    expiredSuffix: 'expired',
    leaseExpiredTip: 'Lease expired, may be reclaimed at any time',
    leaseHeldTip: 'Held by {who} until {when}',

    createdAt: 'Created',
    updatedAt: 'Updated',
    assignee: 'Assignee',
    leaseExpiredTag: ' (lease expired)',
    failedTimes: 'Failed {n}x',
    lastError: 'Last error: ',
    result: 'Result:',
    tracks: 'Activity',
    noTracks: 'No activity yet',
    addTrackPlaceholder: 'Add a note, press Enter to submit',

    copyCode: 'Click to copy the task code',
    copiedCode: 'Copied code {code}',
    copyFailed: 'Copy failed, please copy it manually',
    requestFailed: 'Request failed ({status})',

    theme: 'Theme',
    light: 'Light',
    dark: 'Dark',
    viewMode: 'Task list layout',
    viewBoard: 'Board',
    viewList: 'Grouped list',
    viewBoardHint: 'Board: status columns side by side, best on wide screens.',
    viewListHint: 'Grouped: tasks grouped by status, whole rows clickable, better on phones.',
    viewNarrowHint: ' Grouped view is recommended on phones.',
    language: 'Language',
    sync: 'Data sync',
    lastSync: 'Last synced {time}',
    syncing: 'Connecting for live updates',
    syncHint: 'Refreshes only when data changes (the server polls once a second).',

    needProjectName: 'Please enter a board name',
    renamed: 'Renamed',
    boardCreated: 'Board created',
    boardDeleted: 'Board deleted',
    needProjectFirst: 'Please select or create a board first',
    needTitle: 'Please enter a title',
    updated: 'Updated',
    added: 'Added',
    deleted: 'Deleted',
    trackAdded: 'Note added',

    docTitle: 'TaskToAgent · Task Board',
  },
};

function detectLang() {
  try {
    const saved = localStorage.getItem(LANG_KEY);
    if (saved === 'zh' || saved === 'en') return saved;
  } catch {
    /* localStorage 不可用则继续往下走 */
  }
  try {
    const nav = navigator.language || '';
    return /^zh/i.test(nav) ? 'zh' : 'en';
  } catch {
    return 'zh';
  }
}

const I18nContext = createContext(null);

// React 树外也能取文案的入口（如模块级的 request() 错误提示）。
// I18nProvider 每次渲染都会把当前 t 写进来，所以这里读到的永远是当前语言。
let tRef = (key) => DICT.zh[key] ?? key;

/** 在 React 组件树之外取文案（函数、事件回调等非组件作用域）。 */
export function t(key, vars) {
  let out = tRef(key);
  if (vars) {
    for (const k of Object.keys(vars)) out = out.split(`{${k}}`).join(String(vars[k]));
  }
  return out;
}

/**
 * 语言提供者。挂在 App 最外层，供所有子组件通过 useI18n() 取文案。
 * 切换语言时同步 <html lang>（影响浏览器翻译提示与无障碍阅读）与页面标题。
 */
export function I18nProvider({ children }) {
  const [lang, setLang] = useState(detectLang);

  useEffect(() => {
    try {
      localStorage.setItem(LANG_KEY, lang);
    } catch {
      /* 忽略写入失败（隐私模式等） */
    }
    document.documentElement.setAttribute('lang', lang === 'zh' ? 'zh-CN' : 'en');
    document.title = DICT[lang].docTitle;
  }, [lang]);

  const value = useMemo(() => {
    const dict = DICT[lang];
    /**
     * 取文案并做 {n} 占位替换。
     * 用例：t('taskCount', { n: 3 }) →「3 个任务」/ "3 tasks"
     */
    const t = (key, vars) => {
      let out = dict[key];
      if (out === undefined) return key;
      if (vars) {
        for (const k of Object.keys(vars)) {
          out = out.split(`{${k}}`).join(String(vars[k]));
        }
      }
      return out;
    };
    // 同步给 React 树外的 t() 用（模块级函数拿不到 context）
    tRef = t;
    return { lang, setLang, t, dict };
  }, [lang]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n() {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error('useI18n 必须在 <I18nProvider> 内部使用');
  return ctx;
}

/**
 * 状态 / 优先级标签：把字典里的 label 与固定颜色合成 { label, color } 结构，
 * 形状与纯中文时代完全一致 —— 这样 JSX 里所有 `STATUS_META[s].label`
 * 的写法一行都不用改，只有文案会随语言变。
 */
const STATUS_COLOR = {
  idea: 'orange',
  todo: 'gray',
  doing: 'arcoblue',
  blocked: 'red',
  review: 'purple',
  done: 'green',
  archive: 'gray',
};
const PRIORITY_COLOR = { low: 'gray', normal: 'arcoblue', high: 'red' };

/** 把字典里的 label 与固定颜色合成 { label, color } 结构。 */
function buildMeta(dict) {
  const STATUS_META = {};
  for (const k of Object.keys(STATUS_COLOR)) {
    STATUS_META[k] = { label: dict.status[k] || k, color: STATUS_COLOR[k] };
  }
  const PRIORITY_META = {};
  for (const k of Object.keys(PRIORITY_COLOR)) {
    PRIORITY_META[k] = { label: dict.priority[k] || k, color: PRIORITY_COLOR[k] };
  }
  return { STATUS_META, PRIORITY_META };
}

export function useMeta() {
  const { dict } = useI18n();
  return useMemo(() => buildMeta(dict), [dict]);
}
