// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render as renderWithoutLocale, screen, fireEvent, cleanup, act } from '@testing-library/react';
import { LocaleProvider } from '../i18n';
import type { ReactNode } from 'react';
const render = (node: ReactNode) => renderWithoutLocale(node, { wrapper: LocaleProvider });
import WorkbenchSidebar, { type WorkbenchSidebarTab } from './WorkbenchSidebar';
import { listWorkflows } from '../features/workflows/api';
import type { Workflow } from '@/shared/workflow';
import type { ComputeBackendTarget } from './ComputeBackendDrawer';

vi.mock('../features/workflows/api', () => ({
  listWorkflows: vi.fn(async () => []),
}));
// 二级区子组件各自有独立测试，这里用桩件隔离侧栏布局逻辑
vi.mock('./ConversationList', () => ({ default: () => <div data-testid="conversation-list" /> }));
vi.mock('./ClusterFileTree', () => ({ default: () => <div data-testid="cluster-file-tree" /> }));

beforeEach(() => {
  // 默认桩掉计算资源页签的聚合轮询（/api/jobs/summary/all）；
  // “计算资源二级区”describe 内会用自己的可控 mock 覆盖
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ success: true, clusters: [] }),
  })));
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

const COMPUTE_TARGETS: ComputeBackendTarget[] = [
  { id: 'local-workbench', label: '本地 AI 工作台', detail: '无需服务器，可本地分析', kind: 'local' },
  { id: 'sess-1', label: 'user@hpc.example.edu', detail: 'hpc.example.edu:22 · SSH 已连接', kind: 'cluster' },
];

function makeProps(overrides: Partial<Parameters<typeof WorkbenchSidebar>[0]> = {}) {
  return {
    activeTab: 'conversations' as WorkbenchSidebarTab,
    onActiveTabChange: vi.fn(),
    connectedComputeCount: 1,
    onOpenQQBotSettings: vi.fn(),
    onOpenUpdateCenter: vi.fn(),
    theme: 'dark' as const,
    onToggleTheme: vi.fn(),
    sessionId: null,
    home: '',
    onLoadConversation: vi.fn(),
    onNewConversation: vi.fn(),
    onSelectWorkflow: vi.fn(),
    onManageWorkflows: vi.fn(),
    onSelectPath: vi.fn(),
    computeTargets: COMPUTE_TARGETS,
    activeComputeTargetId: 'local-workbench',
    onSelectComputeTarget: vi.fn(),
    onAddCluster: vi.fn(),
    onOpenComputeBackend: vi.fn(),
    ...overrides,
  };
}

function makeWorkflow(overrides: Partial<Workflow> = {}): Workflow {
  return {
    id: 'wf-1',
    name: '流程一',
    description: '',
    keywords: [],
    category: undefined,
    params: [],
    steps: [{ title: '步骤', command: 'echo hi' }],
    manifest: { software: [], references: [], qcGates: [] },
    source: 'user',
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

describe('WorkbenchSidebar 主导航', () => {
  it('保留 0.4.39 的紧凑四列导航、侧栏尺寸和简单品牌', () => {
    const { container } = render(<WorkbenchSidebar {...makeProps()} />);
    expect(container.querySelector('aside')).toHaveClass('w-[288px]', 'max-w-[34vw]', 'min-w-[232px]');
    expect(screen.getByRole('navigation', { name: '主导航' })).toHaveClass('grid-cols-4');
    expect(screen.getByRole('button', { name: '对话' })).toHaveClass('flex-col');
    expect(screen.queryByText('RESEARCH WORKSPACE')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '收起导航' })).not.toBeInTheDocument();
  });

  it('渲染品牌与横排四个主导航（数据资源在底部工具行），当前项高亮，计算资源带已连接数徽标', () => {
    render(<WorkbenchSidebar {...makeProps()} />);
    expect(screen.getByText('TRACE')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '对话' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /计算资源/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '文件' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '流程' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '数据资源' })).toBeInTheDocument();
    // 当前项高亮（aria-pressed），计算资源导航带已连接数量徽标
    expect(screen.getByRole('button', { name: '对话' })).toHaveAttribute('aria-pressed', 'true');
    const computeNav = screen.getByRole('button', { name: /计算资源/ });
    expect(computeNav.querySelector('span.rounded-full')?.textContent).toBe('1');
  });

  it('已连接数为 0 时计算资源导航不显示徽标', () => {
    render(<WorkbenchSidebar {...makeProps({ connectedComputeCount: 0 })} />);
    const computeNav = screen.getByRole('button', { name: '计算资源' });
    expect(computeNav.querySelector('span.rounded-full')).toBeNull();
  });

  it('文件导航显示传输活动或失败角标', () => {
    const { rerender } = render(<WorkbenchSidebar {...makeProps({ unreadCounts: { files: 2 } })} />);
    expect(screen.getByRole('button', { name: /文件/ }).querySelector('span.rounded-full')?.textContent).toBe('2');
    rerender(<WorkbenchSidebar {...makeProps({ unreadCounts: { files: 0 } })} />);
    expect(screen.getByRole('button', { name: '文件' }).querySelector('span.rounded-full')).toBeNull();
  });

  it('点击导航项触发切换回调', () => {
    const props = makeProps();
    render(<WorkbenchSidebar {...props} />);
    fireEvent.click(screen.getByRole('button', { name: /计算资源/ }));
    expect(props.onActiveTabChange).toHaveBeenCalledWith('compute');
  });
});

