import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Layout,
  Button,
  Input,
  Select,
  Modal,
  Card,
  Tag,
  Typography,
  Space,
  Empty,
  Popconfirm,
  Message,
  Tooltip,
  Dropdown,
  Menu,
  Drawer,
  Popover,
  Radio,
  Divider,
} from '@arco-design/web-react';
import {
  IconPlus,
  IconEdit,
  IconDelete,
  IconRefresh,
  IconSwap,
  IconMoon,
  IconSun,
  IconUp,
  IconDown,
  IconSearch,
  IconMenu,
  IconMenuFold,
  IconRight,
  IconUser,
  IconSettings,
} from '@arco-design/web-react/icon';

const { Sider, Content, Header } = Layout;
const { Title, Text, Paragraph } = Typography;
const { Group: RadioGroup } = Radio;

const STATUS_META = {
  idea: { label: '灵感区', color: 'orange' },
  todo: { label: '待办', color: 'gray' },
  doing: { label: '进行中', color: 'arcoblue' },
  blocked: { label: '阻塞', color: 'red' },
  review: { label: '待验收', color: 'purple' },
  done: { label: '已完成', color: 'green' },
  archive: { label: '存档', color: 'gray' },
};
const PRIORITY_META = {
  low: { label: '低', color: 'gray' },
  normal: { label: '普通', color: 'arcoblue' },
  high: { label: '高', color: 'red' },
};
// 列顺序：灵感区(第一) → 待办/进行中 → 阻塞/待验收 → 已完成 → 存档(最后)
const COLUMNS = ['idea', 'todo', 'doing', 'blocked', 'review', 'done', 'archive'];

// agent 认领后持有租约，到期未续租说明该 agent 大概率已中断
const leaseExpired = (t) => !!t.lease_until && Number(t.lease_until) < Date.now();

// 侧栏任务列表用的小圆点颜色（比 Tag 更紧凑，一行能放下更多任务）
const STATUS_DOT = {
  idea: '#f7a51a',
  todo: '#86909c',
  doing: '#165dff',
  blocked: '#f53f3f',
  review: '#722ed1',
  done: '#00b42a',
  archive: '#c9cdd4',
};

const BASE = '';

// 布局偏好（左侧栏收起 + 各面板折叠）统一存在这一个 key 下：
// { v: 版本号, sider: boolean | null, cols: { [projectId]: { [status]: boolean } } }
// null / undefined 均表示"用户没手动设置过"，按默认规则推导。
const LAYOUT_KEY = 't2a-ui-layout';
// 2026-10-03 由 taskcli 改名为 TaskToAgent：旧 key 仍读一次，迁移到新 key 后删旧，
// 这样老用户的主题/布局偏好不会因为改名而丢失。
const LEGACY_KEYS = ['taskcli-ui-layout', 'taskcli-ui-view', 'taskcli-theme'];
function readPref(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
// 依次查新 key -> 旧 key（命中旧 key 时顺手搬到新 key）
function readPrefMigrated(key) {
  let v = readPref(key);
  if (v !== null) return v;
  for (const lk of LEGACY_KEYS) {
    const old = readPref(lk);
    if (old !== null) {
      try {
        localStorage.setItem(key, old);
      } catch {}
      return old;
    }
  }
  return null;
}
// 布局结构或默认行为发生变更时 +1：旧记录版本不匹配会被整体丢弃，
// 避免历史遗留的偏好（比如"侧栏收起"）在新默认下继续生效。
const LAYOUT_VERSION = 2;
const EMPTY_LAYOUT = { sider: null, cols: {} };
function readLayout() {
  try {
    const raw = readPrefMigrated(LAYOUT_KEY);
    if (!raw) return { ...EMPTY_LAYOUT };
    const v = JSON.parse(raw);
    if (!v || typeof v !== 'object') return { ...EMPTY_LAYOUT };
    if (v.v !== LAYOUT_VERSION) return { ...EMPTY_LAYOUT };
    return {
      sider: typeof v.sider === 'boolean' ? v.sider : null,
      cols: v.cols && typeof v.cols === 'object' ? v.cols : {},
    };
  } catch {
    return { ...EMPTY_LAYOUT };
  }
}
function writeLayout(layout) {
  try {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify({ ...layout, v: LAYOUT_VERSION }));
  } catch {}
}

// 复制文本：优先用异步剪贴板 API，非安全上下文（如 http 访问）回退到 execCommand
async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* 继续走兜底方案 */
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.top = '0';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

// 可点击复制的任务编号：同一份渲染在看板卡片与搜索结果里复用
const codeChipStyle = {
  fontSize: 11,
  padding: '1px 6px',
  borderRadius: 4,
  background: 'var(--color-fill-2)',
  color: 'var(--color-text-3)',
  cursor: 'pointer',
  userSelect: 'none',
  flexShrink: 0,
};
function TaskCode({ code }) {
  const onClick = async (e) => {
    e.stopPropagation();
    const ok = await copyText(code);
    if (ok) Message.success(`已复制编号 ${code}`);
    else Message.error('复制失败，请手动选择复制');
  };
  return (
    <Tooltip content="点击复制任务编号">
      <span style={codeChipStyle} onClick={onClick}>
        {code}
      </span>
    </Tooltip>
  );
}

async function request(method, url, body) {
  const res = await fetch(BASE + url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = {};
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = {};
    }
  }
  if (!res.ok) throw new Error(data.error || `请求失败 (${res.status})`);
  return data;
}

const api = {
  listProjects: () => request('GET', '/api/projects'),
  createProject: (name, description) =>
    request('POST', '/api/projects', { name, description }),
  renameProject: (id, name) => request('PATCH', `/api/projects/${id}`, { name }),
  deleteProject: (id) => request('DELETE', `/api/projects/${id}`),
  listTasks: (pid) => request('GET', `/api/projects/${pid}/tasks`),
  createTask: (pid, body) => request('POST', `/api/projects/${pid}/tasks`, body),
  updateTask: (id, body) => request('PATCH', `/api/tasks/${id}`, body),
  deleteTask: (id) => request('DELETE', `/api/tasks/${id}`),
  listTracks: (tid) => request('GET', `/api/tasks/${tid}/tracks`),
  addTrack: (tid, content) => request('POST', `/api/tasks/${tid}/tracks`, { content }),
  deleteTrack: (id) => request('DELETE', `/api/tracks/${id}`),
  search: (q) => request('GET', `/api/search?q=${encodeURIComponent(q)}`),
};

// 表单字段：label 独占一行并与控件留出间距，避免上下挤在一起
function Field({ label, children }) {
  return (
    <div>
      <div style={{ marginBottom: 6, fontSize: 13, color: 'var(--color-text-2)' }}>{label}</div>
      {children}
    </div>
  );
}

