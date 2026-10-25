// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import ClusterJobStatusBar from './ClusterJobStatusBar';

function response(body: unknown, ok = true): Response {
  return { ok, status: ok ? 200 : 500, json: async () => body } as Response;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('ClusterJobStatusBar', () => {
  it('未连接集群时不请求接口，并提供计算资源入口', () => {
    const fetchMock = vi.fn();
    const onOpenDetails = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    render(<ClusterJobStatusBar onOpenDetails={onOpenDetails} />);

    expect(screen.getByText('未连接计算资源')).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /配置计算资源/ }));
    expect(onOpenDetails).toHaveBeenCalledOnce();
  });

  it('显示当前集群的运行、排队数量与任务摘要', async () => {
    const fetchMock = vi.fn(async () => response({
      scheduler: 'slurm',
      jobs: [
        { jobId: '101', name: 'align-a', status: 'RUN', queue: 'gpu' },
        { jobId: '102', name: 'align-b', status: 'RUN', queue: 'normal' },
        { jobId: '103', name: 'qc', status: 'PEND', queue: 'normal' },
      ],
    }));
    vi.stubGlobal('fetch', fetchMock);

    render(
      <ClusterJobStatusBar
        sessionId="ssh-2"
        targetLabel="alice@cluster"
        onOpenDetails={() => undefined}
        pollIntervalMs={60_000}
      />,
    );

    expect(await screen.findByText('运行 2')).toBeInTheDocument();
    expect(screen.getByText('排队 1')).toBeInTheDocument();
    expect(screen.getByText(/alice@cluster/)).toHaveTextContent('Slurm');
    expect(screen.getByText('align-a')).toBeInTheDocument();
    expect(screen.getByText('qc')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith('/api/jobs/summary', {
      headers: { 'X-SSH-Session-Id': 'ssh-2' },
    });
  });

  it('调度器探测未知时明确显示 unknown，不回退为 LSF', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response({ jobs: [], scheduler: 'unknown' })));
    render(<ClusterJobStatusBar sessionId="ssh-1" targetLabel="alice@cluster" onOpenDetails={() => undefined} />);
    expect(await screen.findByText(/alice@cluster/)).toHaveTextContent('调度器未知');
    expect(screen.getByText(/alice@cluster/)).not.toHaveTextContent('LSF');
  });

  it('详情按钮交给 App 打开完整作业面板', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response({ jobs: [], scheduler: 'lsf' })));
    const onOpenDetails = vi.fn();
    render(
      <ClusterJobStatusBar
        sessionId="ssh-1"
        onOpenDetails={onOpenDetails}
        pollIntervalMs={60_000}
      />,
    );

    await screen.findByText('当前没有运行或排队任务');
    fireEvent.click(screen.getByRole('button', { name: /详情/ }));
    expect(onOpenDetails).toHaveBeenCalledOnce();
  });

  it('刷新失败时保留入口并展示可重试错误', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response({ error: 'SSH 已断开' }, false)));
    render(
      <ClusterJobStatusBar
        sessionId="ssh-1"
        onOpenDetails={() => undefined}
        pollIntervalMs={60_000}
      />,
    );

    expect(await screen.findByText(/刷新失败：SSH 已断开/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '刷新集群任务' })).toBeInTheDocument();
  });
});