describe('WorkbenchSidebar 底部工具按钮', () => {
  it('主题/QQ/更新均为 icon + 文字标签，点击触发对应回调', () => {
    const props = makeProps();
    render(<WorkbenchSidebar {...props} />);
    // 文字标签（不允许纯 icon）
    expect(screen.getByText('主题')).toBeInTheDocument();
    expect(screen.getByText('QQ')).toBeInTheDocument();
    expect(screen.getByText('更新')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '切换主题' }));
    expect(props.onToggleTheme).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'QQ 机器人' }));
    expect(props.onOpenQQBotSettings).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '软件更新' }));
    expect(props.onOpenUpdateCenter).toHaveBeenCalled();
  });
});

describe('WorkbenchSidebar 二级区布局', () => {
  it('顶部显示当前 section 标题，对话区保留新任务按钮', () => {
    const props = makeProps();
    render(<WorkbenchSidebar {...props} />);
    // section 标题是 <p>（与主导航按钮的 <span> 文案区分）
    expect(screen.getByText('对话', { selector: 'p' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /新任务/ }));
    expect(props.onNewConversation).toHaveBeenCalled();
  });

  it('非对话区不显示新任务，标题跟随 section 切换', () => {
    const { rerender } = render(<WorkbenchSidebar {...makeProps({ activeTab: 'files' })} />);
    expect(screen.getByText('文件', { selector: 'p' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /新任务/ })).not.toBeInTheDocument();
    rerender(<WorkbenchSidebar {...makeProps({ activeTab: 'compute' })} />);
    expect(screen.getByText('计算资源', { selector: 'p' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /新任务/ })).not.toBeInTheDocument();
  });

  it('二级区跟随导航：对话列表 / 文件树', () => {
    const { rerender } = render(<WorkbenchSidebar {...makeProps()} />);
    expect(screen.getByTestId('conversation-list')).toBeInTheDocument();
    rerender(<WorkbenchSidebar {...makeProps({ activeTab: 'files' })} />);
    expect(screen.getByTestId('cluster-file-tree')).toBeInTheDocument();
  });
});

