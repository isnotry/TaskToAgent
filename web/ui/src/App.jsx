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
  IconMenuUnfold,
  IconRight,
  IconUser,
} from '@arco-design/web-react/icon';

const { Sider, Content, Header } = Layout;
const { Title, Text, Paragraph } = Typography;

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
// { sider: boolean | null, cols: { [projectId]: { [status]: boolean } } }
// null / undefined 均表示"用户没手动设置过"，按默认规则推导。
const LAYOUT_KEY = 'taskcli-ui-layout';
const EMPTY_LAYOUT = { sider: null, cols: {} };
function readLayout() {
  try {
    const raw = localStorage.getItem(LAYOUT_KEY);
    if (!raw) return { ...EMPTY_LAYOUT };
    const v = JSON.parse(raw);
    if (!v || typeof v !== 'object') return { ...EMPTY_LAYOUT };
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
    localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout));
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
        <Space size={8}>
          <Button type="primary" size="small" icon={<IconPlus />} onClick={onNew}>
            新建
          </Button>
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
                    }}
                  >
                    {open ? <IconDown /> : <IconRight />}
                  </span>
                  <Text bold={active} style={{ flex: 1, minWidth: 0 }} ellipsis>
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
                  ) : !rows || rows.length === 0 ? (
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      该看板暂无任务
                    </Text>
                  ) : (
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

  // 面板折叠（按项目分别记录）：undefined = 用户没手动设置过，走"任务数为 0 自动收起"；
  // 一旦用户点过折叠/展开，就以显式选择为准并持久化。
  const [colState, setColState] = useState(() => readLayout().cols);
  const cols = colState[selectedId] || {};
  const setCol = (s, v) =>
    setColState((prev) => ({ ...prev, [selectedId]: { ...(prev[selectedId] || {}), [s]: v } }));

  // 全局模糊搜索：searchQuery 为用户输入框内容；searchResults 为 null 表示未进入搜索态
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState(null);
  const [searching, setSearching] = useState(false);

  // 左侧项目栏：宽屏可收起（宽度归零），窄屏改为抽屉弹出
  // siderPref 为 null 表示用户没手动设置过，走默认：只有一个看板时收起
  const [siderPref, setSiderPref] = useState(() => readLayout().sider);
  const siderOpen = siderPref == null ? (projLoaded ? projects.length > 1 : true) : siderPref;
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
      const saved = localStorage.getItem('taskcli-theme');
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
      localStorage.setItem('taskcli-theme', theme);
    } catch {}
  }, [isDark]);

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

  // 布局偏好（左侧栏 + 各面板折叠）统一写回同一个 localStorage key
  useEffect(() => {
    writeLayout({ sider: siderPref, cols: colState });
  }, [siderPref, colState]);

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
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: 20,
            height: 'auto',
            minHeight: 64,
            padding: '12px 20px',
            borderBottom: '1px solid var(--color-border-2)',
            background: 'var(--color-bg-2)',
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              flex: 1,
              minWidth: 0,
            }}
          >
            <Tooltip content={isNarrow || !siderOpen ? '显示项目列表' : '收起项目列表'}>
              <Button
                type="text"
                icon={!isNarrow && siderOpen ? <IconMenuFold /> : <IconMenu />}
                onClick={openMenu}
              />
            </Tooltip>
            <div style={{ minWidth: 0 }}>
              <Title heading={5} style={{ margin: 0 }} ellipsis>
                {selected ? selected.name : '未选择项目'}
              </Title>
              {selected && selected.description && (
                <Text type="secondary" style={{ fontSize: 12 }}>
                  {selected.description}
                </Text>
              )}
            </div>
          </div>
          <Space size={12} style={{ flexShrink: 0 }}>
            <Input
              allowClear
              size="small"
              style={{ width: isNarrow ? 200 : 320 }}
              placeholder="模糊搜索任务（编号/标题/内容/项目）"
              prefix={<IconSearch />}
              value={searchQuery}
              onChange={(v) => setSearchQuery(v)}
              onClear={() => {
                setSearchQuery('');
                setSearchResults(null);
              }}
            />
            <Tooltip content={isDark ? '切换到浅色' : '切换到深色'}>
              <Button
                shape="circle"
                icon={isDark ? <IconSun /> : <IconMoon />}
                onClick={() => setIsDark((v) => !v)}
              />
            </Tooltip>
            <Tooltip
              content={
                syncedAt
                  ? `数据变化时才刷新（服务端 1s 探测一次）；上次同步 ${new Date(syncedAt).toLocaleTimeString('zh-CN')}`
                  : '数据变化时才刷新，没变化不会刷新'
              }
            >
              <Text type="secondary" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>
                {syncedAt ? `已同步 ${new Date(syncedAt).toLocaleTimeString('zh-CN')}` : '实时同步中'}
              </Text>
            </Tooltip>
            <Button
              type="primary"
              icon={<IconPlus />}
              onClick={openNewTask}
              disabled={!selected}
            >
              新建任务
            </Button>
          </Space>
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
          ) : (
            <div style={{ display: 'flex', gap: 16, height: '100%', overflowX: 'auto' }}>
              {COLUMNS.map((s) => {
                const list = tasksByCol(s);
                // 用户没手动干预过的面板，任务数为 0 时自动收起（加载中不判定，避免闪烁）
                const collapsed =
                  cols[s] !== undefined ? cols[s] : !loading && list.length === 0;
                return collapsed ? (
                  <div
                    key={s}
                    onClick={() => setCol(s, false)}
                    title={`展开「${STATUS_META[s].label}」`}
                    style={{
                      flex: '0 0 46px',
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'center',
                      gap: 10,
                      padding: '12px 0',
                      background: 'var(--color-fill-1)',
                      borderRadius: 10,
                      minWidth: 0,
                      cursor: 'pointer',
                    }}
                  >
                    <Tooltip content="展开面板">
                      <IconMenuUnfold style={{ fontSize: 14, color: 'var(--color-text-3)' }} />
                    </Tooltip>
                    <div
                      style={{
                        flex: 1,
                        display: 'flex',
                        alignItems: 'center',
                        writingMode: 'vertical-rl',
                        letterSpacing: 2,
                        fontSize: 13,
                        color: 'var(--color-text-2)',
                        overflow: 'hidden',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {STATUS_META[s].label} {list.length}
                    </div>
                    <Tooltip content="在此面板添加任务">
                      <Button
                        size="mini"
                        type="text"
                        icon={<IconPlus />}
                        onClick={(e) => {
                          e.stopPropagation();
                          setCol(s, false);
                          setAdding(s);
                        }}
                      />
                    </Tooltip>
                  </div>
                ) : (
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
                        <Tooltip content="收起面板">
                          <Button
                            size="mini"
                            type="text"
                            icon={<IconMenuFold />}
                            onClick={() => setCol(s, true)}
                          />
                        </Tooltip>
                      </Space>
                    </div>
                    <div style={{ overflowY: 'auto', flex: 1 }}>
                      {loading ? (
                        <Empty description="加载中…" style={{ marginTop: 24 }} />
                      ) : list.length === 0 ? (
                        <Empty
                          description="暂无"
                          style={{ marginTop: 24 }}
                          imageStyle={{ height: 40 }}
                        />
                      ) : (
                        <Space direction="vertical" style={{ width: '100%' }} size={12}>
                          {list.map((t) => (
                            <Card
                              key={t.id}
                              size="small"
                              hoverable
                              title={
                                <div
                                  onClick={() => toggleExpand(t.id)}
                                  style={{
                                    display: 'flex',
                                    alignItems: 'center',
                                    gap: 8,
                                    width: '100%',
                                    minWidth: 0,
                                    cursor: 'pointer',
                                  }}
                                >
                                  <span style={{ flexShrink: 0 }}>
                                    {expandedId === t.id ? <IconUp /> : <IconDown />}
                                  </span>
                                  {/* 标题独占整行：单行显示，过长以省略号收尾 */}
                                  <span
                                    title={t.title}
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
                                </div>
                              }
                              extra={
                                <Space size={2}>
                                  <Button
                                    size="mini"
                                    type="text"
                                    icon={<IconEdit />}
                                    onClick={() => openEditTask(t)}
                                  />
                                  <Popconfirm
                                    title="删除该任务？"
                                    onOk={() => deleteTask(t)}
                                  >
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
                              <Space wrap>
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
                              <div
                                style={{
                                  marginTop: 16,
                                  paddingTop: 14,
                                  borderTop: '1px solid var(--color-border-2)',
                                }}
                              >
                                <Space wrap size={[10, 10]} style={{ marginBottom: 14 }}>
                                  <Tag color={STATUS_META[t.status].color}>
                                    {STATUS_META[t.status].label}
                                  </Tag>
                                  <Tag color={PRIORITY_META[t.priority]?.color || 'gray'}>
                                    {PRIORITY_META[t.priority]?.label || t.priority}
                                  </Tag>
                                  <Text type="secondary" style={{ fontSize: 12 }}>
                                    创建 {fmtTs(t.created_at)}
                                  </Text>
                                  <Text type="secondary" style={{ fontSize: 12 }}>
                                    更新 {fmtTs(t.updated_at)}
                                  </Text>
                                  {t.assignee && (
                                    <Tag color={leaseExpired(t) ? 'red' : 'cyan'}>
                                      认领人 {t.assignee}
                                      {leaseExpired(t) ? '（租约超时）' : ''}
                                    </Tag>
                                  )}
                                </Space>
                                {(t.attempts || 0) > 0 && (
                                  <div style={{ fontSize: 12, marginBottom: 10 }}>
                                    <Tag color="red">失败 {t.attempts} 次</Tag>
                                    {t.last_error && (
                                      <Text type="secondary" style={{ fontSize: 12 }}>
                                        最近错误：{t.last_error}
                                      </Text>
                                    )}
                                  </div>
                                )}
                                {t.result && (
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
                                    {t.result}
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
                                          onClick={() => delTrack(tr.id)}
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
                                  onPressEnter={() => submitTrack(t.id)}
                                  style={{ marginTop: 12 }}
                                />
                              </div>
                            )}
                          </Card>
                          ))}
                        </Space>
                      )}
                    </div>
                    <div style={{ marginTop: 12, flexShrink: 0 }}>
                      {adding === s ? (
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
                      ) : (
                        <Button
                          long
                          size="small"
                          type="dashed"
                          icon={<IconPlus />}
                          onClick={() => setAdding(s)}
                          disabled={!selected}
                        >
                          添加任务
                        </Button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
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
