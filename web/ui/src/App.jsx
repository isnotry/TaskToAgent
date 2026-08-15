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
} from '@arco-design/web-react';
import {
  IconPlus,
  IconEdit,
  IconDelete,
  IconRefresh,
} from '@arco-design/web-react/icon';

const { Sider, Content, Header } = Layout;
const { Title, Text, Paragraph } = Typography;

const STATUS_META = {
  todo: { label: '待办', color: 'gray' },
  doing: { label: '进行中', color: 'arcoblue' },
  done: { label: '已完成', color: 'green' },
};
const PRIORITY_META = {
  low: { label: '低', color: 'gray' },
  normal: { label: '普通', color: 'arcoblue' },
  high: { label: '高', color: 'red' },
};
const COLUMNS = ['todo', 'doing', 'done'];

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

  const tasksByCol = (s) => tasks.filter((t) => t.status === s);

  return (
    <Layout style={{ height: '100vh' }}>
      <Sider
        width={260}
        theme="light"
        style={{ borderRight: '1px solid var(--color-border-2)' }}
      >
        <div
          style={{
            padding: 16,
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
        <div style={{ overflowY: 'auto', height: 'calc(100vh - 56px)' }}>
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
                                {s !== 'todo' && (
                                  <Button size="mini" onClick={() => moveTask(t, 'todo')}>
                                    待办
                                  </Button>
                                )}
                                {s !== 'doing' && (
                                  <Button size="mini" onClick={() => moveTask(t, 'doing')}>
                                    进行中
                                  </Button>
                                )}
                                {s !== 'done' && (
                                  <Button
                                    size="mini"
                                    type="primary"
                                    status="success"
                                    onClick={() => moveTask(t, 'done')}
                                  >
                                    完成
                                  </Button>
                                )}
                              </Space>
                            </Card>
                          ))}
                        </Space>
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
