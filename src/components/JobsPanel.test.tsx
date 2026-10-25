// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';
import JobsPanel from './JobsPanel';

interface MockData {
  jobs?: unknown[];
  processes?: unknown[];
  events?: unknown[];
  config?: unknown;
  scheduler?: string;
}

function mockFetch(data: MockData) {
  const impl = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const respond = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as Response;
    if (url.includes('/api/jobs/events')) return respond({ events: data.events ?? [] });
    if (url.includes('/api/notify/config')) return respond({ config: data.config ?? null });
    if (url.includes('/api/jobs/scheduler')) return respond({ scheduler: data.scheduler ?? 'lsf' });
    if (url.includes('/api/jobs')) return respond({ jobs: data.jobs ?? [], processes: data.processes ?? [] });
    return respond({});
  });
  vi.stubGlobal('fetch', impl);
  return impl;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function makeEvent(overrides: Record<string, unknown> = {}) {
  return {
    jobId: '101',
    name: 'blastx',
    status: 'DONE',
    queue: 'normal',
    time: 1_700_000_000_000,
    notified: true,
    ...overrides,
  };
}

describe('JobsPanel 完成事件输出摘要', () => {
  it('点击事件展开 excerpt（等宽 pre），再次点击收起', async () => {
    mockFetch({ events: [makeEvent({ excerpt: 'line1\nline2' })] });
    render(<JobsPanel isOpen onClose={() => undefined} sessionId={null} />);

    const row = await screen.findByRole('button', { name: /blastx/ });
    expect(row).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText(/line1/)).not.toBeInTheDocument();

    fireEvent.click(row);
    expect(row).toHaveAttribute('aria-expanded', 'true');
    const excerpt = screen.getByText(/line1/);
    expect(excerpt.tagName).toBe('PRE');
    expect(excerpt.textContent).toBe('line1\nline2');

    fireEvent.click(row);
    expect(screen.queryByText(/line1/)).not.toBeInTheDocument();
  });

  it('无 excerpt 的事件展开后显示“无输出摘要”', async () => {
    mockFetch({ events: [makeEvent()] });
    render(<JobsPanel isOpen onClose={() => undefined} sessionId={null} />);

    fireEvent.click(await screen.findByRole('button', { name: /blastx/ }));
    expect(await screen.findByText('无输出摘要')).toBeInTheDocument();
  });

  it('多条事件各自独立展开', async () => {
    mockFetch({
      events: [
        makeEvent({ jobId: '101', name: 'job-a', time: 1_700_000_000_000, excerpt: 'out-a' }),
        makeEvent({ jobId: '102', name: 'job-b', time: 1_700_000_100_000, excerpt: 'out-b' }),
      ],
    });
    render(<JobsPanel isOpen onClose={() => undefined} sessionId={null} />);

    fireEvent.click(await screen.findByRole('button', { name: /job-a/ }));
    expect(screen.getByText('out-a')).toBeInTheDocument();
    expect(screen.queryByText('out-b')).not.toBeInTheDocument();
  });
});

describe('JobsPanel 通知渠道提示', () => {
  it('未启用通知时提示可配置飞书/邮件，点击展开通知设置', async () => {
    mockFetch({ config: { enabled: false, channel: 'feishu' }, events: [makeEvent()] });
    render(<JobsPanel isOpen onClose={() => undefined} sessionId={null} />);

    const hint = await screen.findByText('可在通知设置里配置飞书/邮件推送作业完成消息');
    expect(screen.queryByText('通知渠道')).not.toBeInTheDocument();
    fireEvent.click(within(hint.parentElement as HTMLElement).getByRole('button', { name: '通知设置' }));
    expect(await screen.findByText('通知渠道')).toBeInTheDocument();
  });

  it('开关打开但渠道必填项缺失时同样提示', async () => {
    mockFetch({ config: { enabled: true, channel: 'feishu' }, events: [] });
    render(<JobsPanel isOpen onClose={() => undefined} sessionId={null} />);
    expect(await screen.findByText('可在通知设置里配置飞书/邮件推送作业完成消息')).toBeInTheDocument();
  });

  it('渠道已配置时不显示提示', async () => {
    mockFetch({
      config: { enabled: true, channel: 'feishu', webhook: 'https://open.feishu.cn/open-apis/bot/v2/hook/x' },
      events: [],
    });
    render(<JobsPanel isOpen onClose={() => undefined} sessionId={null} />);
    await screen.findByText(/完成事件/);
    expect(screen.queryByText('可在通知设置里配置飞书/邮件推送作业完成消息')).not.toBeInTheDocument();
  });

  it('调度器未知时明确展示，不回退为 LSF', async () => {
    mockFetch({ scheduler: 'unknown', events: [] });
    render(<JobsPanel isOpen onClose={() => undefined} sessionId="ssh-1" />);
    expect(await screen.findByDisplayValue('调度器未知')).toBeInTheDocument();
  });
});
