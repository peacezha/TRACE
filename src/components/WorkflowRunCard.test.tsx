// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import WorkflowRunCard from './WorkflowRunCard';
import type { Workflow } from '@/shared/workflow';
import type { WorkflowExecutionContext } from '@/shared/workflowExecution';
import { fetchWorkflowRuns, getCachedPreflight, listWorkflows, resumeWorkflowRun, type WorkflowRun } from '../features/workflows/api';

vi.mock('../features/workflows/api', async () => {
  const actual = await vi.importActual<typeof import('../features/workflows/api')>('../features/workflows/api');
  return {
    ...actual,
    fetchWorkflowRuns: vi.fn(async () => []),
    listWorkflows: vi.fn(async () => []),
    getCachedPreflight: vi.fn(async () => null),
    resumeWorkflowRun: vi.fn(),
  };
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const CONTEXT: WorkflowExecutionContext = {
  workflowId: 'wf-test',
  runId: 'run-1',
  runDir: '/home/u/trace_flows/test/03_workspace/runs/run-1',
  policy: 'isolated-run-v1',
};

function makeWorkflow(): Workflow {
  return {
    id: 'wf-test',
    name: '测试流程',
    description: '',
    keywords: [],
    params: [],
    steps: [{ title: '质控', command: 'fastqc' }, { title: '统计', command: 'stats' }],
    manifest: {
      software: [{ name: 'FastQC', module: 'FastQC/0.11.9', required: true }],
      references: [],
      qcGates: [],
    },
    source: 'user',
    createdAt: 0,
    updatedAt: 0,
  };
}

function makeRun(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    runId: 'run-1',
    workflowId: 'wf-test',
    workflowName: '测试流程',
    runDir: CONTEXT.runDir,
    status: 'running',
    currentStep: 1,
    totalSteps: 2,
    steps: [
      { n: 1, title: '质控', status: 'done', outputs: [`${CONTEXT.runDir}/results/qc.html`], qc: { status: 'pass' } },
      { n: 2, title: '统计', status: 'running' },
    ],
    reportPath: `${CONTEXT.runDir}/results/report.html`,
    ...overrides,
  };
}

describe('WorkflowRunCard', () => {
  it('keeps QC warnings visible when folded and requires confirmation before continuing', async () => {
    const failed = makeRun({ revision: 4, status: 'waiting_user', steps: [
      { n: 1, title: 'QC', status: 'done', qc: { status: 'fail', metrics: { FRiP: '0.005' } } },
      { n: 2, title: 'Next', status: 'pending' },
    ] });
    vi.mocked(fetchWorkflowRuns).mockResolvedValue([failed]);
    vi.mocked(listWorkflows).mockResolvedValue([makeWorkflow()]);
    vi.mocked(resumeWorkflowRun).mockResolvedValue({ ...failed, status: 'running', revision: 5,
      steps: failed.steps?.map(step => step.qc?.status === 'fail' ? { ...step, qcOverride: { approvedAt: 1000, revision: 4 } } : step) });
    const onSendMessage = vi.fn();
    render(<WorkflowRunCard context={CONTEXT} sessionId="s1" onSendMessage={onSendMessage} />);
    fireEvent.click(await screen.findByText('仍要继续（不推荐）'));
    expect(resumeWorkflowRun).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent('不建议继续下游分析');
    fireEvent.click(await screen.findByText('确认风险并继续'));
    await waitFor(() => expect(resumeWorkflowRun).toHaveBeenCalledWith(CONTEXT.runDir, 4, 's1', true));
    expect(onSendMessage).toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent('这不代表质控通过');
  });
  it('默认紧凑：显示流程名与状态徽章，步骤时间线折叠', async () => {
    vi.mocked(fetchWorkflowRuns).mockResolvedValue([makeRun()]);
    vi.mocked(listWorkflows).mockResolvedValue([makeWorkflow()]);
    render(<WorkflowRunCard context={CONTEXT} sessionId="s1" onSendMessage={() => {}} />);

    expect(await screen.findByText('run-1')).toBeInTheDocument();
    expect(screen.getByText('正式流程运行')).toBeInTheDocument();
    expect(screen.getByText('测试流程')).toBeInTheDocument();
    expect(screen.getByText('运行中')).toBeInTheDocument();
    expect(screen.queryByText('统计')).not.toBeInTheDocument();
  });

  it('展开后显示步骤时间线、环境区与输出结果，打开目录走回调', async () => {
    vi.mocked(fetchWorkflowRuns).mockResolvedValue([makeRun()]);
    vi.mocked(listWorkflows).mockResolvedValue([makeWorkflow()]);
    const onOpenRemoteFolder = vi.fn();
    render(<WorkflowRunCard context={CONTEXT} sessionId="s1" onSendMessage={() => {}} onOpenRemoteFolder={onOpenRemoteFolder} />);

    fireEvent.click(await screen.findByText('run-1'));
    // 步骤时间线 + 流程图都会显示步骤名（同一文本多处属预期）
    expect(screen.getAllByText(/质控/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/统计/).length).toBeGreaterThan(0);
    expect(screen.getByText('QC 通过')).toBeInTheDocument();
    // 环境区：懒加载缓存预检（mock 返回 null → 显示未检查项）
    expect(screen.getByText('执行环境')).toBeInTheDocument();
    await waitFor(() => expect(getCachedPreflight).toHaveBeenCalledWith('wf-test', 's1'));
    expect(screen.getByText('FastQC')).toBeInTheDocument();
    // 输出结果：产物路径 + 报告入口（RunItem 与输出区各有报告入口，均存在即可）
    expect(screen.getByText('输出结果')).toBeInTheDocument();
    expect(screen.getByText(`${CONTEXT.runDir}/results/qc.html`)).toBeInTheDocument();
    expect(screen.getAllByText('查看报告').length).toBeGreaterThan(0);

    fireEvent.click(screen.getByText('打开目录'));
    expect(onOpenRemoteFolder).toHaveBeenCalledWith(CONTEXT.runDir);
  });

  it('索引中找不到运行时给出空态而不是一直加载', async () => {
    vi.mocked(fetchWorkflowRuns).mockResolvedValue([]);
    render(<WorkflowRunCard context={CONTEXT} sessionId="s1" onSendMessage={() => {}} />);
    expect(await screen.findByText(/未找到该运行的最新状态/)).toBeInTheDocument();
    expect(screen.getByText(new RegExp(CONTEXT.runDir.replace(/[/.]/g, '\\$&')))).toBeInTheDocument();
  });

  it('无集群会话时不请求接口并提示', async () => {
    render(<WorkflowRunCard context={CONTEXT} sessionId={null} onSendMessage={() => {}} />);
    expect(await screen.findByText(/未连接计算资源/)).toBeInTheDocument();
    expect(fetchWorkflowRuns).not.toHaveBeenCalled();
  });

  it('提供 onOpenReport 时"查看报告"走侧边栏回调，不再开弹窗', async () => {
    vi.mocked(fetchWorkflowRuns).mockResolvedValue([makeRun()]);
    vi.mocked(listWorkflows).mockResolvedValue([makeWorkflow()]);
    const onOpenReport = vi.fn();
    render(<WorkflowRunCard context={CONTEXT} sessionId="s1" onSendMessage={() => {}} onOpenReport={onOpenReport} />);

    fireEvent.click(await screen.findByText('run-1'));
    fireEvent.click(screen.getAllByText('查看报告')[0]);

    expect(onOpenReport).toHaveBeenCalledWith(`${CONTEXT.runDir}/results/report.html`);
    // 回退弹窗未出现（ReportDialog 头部有"下载"链接）
    expect(screen.queryByText('下载')).not.toBeInTheDocument();
  });

  it('缺省 onOpenReport 时"查看报告"回退 ReportDialog 弹窗', async () => {
    vi.mocked(fetchWorkflowRuns).mockResolvedValue([makeRun()]);
    vi.mocked(listWorkflows).mockResolvedValue([makeWorkflow()]);
    render(<WorkflowRunCard context={CONTEXT} sessionId="s1" onSendMessage={() => {}} />);

    fireEvent.click(await screen.findByText('run-1'));
    fireEvent.click(screen.getAllByText('查看报告')[0]);

    expect(await screen.findByText('下载')).toBeInTheDocument();
  });

  it('输出区图片产物渲染缩略图，csv 产物可展开表格预览', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      const { path } = JSON.parse((init?.body as string) || '{}');
      return {
        ok: true,
        json: async () => ({ filePath: path, content: 'gene,count\nTP53,42', metadata: { size: 16, mime: 'text/csv' } }),
      } as Response;
    }));
    try {
      vi.mocked(fetchWorkflowRuns).mockResolvedValue([makeRun({
        steps: [
          { n: 1, title: '统计', status: 'done', outputs: [`${CONTEXT.runDir}/results/plot.png`, `${CONTEXT.runDir}/results/counts.csv`] },
        ],
      })]);
      vi.mocked(listWorkflows).mockResolvedValue([makeWorkflow()]);
      render(<WorkflowRunCard context={CONTEXT} sessionId="s1" onSendMessage={() => {}} />);

      fireEvent.click(await screen.findByText('run-1'));

      // 图片产物：缩略图直出集群 view URL，点击开全屏 lightbox
      const thumb = await screen.findByTestId('output-image-thumb');
      expect(thumb.getAttribute('src')).toBe(
        `/api/files/view?path=${encodeURIComponent(`${CONTEXT.runDir}/results/plot.png`)}&sessionId=s1`,
      );
      fireEvent.click(thumb);
      expect(screen.getByTestId('image-lightbox')).toBeInTheDocument();
      fireEvent.keyDown(window, { key: 'Escape' });

      // csv 产物：表格预览按钮拉取内容出 TableCard
      fireEvent.click(screen.getByRole('button', { name: /表格预览/ }));
      expect(await screen.findByText('TP53')).toBeInTheDocument();
      expect(screen.getByText('gene')).toBeInTheDocument();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('RUN 相对路径产物先解析为绝对路径再显示（图片直接出图而非文本链接）', async () => {
    vi.mocked(fetchWorkflowRuns).mockResolvedValue([makeRun({
      steps: [
        { n: 1, title: '统计', status: 'done', outputs: ['results/plot.png'] },
      ],
    })]);
    vi.mocked(listWorkflows).mockResolvedValue([makeWorkflow()]);
    render(<WorkflowRunCard context={CONTEXT} sessionId="s1" onSendMessage={() => {}} />);

    fireEvent.click(await screen.findByText('run-1'));

    const thumb = await screen.findByTestId('output-image-thumb');
    expect(thumb.getAttribute('src')).toBe(
      `/api/files/view?path=${encodeURIComponent(`${CONTEXT.runDir}/results/plot.png`)}&sessionId=s1`,
    );
  });
});