describe('WorkbenchSidebar 计算资源二级区', () => {
  // 集群条目的作业状态行来自聚合接口 /api/jobs/summary/all；桩掉 fetch 让轮询可预期
  let clustersPayload: unknown;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    clustersPayload = [
      { sessionId: 'sess-1', host: 'hpc.example.edu', username: 'user', scheduler: 'slurm', running: 2, pending: 1, updatedAt: 1_700_000_000_000 },
    ];
    fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ success: true, clusters: clustersPayload }),
    }));
    vi.stubGlobal('fetch', fetchMock);
  });

  it('计算目标清单摆到明面：本地工作台 + 已连接资源 + 添加入口 + 资源管理', () => {
    const props = makeProps({ activeTab: 'compute' });
    render(<WorkbenchSidebar {...props} />);

    expect(screen.getByText('计算目标')).toBeInTheDocument();
    expect(screen.getByText('没有计算资源也能用：本地 AI 可完成分析与对话')).toBeInTheDocument();
    expect(screen.getByText('本地 AI 工作台')).toBeInTheDocument();
    expect(screen.getByText('无需服务器，可本地分析')).toBeInTheDocument();
    expect(screen.getByText('user@hpc.example.edu')).toBeInTheDocument();

    fireEvent.click(screen.getByText('user@hpc.example.edu'));
    expect(props.onSelectComputeTarget).toHaveBeenCalledWith('sess-1');

    fireEvent.click(screen.getByRole('button', { name: /添加计算资源/ }));
    expect(props.onAddCluster).toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: '资源管理' }));
    expect(props.onOpenComputeBackend).toHaveBeenCalled();
  });

  it('集群条目按 sessionId 匹配聚合数据，显示"运行 X · 排队 Y"；本地工作台没有状态行', async () => {
    const { container } = render(<WorkbenchSidebar {...makeProps({ activeTab: 'compute' })} />);

    const statusLine = await screen.findByText('运行 2 · 排队 1');
    expect(statusLine).toBeInTheDocument();
    // 状态行挂在对应集群条目上（data 属性 = sessionId），并标注所属集群
    expect(container.querySelector('[data-cluster-jobs-status="sess-1"]')).toBe(statusLine);
    expect(statusLine).toHaveAttribute('title', 'user@hpc.example.edu 的调度器作业');
    // 本地 AI 工作台不是 SSH 会话，不渲染状态行
    expect(screen.queryByText('查询中…')).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith('/api/jobs/summary/all');
  });

  it('运行与排队都为 0 时显示"无作业"', async () => {
    clustersPayload = [
      { sessionId: 'sess-1', host: 'hpc.example.edu', username: 'user', scheduler: 'lsf', running: 0, pending: 0, updatedAt: 1 },
    ];
    render(<WorkbenchSidebar {...makeProps({ activeTab: 'compute' })} />);
    expect(await screen.findByText('无作业')).toBeInTheDocument();
  });

  it('该集群采集失败（条目级 error）时显示"状态未知"', async () => {
    clustersPayload = [
      { sessionId: 'sess-1', host: 'hpc.example.edu', username: 'user', scheduler: null, running: 0, pending: 0, updatedAt: 1, error: '查询超时' },
    ];
    render(<WorkbenchSidebar {...makeProps({ activeTab: 'compute' })} />);
    expect(await screen.findByText('状态未知')).toBeInTheDocument();
  });

  it('无已连接集群时不发聚合请求', async () => {
    render(<WorkbenchSidebar {...makeProps({
      activeTab: 'compute',
      computeTargets: [{ id: 'local-workbench', label: '本地 AI 工作台', detail: '无需服务器，可本地分析', kind: 'local' }],
    })} />);
    await act(async () => undefined);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('WorkbenchSidebar 流程二级区', () => {
  it('流程按分类分组渲染，组头可折叠', async () => {
    vi.mocked(listWorkflows).mockResolvedValue([
      makeWorkflow({ id: 'wf-1', name: '变异检测流程', category: '基因组与变异分析' }),
      makeWorkflow({ id: 'wf-2', name: '未分类流程' }),
    ]);
    render(<WorkbenchSidebar {...makeProps({ activeTab: 'workflows' })} />);

    const groupHeader = await screen.findByRole('button', { name: '基因组与变异分析（1）' });
    expect(screen.getByRole('button', { name: '其他（1）' })).toBeInTheDocument();
    expect(screen.getByText('变异检测流程')).toBeInTheDocument();
    expect(screen.getByText('未分类流程')).toBeInTheDocument();

    // 折叠组头后组内流程隐藏，再点展开恢复
    fireEvent.click(groupHeader);
    expect(screen.queryByText('变异检测流程')).not.toBeInTheDocument();
    expect(screen.getByText('未分类流程')).toBeInTheDocument();
    fireEvent.click(groupHeader);
    expect(screen.getByText('变异检测流程')).toBeInTheDocument();
  });

  it('保留管理流程入口（侧栏顶部 section 标题旁）', async () => {
    const props = makeProps({ activeTab: 'workflows' });
    render(<WorkbenchSidebar {...props} />);
    await screen.findByText('管理流程');
    fireEvent.click(screen.getByText('管理流程'));
    expect(props.onManageWorkflows).toHaveBeenCalled();
  });

  it('流程条目只显示名称一行，描述移到 title 提示', async () => {
    vi.mocked(listWorkflows).mockResolvedValue([
      makeWorkflow({ id: 'wf-1', name: '变异检测流程', description: '从 FASTQ 到 VCF 的完整分析流程' }),
    ]);
    render(<WorkbenchSidebar {...makeProps({ activeTab: 'workflows' })} />);

    const item = await screen.findByRole('button', { name: '变异检测流程' });
    // 列表内不再渲染描述小字，描述只在悬停提示里
    expect(item).toHaveAttribute('title', '从 FASTQ 到 VCF 的完整分析流程');
    expect(screen.queryByText('从 FASTQ 到 VCF 的完整分析流程')).not.toBeInTheDocument();
  });

  it('无描述的流程条目 title 回退为步骤数提示', async () => {
    vi.mocked(listWorkflows).mockResolvedValue([
      makeWorkflow({ id: 'wf-1', name: '两步流程', description: '', steps: [
        { title: '步骤一', command: 'echo 1' },
        { title: '步骤二', command: 'echo 2' },
      ] }),
    ]);
    render(<WorkbenchSidebar {...makeProps({ activeTab: 'workflows' })} />);

    const item = await screen.findByRole('button', { name: '两步流程' });
    expect(item).toHaveAttribute('title', '2 个步骤');
  });

  it('流程条目带真实“配置并运行”按钮，点击选中该流程（与点条目同通路）', async () => {
    const props = makeProps({ activeTab: 'workflows' });
    vi.mocked(listWorkflows).mockResolvedValue([
      makeWorkflow({ id: 'wf-1', name: '变异检测流程' }),
    ]);
    render(<WorkbenchSidebar {...props} />);

    const runButton = await screen.findByRole('button', { name: '配置并运行' });
    expect(runButton).toHaveAttribute('title', '配置并运行');
    fireEvent.click(runButton);
    expect(props.onSelectWorkflow).toHaveBeenCalledWith(expect.objectContaining({ id: 'wf-1' }));
  });
});