// 项目列表（左侧栏 / 抽屉共用同一份渲染，避免两处样式走样）
// 行为：点行主体 = 切换看板；点行内箭头 = 就地展开该项目的任务清单，
// 再点某个任务 = 切到该看板并直接展开这条任务的详情（含跟踪记录）。
function ProjectSidebar({
  projects,
  selectedId,
  onSelect,
  onNew,
  onRename,
  onDelete,
  onCollapse,
  expandedId,
  onToggleExpand,
  sidebarTasks,
  loadingTasksOf,
  onOpenTask,
}) {
  const [hoverId, setHoverId] = useState(null);
  return (
    <>
      <div
        style={{
          padding: '18px 16px 14px 20px',
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
        }}
      >
        <Title heading={5} style={{ margin: 0 }}>
          看板
        </Title>
        <Space size={4}>
          {/* 新建看板：与顶栏、列头一致，只用加号图标 + 悬停提示 */}
          <Tooltip content="新建看板">
            <Button
              type="primary"
              size="small"
              shape="circle"
              icon={<IconPlus />}
              aria-label="新建看板"
              onClick={onNew}
            />
          </Tooltip>
          {onCollapse && (
            <Tooltip content="收起侧栏">
              <Button size="small" type="text" icon={<IconMenuFold />} onClick={onCollapse} />
            </Tooltip>
          )}
        </Space>
      </div>
      <div style={{ overflowY: 'auto', flex: 1, minHeight: 0, paddingBottom: 16 }}>
        {projects.length === 0 && <Empty style={{ marginTop: 40 }} description="还没有项目" />}
        {projects.map((p) => {
          const active = p.id === selectedId;
          const open = expandedId === p.id;
          const rows = sidebarTasks[p.id];
          const rowBg = active
            ? 'var(--color-fill-2)'
            : hoverId === p.id
            ? 'var(--color-fill-1)'
            : 'transparent';
          return (
            <div key={p.id}>
              <div
                onClick={() => onSelect(p.id)}
                onMouseEnter={() => setHoverId(p.id)}
                onMouseLeave={() => setHoverId(null)}
                style={{
                  padding: '12px 12px 12px 8px',
                  cursor: 'pointer',
                  background: rowBg,
                  borderLeft: `3px solid ${active ? 'var(--primary-6)' : 'transparent'}`,
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    gap: 8,
                  }}
                >
                  {/* 展开箭头：与"切换看板"分开，避免误点导致看板跳走 */}
                  <span
                    onClick={(e) => {
                      e.stopPropagation();
                      onToggleExpand(p.id);
                    }}
                    title={open ? '收起任务清单' : '展开任务清单'}
                    style={{
                      flexShrink: 0,
                      width: 18,
                      height: 18,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      borderRadius: 4,
                      cursor: 'pointer',
                      color: 'var(--color-text-3)',
                      background: open ? 'var(--color-fill-3)' : 'transparent',
                      // 项目名换行时箭头与首行对齐
                      marginTop: 1,
                    }}
                  >
                    {open ? <IconDown /> : <IconRight />}
                  </span>
                  {/* 项目名：先完整显示，放不下才换行（侧栏空间有限，换行优于省略号看不清）*/}
                  <Text
                    bold={active}
                    style={{
                      flex: 1,
                      minWidth: 0,
                      overflowWrap: 'anywhere',
                      lineHeight: '20px',
                    }}
                  >
                    {p.name}
                  </Text>
                  <Space size={4}>
                    <Tooltip content="重命名">
                      <Button
                        size="mini"
                        type="text"
                        icon={<IconEdit />}
                        onClick={(e) => {
                          e.stopPropagation();
                          onRename(p);
                        }}
                      />
                    </Tooltip>
                    <Popconfirm title="删除该项目及其任务？" onOk={() => onDelete(p)}>
                      <Button
                        size="mini"
                        type="text"
                        status="danger"
                        icon={<IconDelete />}
                        onClick={(e) => e.stopPropagation()}
                      />
                    </Popconfirm>
                  </Space>
                </div>
                <div style={{ marginTop: 4, paddingLeft: 26 }}>
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    {p.task_count ?? 0} 个任务
                  </Text>
                </div>
              </div>

              {/* 就地展开的任务清单：不用切看板也能扫一眼这个项目里有什么 */}
              {open && (
                <div
                  style={{
                    background: rowBg,
                    borderLeft: `3px solid ${active ? 'var(--primary-6)' : 'transparent'}`,
                    padding: '2px 12px 10px 26px',
                  }}
                >
                  {loadingTasksOf === p.id ? (
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      加载中…
                    </Text>
                  ) : !rows || rows.length === 0 ? null : (
                    <Space direction="vertical" size={2} style={{ width: '100%' }}>
                      {rows.map((t) => (
                        <div
                          key={t.id}
                          onClick={() => onOpenTask(p.id, t.id)}
                          title={t.title}
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 6,
                            padding: '4px 6px',
                            borderRadius: 5,
                            cursor: 'pointer',
                            fontSize: 12,
                            color: 'var(--color-text-2)',
                            background: hoverId === t.id ? 'var(--color-fill-2)' : 'transparent',
                          }}
                          onMouseEnter={() => setHoverId(t.id)}
                          onMouseLeave={() => setHoverId(null)}
                        >
                          <span
                            style={{
                              width: 6,
                              height: 6,
                              borderRadius: '50%',
                              flexShrink: 0,
                              background: STATUS_DOT[t.status] || 'var(--color-text-4)',
                            }}
                          />
                          <span
                            style={{
                              flex: 1,
                              minWidth: 0,
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap',
                            }}
                          >
                            {t.title}
                          </span>
                          {t.assignee && <IconUser style={{ fontSize: 12, flexShrink: 0 }} />}
                        </div>
                      ))}
                    </Space>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </>
  );
}

/**
 * 任务详情区块（竖版看板 / 横版分组两套视图共用一份实现）
 * 整块 stopPropagation：否则在详情里点输入框、选文字、滚动跟踪记录，
 * 会冒泡到整卡可点的 onClick 上把卡片折叠掉。
 */
function TaskDetail({ task, tracks, trackDraft, setTrackDraft, onSubmitTrack, onDelTrack, fmtTs }) {
  return (
    <div
      onClick={(e) => e.stopPropagation()}
      style={{
        marginTop: 16,
        paddingTop: 14,
        borderTop: '1px solid var(--color-border-2)',
      }}
    >
      <Space wrap size={[10, 10]} style={{ marginBottom: 14 }}>
        <Tag color={STATUS_META[task.status]?.color}>{STATUS_META[task.status]?.label || task.status}</Tag>
        <Tag color={PRIORITY_META[task.priority]?.color || 'gray'}>
          {PRIORITY_META[task.priority]?.label || task.priority}
        </Tag>
        <Text type="secondary" style={{ fontSize: 12 }}>
          创建 {fmtTs(task.created_at)}
        </Text>
        <Text type="secondary" style={{ fontSize: 12 }}>
          更新 {fmtTs(task.updated_at)}
        </Text>
        {task.assignee && (
          <Tag color={leaseExpired(task) ? 'red' : 'cyan'}>
            认领人 {task.assignee}
            {leaseExpired(task) ? '（租约超时）' : ''}
          </Tag>
        )}
      </Space>

      {(task.attempts || 0) > 0 && (
        <div style={{ fontSize: 12, marginBottom: 10 }}>
          <Tag color="red">失败 {task.attempts} 次</Tag>
          {task.last_error && (
            <Text type="secondary" style={{ fontSize: 12 }}>
              最近错误：{task.last_error}
            </Text>
          )}
        </div>
      )}

      {task.result && (
        <div
          style={{
            fontSize: 12,
            marginBottom: 10,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
          }}
        >
          <Text bold style={{ fontSize: 12 }}>
            产出：
          </Text>
          {task.result}
        </div>
      )}

      <Text bold style={{ fontSize: 13 }}>
        跟踪记录
      </Text>
      <div style={{ marginTop: 8, maxHeight: 220, overflowY: 'auto' }}>
        {tracks.length === 0 ? (
          <Empty description="暂无跟踪记录" imageStyle={{ height: 30 }} />
        ) : (
          tracks.map((tr) => (
            <div
              key={tr.id}
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'flex-start',
                gap: 8,
                padding: '6px 0',
                borderBottom: '1px dashed var(--color-border-2)',
              }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div
                  style={{
                    fontSize: 13,
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                  }}
                >
                  {tr.content}
                </div>
                <Text type="secondary" style={{ fontSize: 11 }}>
                  {fmtTs(tr.created_at)}
                </Text>
              </div>
              <Button
                size="mini"
                type="text"
                status="danger"
                icon={<IconDelete />}
                onClick={() => onDelTrack(tr.id)}
              />
            </div>
          ))
        )}
      </div>
      <Input
        size="small"
        placeholder="添加一条跟踪记录，回车提交"
        value={trackDraft}
        onChange={setTrackDraft}
        onPressEnter={onSubmitTrack}
        style={{ marginTop: 12 }}
      />
    </div>
  );
}

export default function App() {
  const [projects, setProjects] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [tasks, setTasks] = useState([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  // 项目列表是否已加载完成（未完成时先不套用"只有一个看板就收起"的默认）
  const [projLoaded, setProjLoaded] = useState(false);

  const [projModal, setProjModal] = useState({
    open: false,
    editing: null,
    name: '',
    description: '',
  });
  const [taskModal, setTaskModal] = useState({
    open: false,
    editing: null,
    title: '',
    content: '',
    status: 'todo',
    priority: 'normal',
  });

  // 各面板内联添加任务：draft 存每列输入内容，adding 标记当前展开输入的列
  const [draft, setDraft] = useState({ todo: '', doing: '', done: '' });
  const [adding, setAdding] = useState(null);

  // 注：原先这里有「面板折叠状态」（按项目记录、持久化到 localStorage），
  // 但空列现在直接不渲染，不再有折叠/展开两种形态，相关状态与持久化已移除。

  // 全局模糊搜索：searchQuery 为用户输入框内容；searchResults 为 null 表示未进入搜索态
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState(null);
  const [searching, setSearching] = useState(false);

  // 左侧项目栏：宽屏可收起（宽度归零），窄屏改为抽屉弹出
  // siderPref 为 null 表示用户没手动设置过，走默认展开。
  // 曾经默认「只有一个看板时收起」，但侧栏后来承载了任务清单，
  // 收起来就等于把唯一的入口藏了，单项目用户根本发现不了 —— 所以默认常开。
  const [siderPref, setSiderPref] = useState(() => readLayout().sider);
  const siderOpen = siderPref == null ? true : siderPref;
  const setSiderOpen = setSiderPref;
  const [drawerOpen, setDrawerOpen] = useState(false);

  // 侧栏就地展开的项目任务清单：一次只展开一个（sidebarProj 为 null 表示全收起）。
  // 与看板里的任务详情展开是两条独立通道：点侧栏任务 = 切到该看板，
  // 再把它设成 expandedId，看板上对应卡片会随之展开详情（含跟踪记录）。
  const [sidebarTasks, setSidebarTasks] = useState({}); // { [projectId]: task[] }
  const [sidebarProj, setSidebarProj] = useState(null); // 当前展开清单的项目 id
  const [sidebarLoading, setSidebarLoading] = useState(null); // 正在加载的 projectId
  const [isNarrow, setIsNarrow] = useState(() =>
    typeof window === 'undefined' ? false : window.innerWidth < 900
  );
  useEffect(() => {
    const onResize = () => {
      const narrow = window.innerWidth < 900;
      setIsNarrow(narrow);
      if (!narrow) setDrawerOpen(false);
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  // 按"当前实际是否展开"来翻转，并把这个结果记成用户的显式偏好
  const openMenu = () => (isNarrow ? setDrawerOpen(true) : setSiderOpen(!siderOpen));

  const runSearch = useCallback(async (q) => {
    if (!q.trim()) {
      setSearchResults(null);
      return;
    }
    setSearching(true);
    try {
      setSearchResults(await api.search(q));
    } catch (e) {
      Message.error(e.message);
      setSearchResults([]);
    } finally {
      setSearching(false);
    }
  }, []);

  // 输入框变化时防抖触发搜索
  useEffect(() => {
    const id = setTimeout(() => runSearch(searchQuery), 250);
    return () => clearTimeout(id);
  }, [searchQuery, runSearch]);

  // 深色模式：优先读 localStorage，否则跟随系统偏好；切换时同步 body 类并持久化
  const [isDark, setIsDark] = useState(() => {
    try {
      const saved = readPrefMigrated('t2a-theme');
      if (saved) return saved === 'dark';
      return window.matchMedia('(prefers-color-scheme: dark)').matches;
    } catch {
      return false;
    }
  });
  useEffect(() => {
    // Arco 2.x 原生暗色机制：给 body 加 arco-theme='dark' 属性（而非 class），
    // CSS 中的 body[arco-theme='dark'] 块才会覆盖全部颜色变量。
    // html 上同步挂一份，用于 color-scheme（滚动条 / 原生控件底色）。
    const theme = isDark ? 'dark' : 'light';
    document.body.setAttribute('arco-theme', theme);
    document.documentElement.setAttribute('arco-theme', theme);
    try {
      localStorage.setItem('t2a-theme', theme);
    } catch {}
  }, [isDark]);

  /* ------------------- 任务列表展现形式（竖版看板 / 横版分组） ------------------- */
  // 'board' 竖版：状态列并排，看板视角，适合宽屏
  // 'list'  横版：按状态分组，组内任务竖排成列表，整行可点，适合手机
  const LAYOUT_VIEW_KEY = 't2a-ui-view';
  const [viewMode, setViewMode] = useState(() => {
    try {
      const saved = readPrefMigrated(LAYOUT_VIEW_KEY);
      if (saved === 'board' || saved === 'list') return saved;
      // 没手动设过：手机默认横版（竖列看板在窄屏几乎没法用），其余按竖版
      return typeof window !== 'undefined' && window.innerWidth < 900 ? 'list' : 'board';
    } catch {
      return 'board';
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(LAYOUT_VIEW_KEY, viewMode);
    } catch {}
  }, [viewMode]);
  const isListView = viewMode === 'list';

  // 设置菜单（顶栏齿轮）：主题 + 展现形式收在一处
  const [settingsOpen, setSettingsOpen] = useState(false);
  // 搜索框默认收起，点顶栏放大镜才展开一行（避免常驻输入框挤窄标题）
  const [searchOpen, setSearchOpen] = useState(false);

  const loadProjects = useCallback(async () => {
    const list = await api.listProjects();
    setProjects(list);
    setProjLoaded(true);
    return list;
  }, []);

  const loadTasks = useCallback(async (pid) => {
    if (!pid) {
      setTasks([]);
      return;
    }
    setLoading(true);
    try {
      setTasks(await api.listTasks(pid));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    (async () => {
      const list = await loadProjects();
      if (list.length) setSelectedId(list[0].id);
    })();
  }, [loadProjects]);

  useEffect(() => {
    loadTasks(selectedId);
  }, [selectedId, loadTasks]);

  // 侧栏展开/收起偏好写回 localStorage（面板折叠状态已移除）
  useEffect(() => {
    writeLayout({ sider: siderPref, cols: {} });
  }, [siderPref]);

  const selected = projects.find((p) => p.id === selectedId) || null;

  /* ------------------- 自动刷新（SSE 事件流，默认常开） ------------------- */
  // 服务端数据一变就推送，看板无需手动点刷新；CLI 的写入同样能触发
  const [syncedAt, setSyncedAt] = useState(0);
  const selectedIdRef = useRef(null);
  selectedIdRef.current = selectedId;
  // 当前看板的任务 id 集合：用来判断推送的变更"是否与我有关"
  const taskIdsRef = useRef(new Set());
  taskIdsRef.current = new Set(tasks.map((t) => t.id));
  // 侧栏当前展开清单的项目（SSE 回调里要用，放 ref 避免重复订阅）
  const sidebarProjRef = useRef(null);
  sidebarProjRef.current = sidebarProj;
  useEffect(() => {
    let timer = null;
    const es = new EventSource('/api/events');
    es.addEventListener('changed', (e) => {
      let changes = [];
      try {
        changes = JSON.parse(e.data).changes || [];
      } catch {
        changes = [];
      }
      // 变更涉及当前看板（或拿不到摘要时保守处理）才刷新任务列表；
      // 否则只更新项目列表的任务数——没动静 / 与我无关就不刷新。
      const pid = selectedIdRef.current;
      const relevant =
        changes.length === 0 ||
        changes.some((c) => c.project_id === pid || (c.task_id && taskIdsRef.current.has(c.task_id)));
      clearTimeout(timer);
      timer = setTimeout(() => {
        loadProjects().catch(() => {});
        if (pid && relevant) loadTasks(pid);
        // 侧栏展开中的项目也一并刷新，否则清单会停留在展开那一刻的状态
        const sp = sidebarProjRef.current;
        if (sp && (relevant || changes.some((c) => c.project_id === sp))) {
          api
            .listTasks(sp)
            .then((rows) => setSidebarTasks((prev) => ({ ...prev, [sp]: rows })))
            .catch(() => {});
        }
        setSyncedAt(Date.now());
      }, 300);
    });
    es.onerror = () => {}; // EventSource 自带重连，这里只忽略噪音日志
    return () => {
      clearTimeout(timer);
      es.close();
    };
  }, [loadProjects, loadTasks]);

  /* --------------------------- 项目操作 --------------------------- */
  const openNewProject = () =>
    setProjModal({ open: true, editing: null, name: '', description: '' });
  const openRenameProject = (p) =>
    setProjModal({ open: true, editing: p, name: p.name, description: p.description || '' });

  const submitProject = async () => {
    if (!projModal.name.trim()) {
      Message.warning('请输入项目名');
      return;
    }
    setBusy(true);
    try {
      if (projModal.editing) {
        await api.renameProject(projModal.editing.id, projModal.name.trim());
        Message.success('已重命名');
      } else {
        await api.createProject(projModal.name.trim(), projModal.description.trim());
        Message.success('已创建项目');
      }
      setProjModal({ ...projModal, open: false });
      const list = await loadProjects();
      if (!projModal.editing && !selectedId && list.length) {
        setSelectedId(list[list.length - 1].id);
      }
    } catch (e) {
      Message.error(e.message);
    } finally {
      setBusy(false);
    }
  };

  const deleteProject = async (p) => {
    try {
      await api.deleteProject(p.id);
      Message.success('已删除项目');
      const list = await loadProjects();
      if (selectedId === p.id) setSelectedId(list.length ? list[0].id : null);
      // 顺手清掉侧栏里这个项目的任务缓存，避免下次重建同名项目时看到旧数据
      setSidebarTasks((prev) => {
        if (!(p.id in prev)) return prev;
        const next = { ...prev };
        delete next[p.id];
        return next;
      });
      if (sidebarProj === p.id) setSidebarProj(null);
    } catch (e) {
      Message.error(e.message);
    }
  };

  /* --------------------------- 任务操作 --------------------------- */
  const openNewTask = () => {
    if (!selectedId) {
      Message.warning('请先选择或创建项目');
      return;
    }
    setTaskModal({
      open: true,
      editing: null,
      title: '',
      content: '',
      status: 'todo',
      priority: 'normal',
    });
  };
  const openEditTask = (t) =>
    setTaskModal({
      open: true,
      editing: t,
      title: t.title,
      content: t.content || '',
      status: t.status,
      priority: t.priority,
    });

  const submitTask = async () => {
    if (!taskModal.title.trim()) {
      Message.warning('请输入标题');
      return;
    }
    setBusy(true);
    try {
      if (taskModal.editing) {
        await api.updateTask(taskModal.editing.id, {
          title: taskModal.title.trim(),
          content: taskModal.content,
          status: taskModal.status,
          priority: taskModal.priority,
        });
        Message.success('已更新');
      } else {
        await api.createTask(selectedId, {
          title: taskModal.title.trim(),
          content: taskModal.content,
          status: taskModal.status,
          priority: taskModal.priority,
        });
        Message.success('已添加');
      }
      setTaskModal({ ...taskModal, open: false });
      await loadTasks(selectedId);
    } catch (e) {
      Message.error(e.message);
    } finally {
      setBusy(false);
    }
  };

  const deleteTask = async (t) => {
    try {
      await api.deleteTask(t.id);
      Message.success('已删除');
      await loadTasks(selectedId);
    } catch (e) {
      Message.error(e.message);
    }
  };

  const moveTask = async (t, status) => {
    try {
      await api.updateTask(t.id, { status });
      await loadTasks(selectedId);
    } catch (e) {
      Message.error(e.message);
    }
  };

  // 搜索结果中点击某任务：跳转到其所属项目并直接展开该任务详情
  // （openTaskFromSidebar 定义在下方「任务详情展开」一节，属箭头函数，此处调用时才求值）
  const jumpToProject = (projId, taskId) => {
    setSearchQuery('');
    setSearchResults(null);
    setSelectedId(projId);
    if (taskId) openTaskFromSidebar(projId, taskId);
  };

  // 在某个面板内联新增任务：状态固定为该列，优先级默认普通，内容留空
  const submitInline = async (s) => {
    const title = (draft[s] || '').trim();
    if (!title) return;
    if (!selectedId) {
      Message.warning('请先选择或创建项目');
      return;
    }
    setBusy(true);
    try {
      await api.createTask(selectedId, {
        title,
        content: '',
        status: s,
        priority: 'normal',
      });
      setDraft({ ...draft, [s]: '' });
      setAdding(null);
      Message.success('已添加');
      await loadTasks(selectedId);
    } catch (e) {
      Message.error(e.message);
    } finally {
      setBusy(false);
    }
  };

  const tasksByCol = (s) => tasks.filter((t) => t.status === s);

  // 任务详情展开 + 跟踪记录：一次只展开一个任务
  const [expandedId, setExpandedId] = useState(null);
  const [tracks, setTracks] = useState([]);
  const [trackDraft, setTrackDraft] = useState('');

  const fmtTs = (ts) => {
    if (!ts) return '-';
    const d = new Date(Number(ts));
    if (isNaN(d.getTime())) return String(ts);
    return d.toLocaleString('zh-CN', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  const toggleExpand = async (tid) => {
    if (expandedId === tid) {
      setExpandedId(null);
      setTracks([]);
      setTrackDraft('');
      return;
    }
    setExpandedId(tid);
    setTrackDraft('');
    try {
      setTracks(await api.listTracks(tid));
    } catch (e) {
      Message.error(e.message);
    }
  };

  /* ------------------- 侧栏项目就地展开任务清单 ------------------- */
  // 展开一个项目：按需拉取该看板任务（缓存进 sidebarTasks，重复展开不再请求）。
  // 与看板里的任务详情展开是两件事，故用 sidebarProj（哪个项目展开）
  // 与 expandedId（哪条任务展开详情）两个独立状态。
  const toggleProjectExpand = async (pid) => {
    if (sidebarProj === pid) {
      setSidebarProj(null);
      return;
    }
    setSidebarProj(pid);
    if (sidebarTasks[pid]) return;
    setSidebarLoading(pid);
    try {
      const rows = await api.listTasks(pid);
      setSidebarTasks((prev) => ({ ...prev, [pid]: rows }));
    } catch (e) {
      Message.error(e.message);
      setSidebarTasks((prev) => ({ ...prev, [pid]: [] }));
    } finally {
      setSidebarLoading(null);
    }
  };

  // 侧栏里点某个任务：切到该看板 + 展开这条任务的详情
  const openTaskFromSidebar = async (pid, tid) => {
    setSelectedId(pid);
    setExpandedId(tid);
    setTrackDraft('');
    try {
      setTracks(await api.listTracks(tid));
    } catch (e) {
      Message.error(e.message);
    }
  };

  const submitTrack = async (tid) => {
    const content = trackDraft.trim();
    if (!content) return;
    try {
      const row = await api.addTrack(tid, content);
      setTracks((prev) => [...prev, row]);
      setTrackDraft('');
      Message.success('已添加跟踪记录');
    } catch (e) {
      Message.error(e.message);
    }
  };

  const delTrack = async (id) => {
    try {
      await api.deleteTrack(id);
      setTracks((prev) => prev.filter((x) => x.id !== id));
    } catch (e) {
      Message.error(e.message);
    }
  };

  return (
    <Layout style={{ height: '100vh', background: 'var(--color-bg-1)' }}>
      {!isNarrow && (
        <Sider
          width={siderOpen ? 260 : 0}
          theme={isDark ? 'dark' : 'light'}
          style={{
            borderRight: siderOpen ? '1px solid var(--color-border-2)' : 'none',
            display: 'flex',
            flexDirection: 'column',
            height: '100vh',
            overflow: 'hidden',
            transition: 'width .2s ease',
          }}
        >
          {/* 固定内容宽度，收起动画期间内容不回流，呈现横向擦除效果 */}
          <div
            style={{
              width: 260,
              flexShrink: 0,
              height: '100%',
              display: 'flex',
              flexDirection: 'column',
            }}
          >
            <ProjectSidebar
              projects={projects}
              selectedId={selectedId}
              onSelect={setSelectedId}
              onNew={openNewProject}
              onRename={openRenameProject}
              onDelete={deleteProject}
              onCollapse={() => setSiderOpen(false)}
              expandedId={sidebarProj}
              onToggleExpand={toggleProjectExpand}
              sidebarTasks={sidebarTasks}
              loadingTasksOf={sidebarLoading}
              onOpenTask={openTaskFromSidebar}
            />
          </div>
        </Sider>
      )}

      {isNarrow && (
        <Drawer
          width={280}
          placement="left"
          visible={drawerOpen}
          onCancel={() => setDrawerOpen(false)}
          footer={null}
          closable={false}
          bodyStyle={{ padding: 0, display: 'flex', flexDirection: 'column' }}
        >
          <ProjectSidebar
            projects={projects}
            selectedId={selectedId}
            onSelect={(id) => {
              setSelectedId(id);
              setDrawerOpen(false);
            }}
            onNew={openNewProject}
            onRename={openRenameProject}
            onDelete={deleteProject}
            onCollapse={() => setDrawerOpen(false)}
            expandedId={sidebarProj}
            onToggleExpand={toggleProjectExpand}
            sidebarTasks={sidebarTasks}
            loadingTasksOf={sidebarLoading}
            onOpenTask={(pid, tid) => {
              openTaskFromSidebar(pid, tid);
              setDrawerOpen(false);
            }}
          />
        </Drawer>
      )}

      <Layout>
        <Header
          style={{
            // 竖向容器：第一行 = 项目标题 + 图标排；第二行 = 展开的搜索框
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'stretch',
            gap: 0,
            height: 'auto',
            padding: 0,
            borderBottom: '1px solid var(--color-border-2)',
            background: 'var(--color-bg-2)',
          }}
        >
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              gap: 20,
              minHeight: 64,
              padding: '12px 20px',
            }}
          >
            <div
              style={{
                display: 'flex',
                // 标题换行后仍让菜单按钮与首行对齐（center 会让多行标题错位）
                alignItems: 'flex-start',
                gap: 12,
                flex: 1,
                // 允许收缩到内容宽度以下，标题才能换行而不是把右侧图标挤走
                minWidth: 0,
              }}
            >
              <Tooltip content={isNarrow || !siderOpen ? '显示项目列表' : '收起项目列表'}>
                <Button
                  type="text"
                  style={{ marginTop: 2 }}
                  icon={!isNarrow && siderOpen ? <IconMenuFold /> : <IconMenu />}
                  onClick={openMenu}
                />
              </Tooltip>
              <div style={{ minWidth: 0, overflowWrap: 'anywhere' }}>
                {/* 标题优先完整显示：不加 ellipsis，让它自然换行；
                    只有容器真放不下时才靠 flex 收缩 + overflow 兜底。*/}
                <Title heading={5} style={{ margin: 0, lineHeight: '22px' }}>
                  {selected ? selected.name : '未选择项目'}
                </Title>
                {selected && selected.description && (
                  <Text
                    type="secondary"
                    style={{ fontSize: 12, display: 'block', lineHeight: '18px' }}
                  >
                    {selected.description}
                  </Text>
                )}
              </div>
            </div>
            {/* 顶栏右侧收成一排图标：搜索 / 新建 / 同步状态 / 设置。
            搜索点开才展开输入框，避免常驻输入框把标题挤窄（窄屏尤其明显）。*/}
            <Space size={4} style={{ flexShrink: 0 }}>
              <Tooltip content="搜索任务（编号 / 标题 / 内容 / 项目）">
                <Button
                  type="text"
                  icon={<IconSearch />}
                  aria-label="搜索"
                  onClick={() => setSearchOpen((v) => !v)}
                />
              </Tooltip>
              <Tooltip content="新建任务">
                <Button
                  type="text"
                  icon={<IconPlus />}
                  aria-label="新建任务"
                  onClick={openNewTask}
                  disabled={!selected}
                />
              </Tooltip>
              <Popover
                trigger="click"
                position="br"
                visible={settingsOpen}
                onChange={setSettingsOpen}
                // 深浅色 + 展现形式 + 同步状态收进同一个设置菜单，顶栏不再散落
                content={
                  <div style={{ width: 248 }}>
                    <Text bold style={{ fontSize: 13 }}>
                      主题
                    </Text>
                    <RadioGroup
                      type="button"
                      size="small"
                      style={{ marginTop: 8, display: 'flex' }}
                      value={isDark ? 'dark' : 'light'}
                      onChange={(v) => setIsDark(v === 'dark')}
                    >
                      <Radio value="light">
                        <Space size={4}>
                          <IconSun />浅色
                        </Space>
                      </Radio>
                      <Radio value="dark">
                        <Space size={4}>
                          <IconMoon />深色
                        </Space>
                      </Radio>
                    </RadioGroup>

                    <Divider style={{ margin: '14px 0 12px' }} />

                    <Text bold style={{ fontSize: 13 }}>
                      任务列表展现形式
                    </Text>
                    <RadioGroup
                      type="button"
                      size="small"
                      style={{ marginTop: 8, display: 'flex' }}
                      value={viewMode}
                      onChange={(v) => setViewMode(v)}
                    >
                      <Radio value="board">竖版看板</Radio>
                      <Radio value="list">横版分组</Radio>
                    </RadioGroup>
<div style={{ marginTop: 8 }}>
                    <Text type="secondary" style={{ fontSize: 12, lineHeight: '18px' }}>
                      竖版：状态列并排，适合宽屏。
                      <br />
                      横版：按状态分组、组内列表，整行可点，手机更顺手。
                      {isNarrow && !isListView ? ' 手机上建议用横版。' : ''}
                    </Text>
                  </div>

                  <Divider style={{ margin: '14px 0 12px' }} />

                  {/* 同步状态：原先是顶栏一个绿点，现收进设置菜单底部 */}
                  <div
                    style={{ display: 'flex', alignItems: 'center', gap: 8 }}
                  >
                    <span
                      style={{
                        width: 7,
                        height: 7,
                        borderRadius: '50%',
                        flexShrink: 0,
                        background: syncedAt ? 'var(--green-5)' : 'var(--color-text-4)',
                      }}
                    />
                    <Text bold style={{ fontSize: 13 }}>
                      数据同步
                    </Text>
                  </div>
                  <div style={{ marginTop: 6 }}>
                    <Text type="secondary" style={{ fontSize: 12, lineHeight: '18px' }}>
                      {syncedAt
                        ? `上次同步 ${new Date(syncedAt).toLocaleTimeString('zh-CN')}`
                        : '实时同步中，正在建立连接'}
                      <br />
                      数据有变化时才刷新（服务端每秒探测一次），没变化不会打扰。
                    </Text>
                  </div>
                </div>
              }
              >
                <Tooltip content="设置">
                  <Button
                    type="text"
                    icon={<IconSettings />}
                    aria-label="设置"
                  />
                </Tooltip>
              </Popover>
            </Space>
          </div>

          {/* 搜索输入框：点放大镜后在标题下方展开一行，避免常驻挤压标题 */}
          {searchOpen && (
            <div
              style={{
                padding: '0 20px 12px',
                background: 'var(--color-bg-2)',
              }}
            >
              <Input
                allowClear
                autoFocus
                size="small"
                placeholder="模糊搜索任务（编号 / 标题 / 内容 / 项目）"
                prefix={<IconSearch />}
                value={searchQuery}
                onChange={(v) => setSearchQuery(v)}
                onClear={() => {
                  setSearchQuery('');
                  setSearchResults(null);
                }}
              />
            </div>
          )}
        </Header>

        <Content style={{ padding: 20, overflow: 'hidden' }}>
          {searchResults !== null ? (
            <div style={{ height: '100%', overflowY: 'auto' }}>
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  gap: 12,
                  marginBottom: 16,
                }}
              >
                <Title heading={6} style={{ margin: 0 }}>
                  搜索结果 {searching ? '(搜索中…)' : `(${searchResults.length} 条)`}
                </Title>
                <Button
                  size="small"
                  icon={<IconRefresh />}
                  onClick={() => runSearch(searchQuery)}
                >
                  重新搜索
                </Button>
              </div>
              {searchResults.length === 0 ? (
                <Empty description="没有匹配的任务" style={{ marginTop: 60 }} />
              ) : (
                <Space direction="vertical" style={{ width: '100%' }} size={12}>
                  {searchResults.map((t) => (
                    <Card
                      key={t.id}
                      size="small"
                      hoverable
                      style={{ cursor: 'pointer' }}
                      onClick={() => jumpToProject(t.project_id, t.id)}
                      title={
                        <div
                          title={t.title}
                          style={{
                            width: '100%',
                            minWidth: 0,
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                          }}
                        >
                          {t.title}
                        </div>
                      }
                    >
                      <Space wrap size={[8, 4]}>
                        <TaskCode code={t.code} />
                        <Tag color="arcoblue">{t.project_name}</Tag>
                        <Tag color={STATUS_META[t.status]?.color || 'gray'}>
                          {STATUS_META[t.status]?.label || t.status}
                        </Tag>
                        <Tag color={PRIORITY_META[t.priority]?.color || 'gray'}>
                          {PRIORITY_META[t.priority]?.label || t.priority}
                        </Tag>
                        {t.assignee && <Tag color="cyan">{t.assignee}</Tag>}
                        {t.content && (
                          <Text type="secondary" style={{ fontSize: 12 }}>
                            {t.content.length > 60 ? t.content.slice(0, 60) + '…' : t.content}
                          </Text>
                        )}
                      </Space>
                    </Card>
                  ))}
                </Space>
              )}
            </div>
          ) : !selected ? (
            <Empty
              description="请选择左侧项目，或新建一个看板"
              style={{ marginTop: 80 }}
            />
          ) : isListView ? (
            /* ---------------- 横版：按状态分组，组内任务竖排成列表 ---------------- */
            // 手机可读性优先：空分组整块不渲染（不显示分组框、不显示"暂无任务"），
            // 只保留真正有内容的分组；全部为空时给一个整体空态。
            <div style={{ height: '100%', overflowY: 'auto', paddingRight: 2 }}>
              {COLUMNS.filter((s) => !loading && tasksByCol(s).length === 0).length ===
              COLUMNS.length ? (
                <Empty description="这个看板还没有任务" style={{ marginTop: 60 }} />
              ) : (
                COLUMNS.map((s) => {
                  const list = tasksByCol(s);
                  // 加载中先全部渲染占位，避免内容闪一下再消失
                  if (!loading && list.length === 0) return null;
                return (
                  <section
                    key={s}
                    style={{
                      marginBottom: 18,
                      background: 'var(--color-fill-1)',
                      borderRadius: 10,
                      padding: 14,
                    }}
                  >
                    {/* 分组头：状态名 + 条数 + 直接在这一组加任务 */}
                    <div
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        gap: 8,
                        marginBottom: list.length ? 10 : 0,
                      }}
                    >
                      <Space size={8}>
                        <Tag color={STATUS_META[s].color}>{STATUS_META[s].label}</Tag>
                        <Text type="secondary">{list.length}</Text>
                      </Space>
                      <Tooltip content="在此分组添加任务">
                        <Button
                          size="mini"
                          type="text"
                          icon={<IconPlus />}
                          onClick={() => setAdding(s)}
                          disabled={!selected}
                        />
                      </Tooltip>
                    </div>

                    {adding === s && (
                      <Space direction="vertical" size={8} style={{ width: '100%', marginBottom: 10 }}>
                        <Input
                          autoFocus
                          size="small"
                          placeholder="输入任务标题，回车添加"
                          value={draft[s] || ''}
                          onChange={(v) => setDraft({ ...draft, [s]: v })}
                          onPressEnter={() => submitInline(s)}
                          disabled={busy}
                        />
                        <Space size={8}>
                          <Button size="mini" type="primary" loading={busy} onClick={() => submitInline(s)}>
                            添加
                          </Button>
                          <Button
                            size="mini"
                            onClick={() => {
                              setAdding(null);
                              setDraft({ ...draft, [s]: '' });
                            }}
                          >
                            取消
                          </Button>
                        </Space>
                      </Space>
                    )}

                    {/* 空分组已在 map 开头return 掉，这里 list 必然非空 */}
                    {loading ? (
                      <Empty description="加载中…" imageStyle={{ height: 30 }} />
                    ) : (
                      <Space direction="vertical" style={{ width: '100%' }} size={8}>
                        {list.map((t) => (
                          <Card
                            key={t.id}
                            size="small"
                            hoverable
                            // 整行可点开详情（与竖版一致的交互）
                            onClick={() => toggleExpand(t.id)}
                            style={{ cursor: 'pointer' }}
                          >
                            <div
                              style={{
                                display: 'flex',
                                alignItems: 'flex-start',
                                gap: 10,
                                minWidth: 0,
                              }}
                            >
                              <span style={{ flexShrink: 0, marginTop: 2, color: 'var(--color-text-3)' }}>
                                {expandedId === t.id ? <IconUp /> : <IconDown />}
                              </span>
                              <div style={{ flex: 1, minWidth: 0 }}>
                                <div
                                  title={t.title}
                                  style={{
                                    fontSize: 14,
                                    fontWeight: 500,
                                    lineHeight: '20px',
                                  }}
                                >
                                  {t.title}
                                </div>
                                {t.content && (
                                  <div
                                    style={{
                                      marginTop: 2,
                                      fontSize: 12,
                                      color: 'var(--color-text-3)',
                                      overflow: 'hidden',
                                      textOverflow: 'ellipsis',
                                      whiteSpace: 'nowrap',
                                    }}
                                  >
                                    {t.content}
                                  </div>
                                )}
                                <Space wrap size={[6, 6]} style={{ marginTop: 8 }}>
                                  <TaskCode code={t.code} />
                                  <Tag color={PRIORITY_META[t.priority]?.color || 'gray'}>
                                    {PRIORITY_META[t.priority]?.label || t.priority}
                                  </Tag>
                                  {t.assignee && (
                                    <Tag color={leaseExpired(t) ? 'red' : 'cyan'}>
                                      {leaseExpired(t) ? `${t.assignee} · 超时` : t.assignee}
                                    </Tag>
                                  )}
                                  {(t.attempts || 0) > 0 && (
                                    <Tooltip content={t.last_error || '尚无错误详情'}>
                                      <Tag color="red">失败 {t.attempts} 次</Tag>
                                    </Tooltip>
                                  )}
                                </Space>
                              </div>
                              {/* 右侧操作：移动到其他状态。stopPropagation 保住"点它不触发展开" */}
                              <div onClick={(e) => e.stopPropagation()} style={{ flexShrink: 0 }}>
                                <Tooltip content="移动到其他分组">
                                  <Dropdown
                                    position="br"
                                    droplist={
                                      <Menu onClickMenuItem={(key) => moveTask(t, key)}>
                                        {COLUMNS.filter((c) => c !== s).map((c) => (
                                          <Menu.Item key={c}>{STATUS_META[c].label}</Menu.Item>
                                        ))}
                                      </Menu>
                                    }
                                  >
                                    <Button size="mini" type="text" icon={<IconSwap />} />
                                  </Dropdown>
                                </Tooltip>
                              </div>
                            </div>

                            {expandedId === t.id && (
                              <TaskDetail
                                task={t}
                                tracks={tracks}
                                trackDraft={trackDraft}
                                setTrackDraft={setTrackDraft}
                                onSubmitTrack={() => submitTrack(t.id)}
                                onDelTrack={delTrack}
                                fmtTs={fmtTs}
                              />
                            )}
                          </Card>
                        ))}
                      </Space>
                    )}
                  </section>
                );
              })
              )}
            </div>
          ) : (
            <div style={{ display: 'flex', gap: 16, height: '100%', overflowX: 'auto' }}>
              {COLUMNS.map((s) => {
                const list = tasksByCol(s);
                // 精简优先：空列不再折成竖条占位，直接不渲染；
                // 加载中先渲染占位，避免内容闪一下再消失。
                if (!loading && list.length === 0) return null;
                return (
                  <div
                    key={s}
                    style={{
                      flex: '1 0 210px',
                      display: 'flex',
                      flexDirection: 'column',
                      background: 'var(--color-fill-1)',
                      borderRadius: 10,
                      padding: 14,
                      minWidth: 190,
                    }}
                  >
                    <div
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        gap: 8,
                        marginBottom: 14,
                      }}
                    >
                      <Tag color={STATUS_META[s].color}>{STATUS_META[s].label}</Tag>
                      <Space size={6}>
                        <Text type="secondary">{list.length}</Text>
                        {/* 加号是唯一的添加入口（原先底部还有个虚线「添加任务」长按钮，
                            与列头加号重复，已删除）*/}
                        <Tooltip content="在此列添加任务">
                          <Button
                            size="mini"
                            type="text"
                            icon={<IconPlus />}
                            onClick={() => setAdding(s)}
                            disabled={!selected}
                          />
                        </Tooltip>
                      </Space>
                    </div>
                    <div style={{ overflowY: 'auto', flex: 1 }}>
                      {loading ? (
                        <Empty description="加载中…" style={{ marginTop: 24 }} />
                      ) : (
                        <Space direction="vertical" style={{ width: '100%' }} size={12}>
                          {list.map((t) => (
                            <Card
                              key={t.id}
                              size="small"
                              hoverable
                              // 整张卡都可点开详情。此前只有标题那条细缝绑定 onClick，
                              // 卡片越大、正文越长，能点的区域占比越小（描述长的任务几乎点不动），
                              // 表现为"点了没反应"。下方按钮各自 stopPropagation 保持独立行为。
                              onClick={() => toggleExpand(t.id)}
                              style={{ cursor: 'pointer' }}
                              title={
                                <div
                                  style={{
                                    display: 'flex',
                                    // 标题折行时箭头与首行对齐
                                    alignItems: 'flex-start',
                                    gap: 8,
                                    width: '100%',
                                    minWidth: 0,
                                  }}
                                >
                                  <span style={{ flexShrink: 0, marginTop: 2 }}>
                                    {expandedId === t.id ? <IconUp /> : <IconDown />}
                                  </span>
                                  {/* 任务标题：先完整显示，卡片放不下时最多折两行，
                                      两行仍装不下才省略（比单行省略更易读）*/}
                                  <span
                                    title={t.title}
                                    style={{
                                      flex: 1,
                                      minWidth: 0,
                                      overflowWrap: 'anywhere',
                                      display: '-webkit-box',
                                      WebkitLineClamp: 2,
                                      WebkitBoxOrient: 'vertical',
                                      overflow: 'hidden',
                                      lineHeight: '20px',
                                    }}
                                  >
                                    {t.title}
                                  </span>
                                </div>
                              }
                              extra={
                                <Space size={2} onClick={(e) => e.stopPropagation()}>
                                  <Button
                                    size="mini"
                                    type="text"
                                    icon={<IconEdit />}
                                    onClick={() => openEditTask(t)}
                                  />
                                  <Popconfirm title="删除该任务？" onOk={() => deleteTask(t)}>
                                    <Button size="mini" type="text" status="danger" icon={<IconDelete />} />
                                  </Popconfirm>
                                </Space>
                              }
                            >
                              {t.content && (
                                <Paragraph style={{ marginBottom: 8, fontSize: 13 }}>
                                  {t.content}
                                </Paragraph>
                              )}
                              {/* 标签行：整卡可点后，这里需要挡住冒泡，否则复制编号/
                                打开移动菜单会顺带触发展开。 */}
                              <Space wrap onClick={(e) => e.stopPropagation()}>
                                {/* 任务编号放在卡片底部标签行，不再挤占标题空间；点击可复制 */}
                                <TaskCode code={t.code} />
                                <Tag color={PRIORITY_META[t.priority]?.color || 'gray'}>
                                  {PRIORITY_META[t.priority]?.label || t.priority}
                                </Tag>
                                {t.assignee && (
                                  <Tooltip
                                    content={
                                      leaseExpired(t)
                                        ? '租约已过期，随时会被回收'
                                        : `由 ${t.assignee} 持有至 ${fmtTs(t.lease_until)}`
                                    }
                                  >
                                    <Tag color={leaseExpired(t) ? 'red' : 'cyan'}>
                                      {leaseExpired(t) ? `${t.assignee} · 超时` : t.assignee}
                                    </Tag>
                                  </Tooltip>
                                )}
                                {(t.attempts || 0) > 0 && (
                                  <Tooltip content={t.last_error || '尚无错误详情'}>
                                    <Tag color="red">失败 {t.attempts} 次</Tag>
                                  </Tooltip>
                                )}
                                <Tooltip content="移动到其他面板">
                                  <Dropdown
                                    position="br"
                                    droplist={
                                      <Menu onClickMenuItem={(key) => moveTask(t, key)}>
                                        {COLUMNS.filter((c) => c !== s).map((c) => (
                                          <Menu.Item key={c}>{STATUS_META[c].label}</Menu.Item>
                                        ))}
                                      </Menu>
                                    }
                                  >
                                    <Button size="mini" type="text" icon={<IconSwap />} />
                                  </Dropdown>
                                </Tooltip>
                              </Space>
                            {expandedId === t.id && (
                              <TaskDetail
                                task={t}
                                tracks={tracks}
                                trackDraft={trackDraft}
                                setTrackDraft={setTrackDraft}
                                onSubmitTrack={() => submitTrack(t.id)}
                                onDelTrack={delTrack}
                                fmtTs={fmtTs}
                              />
                            )}
                          </Card>
                          ))}
                        </Space>
                      )}
                    </div>
                    <div style={{ marginTop: 12, flexShrink: 0 }}>
                      {adding === s && (
                      <Space style={{ width: '100%' }} direction="vertical" size={8}>
                        <Input
                          autoFocus
                          size="small"
                          placeholder="输入任务标题，回车添加"
                          value={draft[s]}
                          onChange={(v) => setDraft({ ...draft, [s]: v })}
                          onPressEnter={() => submitInline(s)}
                          disabled={busy}
                        />
                        <Space size={8}>
                          <Button
                            size="mini"
                            type="primary"
                            loading={busy}
                            onClick={() => submitInline(s)}
                          >
                            添加
                          </Button>
                          <Button
                            size="mini"
                            onClick={() => {
                              setAdding(null);
                              setDraft({ ...draft, [s]: '' });
                            }}
                          >
                            取消
                          </Button>
                        </Space>
                      </Space>
                    )}
                    </div>
                  </div>
                );
              })}
            </div>
          )
          }
        </Content>
      </Layout>

      <Modal
        title={projModal.editing ? '重命名项目' : '新建项目'}
        visible={projModal.open}
        onOk={submitProject}
        onCancel={() => setProjModal({ ...projModal, open: false })}
        confirmLoading={busy}
        okText="保存"
        cancelText="取消"
      >
        <Space direction="vertical" style={{ width: '100%' }} size={20}>
          <Field label="名称">
            <Input
              placeholder="项目名称"
              value={projModal.name}
              onChange={(v) => setProjModal({ ...projModal, name: v })}
            />
          </Field>
          <Field label="描述">
            <Input.TextArea
              placeholder="可选"
              value={projModal.description}
              onChange={(v) => setProjModal({ ...projModal, description: v })}
            />
          </Field>
        </Space>
      </Modal>

      <Modal
        title={taskModal.editing ? '编辑任务' : '新建任务'}
        visible={taskModal.open}
        onOk={submitTask}
        onCancel={() => setTaskModal({ ...taskModal, open: false })}
        confirmLoading={busy}
        okText="保存"
        cancelText="取消"
      >
        <Space direction="vertical" style={{ width: '100%' }} size={20}>
          <Field label="标题">
            <Input
              placeholder="任务标题"
              value={taskModal.title}
              onChange={(v) => setTaskModal({ ...taskModal, title: v })}
            />
          </Field>
          <Field label="内容">
            <Input.TextArea
              placeholder="任务内容"
              autoSize
              value={taskModal.content}
              onChange={(v) => setTaskModal({ ...taskModal, content: v })}
            />
          </Field>
          <Space size={20} wrap>
            <Field label="状态">
              <Select
                value={taskModal.status}
                style={{ width: 140 }}
                onChange={(v) => setTaskModal({ ...taskModal, status: v })}
                options={COLUMNS.map((s) => ({ value: s, label: STATUS_META[s].label }))}
              />
            </Field>
            <Field label="优先级">
              <Select
                value={taskModal.priority}
                style={{ width: 140 }}
                onChange={(v) => setTaskModal({ ...taskModal, priority: v })}
                options={Object.keys(PRIORITY_META).map((k) => ({
                  value: k,
                  label: PRIORITY_META[k].label,
                }))}
              />
            </Field>
          </Space>
        </Space>
      </Modal>
    </Layout>
  );
}
