import React, { useCallback, useEffect, useState } from 'react';
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
} from '@arco-design/web-react';
import {
  IconPlus,
  IconEdit,
  IconDelete,
  IconRefresh,
  IconSwap,
  IconMoon,
  IconSun,
} from '@arco-design/web-react/icon';

const { Sider, Content, Header } = Layout;
const { Title, Text, Paragraph } = Typography;

const STATUS_META = {
  idea: { label: '灵感区', color: 'orange' },
  todo: { label: '待办', color: 'gray' },
  doing: { label: '进行中', color: 'arcoblue' },
  done: { label: '已完成', color: 'green' },
  archive: { label: '存档', color: 'gray' },
};
const PRIORITY_META = {
  low: { label: '低', color: 'gray' },
  normal: { label: '普通', color: 'arcoblue' },
  high: { label: '高', color: 'red' },
};
// 列顺序：灵感区(第一) → 待办/进行中/已完成 → 存档(最后)
const COLUMNS = ['idea', 'todo', 'doing', 'done', 'archive'];

const BASE = '';
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
};

export default function App() {
  const [projects, setProjects] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [tasks, setTasks] = useState([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);

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
    document.body.classList.toggle('arco-theme-dark', isDark);
    try {
      localStorage.setItem('taskcli-theme', isDark ? 'dark' : 'light');
    } catch {}
  }, [isDark]);

  const loadProjects = useCallback(async () => {
    const list = await api.listProjects();
    setProjects(list);
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

  const selected = projects.find((p) => p.id === selectedId) || null;

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

  return (
    <Layout style={{ height: '100vh' }}>
      <Sider
        width={260}
        theme={isDark ? 'dark' : 'light'}
        style={{
          borderRight: '1px solid var(--color-border-2)',
          display: 'flex',
          flexDirection: 'column',
          height: '100vh',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            padding: 16,
            flexShrink: 0,
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
          }}
        >
          <Title heading={5} style={{ margin: 0 }}>
            看板
          </Title>
          <Button
            type="primary"
            size="small"
            icon={<IconPlus />}
            onClick={openNewProject}
          >
            新建
          </Button>
        </div>
        <div style={{ overflowY: 'auto', flex: 1, minHeight: 0 }}>
          {projects.length === 0 && (
            <Empty style={{ marginTop: 40 }} description="还没有项目" />
          )}
          {projects.map((p) => (
            <div
              key={p.id}
              onClick={() => setSelectedId(p.id)}
              style={{
                padding: '10px 16px',
                cursor: 'pointer',
                background: p.id === selectedId ? 'var(--color-fill-2)' : 'transparent',
                borderLeft:
                  p.id === selectedId
                    ? '3px solid var(--primary-6)'
                    : '3px solid transparent',
              }}
            >
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                }}
              >
                <Text bold={p.id === selectedId}>{p.name}</Text>
                <Space size={4}>
                  <Tooltip content="重命名">
                    <Button
                      size="mini"
                      type="text"
                      icon={<IconEdit />}
                      onClick={(e) => {
                        e.stopPropagation();
                        openRenameProject(p);
                      }}
                    />
                  </Tooltip>
                  <Popconfirm title="删除该项目及其任务？" onOk={() => deleteProject(p)}>
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
              <Text type="secondary" style={{ fontSize: 12 }}>
                {p.task_count ?? 0} 个任务
              </Text>
            </div>
          ))}
        </div>
      </Sider>

      <Layout>
        <Header
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            borderBottom: '1px solid var(--color-border-2)',
            background: 'var(--color-bg-2)',
          }}
        >
          <Title heading={5} style={{ margin: 0 }}>
            {selected ? selected.name : '未选择项目'}
          </Title>
          <Space>
            <Tooltip content={isDark ? '切换到浅色' : '切换到深色'}>
              <Button
                shape="circle"
                icon={isDark ? <IconSun /> : <IconMoon />}
                onClick={() => setIsDark((v) => !v)}
              />
            </Tooltip>
            <Button icon={<IconRefresh />} onClick={() => loadTasks(selectedId)}>
              刷新
            </Button>
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

        <Content style={{ padding: 16, overflow: 'hidden' }}>
          {!selected ? (
            <Empty
              description="请选择左侧项目，或新建一个看板"
              style={{ marginTop: 80 }}
            />
          ) : (
            <div style={{ display: 'flex', gap: 16, height: '100%' }}>
              {COLUMNS.map((s) => {
                const list = tasksByCol(s);
                return (
                  <div
                    key={s}
                    style={{
                      flex: 1,
                      display: 'flex',
                      flexDirection: 'column',
                      background: 'var(--color-fill-1)',
                      borderRadius: 8,
                      padding: 12,
                      minWidth: 0,
                    }}
                  >
                    <div
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        marginBottom: 12,
                      }}
                    >
                      <Tag color={STATUS_META[s].color}>{STATUS_META[s].label}</Tag>
                      <Text type="secondary">{list.length}</Text>
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
                        <Space direction="vertical" style={{ width: '100%' }} size={8}>
                          {list.map((t) => (
                            <Card
                              key={t.id}
                              size="small"
                              hoverable
                              title={t.title}
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
                                <Tag color={PRIORITY_META[t.priority]?.color || 'gray'}>
                                  {PRIORITY_META[t.priority]?.label || t.priority}
                                </Tag>
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
                            </Card>
                          ))}
                        </Space>
                      )}
                    </div>
                    <div style={{ marginTop: 8, flexShrink: 0 }}>
                      {adding === s ? (
                        <Space style={{ width: '100%' }} direction="vertical">
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
        <Space direction="vertical" style={{ width: '100%' }} size={12}>
          <div>
            <Text>名称</Text>
            <Input
              placeholder="项目名称"
              value={projModal.name}
              onChange={(v) => setProjModal({ ...projModal, name: v })}
            />
          </div>
          <div>
            <Text>描述</Text>
            <Input.TextArea
              placeholder="可选"
              value={projModal.description}
              onChange={(v) => setProjModal({ ...projModal, description: v })}
            />
          </div>
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
        <Space direction="vertical" style={{ width: '100%' }} size={12}>
          <div>
            <Text>标题</Text>
            <Input
              placeholder="任务标题"
              value={taskModal.title}
              onChange={(v) => setTaskModal({ ...taskModal, title: v })}
            />
          </div>
          <div>
            <Text>内容</Text>
            <Input.TextArea
              placeholder="任务内容"
              autoSize
              value={taskModal.content}
              onChange={(v) => setTaskModal({ ...taskModal, content: v })}
            />
          </div>
          <Space size={16}>
            <div>
              <Text>状态</Text>
              <br />
              <Select
                value={taskModal.status}
                style={{ width: 120 }}
                onChange={(v) => setTaskModal({ ...taskModal, status: v })}
                options={COLUMNS.map((s) => ({ value: s, label: STATUS_META[s].label }))}
              />
            </div>
            <div>
              <Text>优先级</Text>
              <br />
              <Select
                value={taskModal.priority}
                style={{ width: 120 }}
                onChange={(v) => setTaskModal({ ...taskModal, priority: v })}
                options={Object.keys(PRIORITY_META).map((k) => ({
                  value: k,
                  label: PRIORITY_META[k].label,
                }))}
              />
            </div>
          </Space>
        </Space>
      </Modal>
    </Layout>
  );
}
