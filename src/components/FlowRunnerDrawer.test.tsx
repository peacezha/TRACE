// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import FlowRunnerDrawer from './FlowRunnerDrawer';
import type { Workflow } from '@/shared/workflow';
import { createWorkflowRun, fetchWorkflowRuns, resumeWorkflowRun, runPreflightForConfig } from '../features/workflows/api';
import { LanguageToggle, LocaleProvider } from '../i18n';

vi.mock('../features/workflows/api', async () => {
  const actual = await vi.importActual<typeof import('../features/workflows/api')>('../features/workflows/api');
  return {
    ...actual,
    fetchWorkflowRuns: vi.fn(async () => []),
    createWorkflowRun: vi.fn(async (_id: string, _config: unknown) => ({
      runId: 'run-test-001',
      workflowId: 'wf-test',
      workflowName: '测试流程',
      runDir: '/home/u/trace_flows/test/03_workspace/runs/run-test-001',
      status: 'running',
      currentStep: 0,
      totalSteps: 1,
      steps: [{ n: 1, title: 's1', status: 'pending' }],
    })),
    // 启动前整体检查：默认全部就绪（无问题项），直接进入建运行
    runPreflightForConfig: vi.fn(async () => ({ ok: true, issues: [], preflight: null })),
    resumeWorkflowRun: vi.fn(async (runDir: string) => ({
      runId: 'run-failed', revision: 4, workflowId: 'wf-test', workflowName: '测试流程',
      runDir, status: 'running', currentStep: 1, totalSteps: 2,
      steps: [{ n: 1, title: 's1', status: 'failed' }, { n: 2, title: 's2', status: 'pending' }],
    })),
  };
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

function makeWorkflow(overrides: Partial<Workflow> = {}): Workflow {
  return {
    id: 'wf-test',
    name: '测试流程',
    description: '用于测试的流程',
    keywords: [],
    params: [
      { name: 'INPUT_DIR', label: '输入目录', type: 'path' },
      { name: 'QUEUE', label: '队列', type: 'select', options: ['normal', 'smp'], defaultValue: 'normal' },
      { name: 'THREADS', label: '线程数', type: 'number', defaultValue: '8' },
    ],
    steps: [{ title: 's1', command: 'echo hi' }],
    manifest: {
      software: [{ name: 'FastQC', module: 'FastQC/0.11.9', required: true }],
      references: [{ name: 'GTF', path: '{{GTF}}', type: 'annotation', required: true }],
      inputHint: 'FASTQ 目录',
      qcGates: [],
    },
    source: 'user',
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

describe('FlowRunnerDrawer', () => {
  it('switches the complete data-preparation block in both directions', async () => {
    const workflow = makeWorkflow({ manifest: undefined, params: [
      { name: 'SAMPLE_SHEET', label: '样本表', type: 'path' },
      { name: 'INPUT_JSON', label: '输入 JSON', type: 'path' },
    ] });
    const { container } = render(<LocaleProvider><LanguageToggle /><FlowRunnerDrawer workflow={workflow} onClose={vi.fn()} onRun={vi.fn()} /></LocaleProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'Switch to English' }));
    const summary = await screen.findByText('How do I prepare my data? (Formats, templates and AI assistance)');
    const block = summary.closest('details')!;
    await waitFor(() => expect(block.textContent).not.toMatch(/[\u3400-\u9fff]/));
    expect(block.querySelector('pre')?.textContent).toContain('replicate\tread1\tread2');
    expect(block.textContent).toContain('Copy template');
    fireEvent.click(screen.getByRole('button', { name: '切换到中文' }));
    await screen.findByText('数据怎么准备？（格式说明 + 模板 + AI 协助）');
    expect(container.textContent).toContain('复制模板');
  });
  it('switches workflow parameters, step counts and help in both directions while preserving paths and numeric values', async () => {
    window.localStorage.clear();
    const workflow = makeWorkflow({
      name: 'DAP-seq 转录因子结合位点分析与质控流程（中文版）',
      params: [
        { name: 'THREADS', label: '线程数', type: 'number', defaultValue: '8' },
        { name: 'REF_FA', label: '参考基因组 FASTA', type: 'path', defaultValue: '/ref/中文样本.fa' },
      ],
      steps: [{ title: '生物学重复 IDR 一致性评估', command: 'echo 原始命令' }],
    });
    render(<LocaleProvider><LanguageToggle /><FlowRunnerDrawer workflow={workflow} onClose={vi.fn()} onRun={vi.fn()} /></LocaleProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'Switch to English' }));
    await screen.findByText('DAP-seq Transcription-Factor Binding Analysis and QC');
    expect(screen.getByDisplayValue('/ref/中文样本.fa')).toBeTruthy();
    expect(screen.getByDisplayValue('8')).toBeTruthy();
    expect(screen.getByText('2 parameters')).toBeTruthy();
    expect(screen.getByText('1 step · Follow the workflow by default')).toBeTruthy();
    expect(screen.getByLabelText(/Threads/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '切换到中文' }));
    await screen.findByText(workflow.name);
    expect(screen.getByDisplayValue('/ref/中文样本.fa')).toBeTruthy();
    expect(screen.getByLabelText(/线程数/)).toBeTruthy();
    window.localStorage.clear();
  });
  it('blocks a new run for pending-disposal workflows without interrupting history', async () => {
    render(<FlowRunnerDrawer workflow={makeWorkflow({ lifecycle: { state: 'pending_disposal', origin: 'user', updatedAt: 1 } })} sessionId="session-test" onClose={vi.fn()} onRun={vi.fn()} />);
    expect(screen.getByText(/此流程在待弃置中/)).toBeTruthy();
    expect(screen.getByRole('button', { name: '运行流程' })).toBeDisabled();
    expect(createWorkflowRun).not.toHaveBeenCalled();
    await waitFor(() => expect(fetchWorkflowRuns).toHaveBeenCalled());
  });
  it('only sends the failed-QC override flag after explicit risk confirmation', async () => {
    const runDir = '/home/u/trace_flows/test/03_workspace/runs/qc-failed';
    vi.mocked(fetchWorkflowRuns).mockResolvedValueOnce([{
      runId: 'qc-failed', revision: 4, workflowId: 'wf-test', runDir,
      status: 'waiting_user', currentStep: 1, totalSteps: 2,
      steps: [{ n: 1, title: 'QC', status: 'done', qc: { status: 'fail', metrics: { FRiP: '0.005' } } },
        { n: 2, title: 'Next', status: 'pending' }],
    }]);
    render(<FlowRunnerDrawer workflow={makeWorkflow()} sessionId="s1" onClose={() => {}} onRun={() => {}} />);
    fireEvent.click(await screen.findByText('仍要继续（不推荐）'));
    expect(resumeWorkflowRun).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByText('确认风险并继续'));
    await waitFor(() => expect(resumeWorkflowRun).toHaveBeenCalledWith(runDir, 4, 's1', true));
  });
  it('默认突出专属工作目录，并把按需检查与高级设置折叠', () => {
    render(<FlowRunnerDrawer workflow={makeWorkflow()} onClose={() => {}} onRun={() => {}} />);
    expect(screen.getByText('测试流程')).toBeInTheDocument();
    expect(screen.getByText('专属工作目录')).toBeInTheDocument();
    expect(screen.getByText('强制隔离')).toBeInTheDocument();
    expect(screen.getByText('按需环境检查')).toBeInTheDocument();
    expect(screen.getByText('步骤、代码与高级设置')).toBeInTheDocument();
    expect(screen.getByText('数据选择')).toBeInTheDocument();
    expect(screen.getByText('全局参数')).toBeInTheDocument();
    expect(screen.getByText('任务监控')).toBeInTheDocument();
    // 软件项与占位参考数据
    expect(screen.getByText('FastQC')).toBeInTheDocument();
    expect(screen.getByText('GTF')).toBeInTheDocument();
    expect(screen.getByText(/运行时由参数指定/)).toBeInTheDocument();
    // 参数控件：select 选项与 number 默认值
    expect(screen.getByDisplayValue('normal')).toBeInTheDocument();
    expect(screen.getByDisplayValue('8')).toBeInTheDocument();
  });

  it('文献步骤显示可信度、证据与预期输入输出', () => {
    render(<FlowRunnerDrawer workflow={makeWorkflow({
      steps: [{
        title: 'STAR 比对', command: 'STAR',
        agent: {
          kind: 'compute', sourceType: 'repository', sourcePath: 'modules/star.nf', sourceSection: 'STAR_ALIGN',
          evidence: '仓库进程调用 STAR', confidence: 'low', inputs: ['FASTQ'], outputs: ['BAM'], requiresReview: true,
        },
      }],
    })} onClose={() => {}} onRun={() => {}} />);
    expect(screen.getByText('低可信')).toBeInTheDocument();
    expect(screen.getByText('运行前确认')).toBeInTheDocument();
    expect(screen.getByText(/仓库进程调用 STAR/)).toBeInTheDocument();
    expect(screen.getByText(/预期输出：BAM/)).toBeInTheDocument();
  });

  it('流程预览保留 workflow 的显式并行依赖，不降级成线性步骤链', async () => {
    const { container } = render(<FlowRunnerDrawer workflow={makeWorkflow({
      steps: [
        { id: 'prepare', title: '准备', command: 'echo prepare', dependsOn: [] },
        { id: 'star', title: 'STAR', command: 'echo star', dependsOn: ['prepare'] },
        { id: 'kallisto', title: 'Kallisto', command: 'echo kallisto', dependsOn: ['prepare'] },
        { id: 'report', title: '报告', command: 'echo report', dependsOn: ['star', 'kallisto'] },
      ],
    })} onClose={() => {}} onRun={() => {}} />);
    await waitFor(() => expect(container.querySelector('path[data-from="prepare"][data-to="star"]')).toBeTruthy());
    expect(container.querySelector('path[data-from="prepare"][data-to="kallisto"]')).toBeTruthy();
    expect(container.querySelector('path[data-from="kallisto"][data-to="report"]')).toBeTruthy();
    expect(container.querySelector('path[data-from="star"][data-to="kallisto"]')).toBeNull();
  });

  it('未选数据时点运行给出错误提示，选数据后先创建正式运行再触发 onRun', async () => {
    const onRun = vi.fn();
    const onClose = vi.fn();
    render(<FlowRunnerDrawer workflow={makeWorkflow()} sessionId="s1" onClose={onClose} onRun={onRun} />);
    fireEvent.click(screen.getByText('运行流程'));
    expect(onRun).not.toHaveBeenCalled();
    expect(screen.getByText(/请先选择要处理的数据/)).toBeInTheDocument();

    // 手动输入路径回车添加，INPUT_DIR 参数也填上
    const pathInput = screen.getByPlaceholderText('或手动输入计算资源路径后回车');
    fireEvent.change(pathInput, { target: { value: '/data/fastq' } });
    fireEvent.keyDown(pathInput, { key: 'Enter' });
    fireEvent.change(screen.getByPlaceholderText('INPUT_DIR'), { target: { value: '/data/fastq' } });
    fireEvent.click(screen.getByText('运行流程'));
    await waitFor(() => expect(onRun).toHaveBeenCalledTimes(1));
    const message = onRun.mock.calls[0][0] as string;
    // 启动正式运行 → 告知 App 开该次运行专属的对话
    expect(onRun.mock.calls[0][1]).toEqual({ dedicatedConversation: true });
    expect(createWorkflowRun).toHaveBeenCalledWith('wf-test', expect.objectContaining({
      inputs: ['/data/fastq'],
      params: expect.objectContaining({ INPUT_DIR: '/data/fastq', THREADS: '8' }),
    }), 's1');
    expect(message).not.toContain('/data/fastq');
    expect(message).not.toContain('THREADS = 8');
    expect(message).toContain('run-test-001');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('纯参数运维流程不要求也不显示数据目录', async () => {
    const onRun = vi.fn();
    render(<FlowRunnerDrawer workflow={makeWorkflow({
      name: '集群作业排查流程',
      params: [{ name: 'JOBID', label: '作业号' }],
      steps: [{ title: '查询作业', command: 'bjobs -l {{JOBID}}' }],
      manifest: { software: [], references: [], qcGates: [] },
    })} sessionId="s1" onClose={() => {}} onRun={onRun} />);

    expect(screen.queryByText('数据选择')).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText('或手动输入计算资源路径后回车')).not.toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText('JOBID'), { target: { value: '12345' } });
    fireEvent.click(screen.getByText('运行流程'));
    await waitFor(() => expect(onRun).toHaveBeenCalledTimes(1));
    expect(createWorkflowRun).toHaveBeenCalledWith('wf-test', expect.objectContaining({
      params: { JOBID: '12345' },
    }), 's1');
    expect(onRun.mock.calls[0][0]).not.toContain('JOBID = 12345');
  });

  it('必填参数未填时阻止运行', () => {
    const onRun = vi.fn();
    render(<FlowRunnerDrawer workflow={makeWorkflow()} sessionId="s1" onClose={() => {}} onRun={onRun} />);
    const pathInput = screen.getByPlaceholderText('或手动输入计算资源路径后回车');
    fireEvent.change(pathInput, { target: { value: '/data/fastq' } });
    fireEvent.keyDown(pathInput, { key: 'Enter' });
    fireEvent.click(screen.getByText('运行流程'));
    expect(onRun).not.toHaveBeenCalled();
    expect(screen.getByText(/参数未填写.*输入目录/)).toBeInTheDocument();
  });

  it('启动前整体检查发现问题时弹集中解答卡，解答重检通过后才创建运行', async () => {
    const onRun = vi.fn();
    vi.mocked(runPreflightForConfig)
      .mockResolvedValueOnce({
        ok: false,
        preflight: null,
        issues: [{ kind: 'reference', name: 'GTF', label: 'GTF', message: '待用户指定路径（GTF 未提供）', severity: 'blocker' }],
      })
      .mockResolvedValueOnce({ ok: true, issues: [], preflight: null });
    render(<FlowRunnerDrawer workflow={makeWorkflow()} sessionId="s1" onClose={() => {}} onRun={onRun} />);

    // 填好数据与必填参数后点运行 → 先整体检查，有 blocker → 弹集中解答卡，不建运行
    const pathInput = screen.getByPlaceholderText('或手动输入计算资源路径后回车');
    fireEvent.change(pathInput, { target: { value: '/data/fastq' } });
    fireEvent.keyDown(pathInput, { key: 'Enter' });
    fireEvent.change(screen.getByPlaceholderText('INPUT_DIR'), { target: { value: '/data/fastq' } });
    fireEvent.click(screen.getByText('运行流程'));
    expect(await screen.findByText('启动前整体检查')).toBeInTheDocument();
    expect(createWorkflowRun).not.toHaveBeenCalled();
    expect(screen.getByText('仍然开始运行').closest('button')).toBeDisabled();

    // 内联解答参考数据路径（写回 refOverrides）→ 重检通过 → 自动创建运行
    fireEvent.change(screen.getByLabelText('参考数据:GTF'), { target: { value: '/refs/gtf' } });
    fireEvent.click(screen.getByText('全部解决后重新检查'));
    await waitFor(() => expect(createWorkflowRun).toHaveBeenCalledTimes(1));
    expect(createWorkflowRun).toHaveBeenCalledWith('wf-test', expect.objectContaining({
      referenceOverrides: { GTF: '/refs/gtf' },
    }), 's1');
    await waitFor(() => expect(onRun).toHaveBeenCalledTimes(1));
    expect(onRun.mock.calls[0][0]).toContain('已完成启动前整体检查');
    expect(onRun.mock.calls[0][1]).toEqual({ dedicatedConversation: true });
  });

  it('path 型参数提供"选择文件"与"选择目录"两个入口，分别按 kind 选取并写回参数值', async () => {
    const onPickFolder = vi.fn(async (_kind?: string) => '/data/picked');
    render(<FlowRunnerDrawer workflow={makeWorkflow()} sessionId="s1" onClose={() => {}} onRun={() => {}} onPickFolder={onPickFolder} />);

    // path 参数（INPUT_DIR）渲染两个图标按钮；点击"选择文件"以 file 模式选取
    const pickFileButton = screen.getByTitle('选择文件');
    const pickFolderButton = screen.getByTitle('选择目录');
    expect(pickFileButton).toBeInTheDocument();
    expect(pickFolderButton).toBeInTheDocument();

    fireEvent.click(pickFileButton);
    await waitFor(() => expect(onPickFolder).toHaveBeenCalledWith('file'));
    await waitFor(() => expect(screen.getByDisplayValue('/data/picked')).toBeInTheDocument());

    fireEvent.click(pickFolderButton);
    await waitFor(() => expect(onPickFolder).toHaveBeenCalledWith('folder'));
  });

  it('数据选择卡按钮为"选择文件或目录"，以 any 模式选取并加入输入列表', async () => {
    const onPickFolder = vi.fn(async (_kind?: string) => '/data/reads.fastq');
    render(<FlowRunnerDrawer workflow={makeWorkflow()} sessionId="s1" onClose={() => {}} onRun={() => {}} onPickFolder={onPickFolder} />);

    fireEvent.click(screen.getByText('选择文件或目录'));
    await waitFor(() => expect(onPickFolder).toHaveBeenCalledWith('any'));
    expect(await screen.findByTitle('/data/reads.fastq')).toBeInTheDocument();
  });

  it('关闭按钮触发 onClose', () => {
    const onClose = vi.fn();
    render(<FlowRunnerDrawer workflow={makeWorkflow()} onClose={onClose} onRun={() => {}} />);
    fireEvent.click(screen.getByLabelText('关闭'));
    expect(onClose).toHaveBeenCalled();
  });

  it('无会话时运行按钮禁用', () => {
    render(<FlowRunnerDrawer workflow={makeWorkflow()} sessionId={null} onClose={() => {}} onRun={() => {}} />);
    expect(screen.getByText('运行流程').closest('button')).toBeDisabled();
  });

  it('本地工作台明确提示需要计算资源并提供连接入口', () => {
    const onConnectCompute = vi.fn();
    render(<FlowRunnerDrawer workflow={makeWorkflow()} sessionId="local-workbench" onClose={() => {}} onRun={() => {}} onConnectCompute={onConnectCompute} />);
    expect(screen.getByText(/流程运行需要计算资源/)).toBeInTheDocument();
    expect(screen.getByText('运行流程').closest('button')).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '连接计算资源' }));
    expect(onConnectCompute).toHaveBeenCalledOnce();
  });

  it('配置有修改时恢复默认必须确认，取消不会清空输入', () => {
    vi.stubGlobal('confirm', vi.fn(() => false));
    render(<FlowRunnerDrawer workflow={makeWorkflow()} onClose={() => {}} onRun={() => {}} />);
    const input = screen.getByPlaceholderText('或手动输入计算资源路径后回车');
    fireEvent.change(input, { target: { value: '/data/fastq' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.click(screen.getByRole('button', { name: '恢复默认' }));
    expect(window.confirm).toHaveBeenCalledOnce();
    expect(screen.getByText('/data/fastq')).toBeInTheDocument();
    vi.mocked(window.confirm).mockReturnValue(true);
    fireEvent.click(screen.getByRole('button', { name: '恢复默认' }));
    expect(screen.queryByText('/data/fastq')).not.toBeInTheDocument();
  });

  it('运行记录可以打开集群目录并从 revision 断点继续', async () => {
    const runDir = '/home/u/trace_flows/test/03_workspace/runs/run-failed';
    vi.mocked(fetchWorkflowRuns).mockResolvedValueOnce([{
      runId: 'run-failed', revision: 3, workflowId: 'wf-test', workflowName: '测试流程',
      runDir, status: 'failed', currentStep: 1, totalSteps: 2,
      steps: [{ n: 1, title: 's1', status: 'failed' }, { n: 2, title: 's2', status: 'pending' }],
    }]);
    const onRun = vi.fn();
    const onClose = vi.fn();
    const onOpenRunFolder = vi.fn();
    render(<FlowRunnerDrawer
      workflow={makeWorkflow({ steps: [{ title: 's1', command: 'echo 1' }, { title: 's2', command: 'echo 2' }] })}
      sessionId="s1"
      onClose={onClose}
      onRun={onRun}
      onOpenRunFolder={onOpenRunFolder}
    />);

    fireEvent.click(await screen.findByText('run-failed'));
    fireEvent.click(screen.getByText('打开运行文件夹'));
    expect(onOpenRunFolder).toHaveBeenCalledWith(runDir);

    fireEvent.click(screen.getByText('从断点继续'));
    await waitFor(() => expect(resumeWorkflowRun).toHaveBeenCalledWith(runDir, 3, 's1'));
    // 恢复正式运行同样开专属对话
    expect(onRun).toHaveBeenCalledWith(expect.stringContaining('继续成品流程'), { dedicatedConversation: true });
  });
});
