// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';
import TransferQueue from './TransferQueue';
import type { TransferTask } from '@/shared/fileTransfer';
import type { TransferSummary } from './controller';

afterEach(cleanup);

function createTask(id: string, overrides: Partial<TransferTask> = {}): TransferTask {
  return {
    id,
    profileId: 'p1',
    sessionId: 's1',
    direction: 'upload',
    localPath: 'C:\\local\\file.txt',
    remotePath: '/remote/file.txt',
    temporaryPath: '/remote/.file.txt.trace-task.part',
    totalBytes: 1000,
    transferredBytes: 500,
    bytesPerSecond: 100,
    state: 'running',
    conflictPolicy: 'ask',
    verificationMode: 'size',
    retryCount: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    error: undefined,
    ...overrides,
  };
}

function defaultSummary(): TransferSummary {
  return { active: 0, failed: 0, progress: 0 };
}

function renderQueue(
  tasks: TransferTask[] = [],
  summary: TransferSummary = defaultSummary(),
  handlers: Partial<{
    onPause: ReturnType<typeof vi.fn>;
    onResume: ReturnType<typeof vi.fn>;
    onCancel: ReturnType<typeof vi.fn>;
    onRetry: ReturnType<typeof vi.fn>;
    onPauseAll: ReturnType<typeof vi.fn>;
    onResumeAll: ReturnType<typeof vi.fn>;
    onCancelAll: ReturnType<typeof vi.fn>;
    onClearCompleted: ReturnType<typeof vi.fn>;
  }> = {},
) {
  const defaultHandlers = {
    onPause: vi.fn(),
    onResume: vi.fn(),
    onCancel: vi.fn(),
    onRetry: vi.fn(),
    onPauseAll: vi.fn(),
    onResumeAll: vi.fn(),
    onCancelAll: vi.fn(),
    onClearCompleted: vi.fn(),
    ...handlers,
  };
  return render(
    <TransferQueue
      tasks={tasks}
      summary={summary}
      onPause={defaultHandlers.onPause}
      onResume={defaultHandlers.onResume}
      onCancel={defaultHandlers.onCancel}
      onRetry={defaultHandlers.onRetry}
      onPauseAll={defaultHandlers.onPauseAll}
      onResumeAll={defaultHandlers.onResumeAll}
      onCancelAll={defaultHandlers.onCancelAll}
      onClearCompleted={defaultHandlers.onClearCompleted}
    />,
  );
}

describe('TransferQueue', () => {
  it('renders task rows with direction, source, dest, progress, state', () => {
    const tasks = [
      createTask('t1', { direction: 'upload', localPath: 'C:\\src\\data.bin', remotePath: '/remote/data.bin', state: 'running', totalBytes: 2000, transferredBytes: 1000, bytesPerSecond: 500 }),
      createTask('t2', { direction: 'download', localPath: 'C:\\dst\\results.csv', remotePath: '/remote/results.csv', state: 'completed', totalBytes: 500, transferredBytes: 500 }),
    ];
    renderQueue(tasks);

    // Check direction icons via data-testid
    expect(screen.getByTestId('direction-icon-t1')).toBeTruthy();
    expect(screen.getByTestId('direction-icon-t2')).toBeTruthy();

    // Check source/dest info
    expect(screen.getByTestId('task-source-t1')).toHaveTextContent('data.bin');
    expect(screen.getByTestId('task-dest-t1')).toHaveTextContent('/remote/data.bin');
    expect(screen.getByTestId('task-source-t2')).toHaveTextContent('results.csv');
    expect(screen.getByTestId('task-dest-t2')).toHaveTextContent('C:\\dst\\results.csv');

    // Check progress bars
    expect(screen.getByTestId('progress-bar-t1')).toBeTruthy();
    expect(screen.getByTestId('progress-bar-t2')).toBeTruthy();

    // Check state badges
    expect(screen.getByTestId('state-badge-t1')).toHaveTextContent('传输中');
    expect(screen.getByTestId('state-badge-t2')).toHaveTextContent('已完成');
  });

  it('calls onPause when pause button is clicked', () => {
    const onPause = vi.fn();
    const tasks = [createTask('t1', { state: 'running' })];
    renderQueue(tasks, defaultSummary(), { onPause });

    const pauseBtn = screen.getByTestId('pause-btn-t1');
    fireEvent.click(pauseBtn);
    expect(onPause).toHaveBeenCalledWith('t1');
  });

  it('calls onResume when resume button is clicked', () => {
    const onResume = vi.fn();
    const tasks = [createTask('t1', { state: 'paused' })];
    renderQueue(tasks, defaultSummary(), { onResume });

    const resumeBtn = screen.getByTestId('resume-btn-t1');
    fireEvent.click(resumeBtn);
    expect(onResume).toHaveBeenCalledWith('t1');
  });

  it('calls onCancel when cancel button is clicked', () => {
    const onCancel = vi.fn();
    const tasks = [createTask('t1', { state: 'running' })];
    renderQueue(tasks, defaultSummary(), { onCancel });

    const cancelBtn = screen.getByTestId('cancel-btn-t1');
    fireEvent.click(cancelBtn);
    expect(onCancel).toHaveBeenCalledWith('t1');
  });

  it('calls onRetry when retry button is clicked', () => {
    const onRetry = vi.fn();
    const tasks = [createTask('t1', { state: 'failed' })];
    renderQueue(tasks, defaultSummary(), { onRetry });

    const retryBtn = screen.getByTestId('retry-btn-t1');
    fireEvent.click(retryBtn);
    expect(onRetry).toHaveBeenCalledWith('t1');
  });

  it('offers pause, resume and stop controls for the whole queue', () => {
    const onPauseAll = vi.fn();
    const onResumeAll = vi.fn();
    const onCancelAll = vi.fn();
    const tasks = [
      createTask('running', { state: 'running' }),
      createTask('paused', { state: 'paused' }),
    ];
    renderQueue(tasks, defaultSummary(), { onPauseAll, onResumeAll, onCancelAll });

    fireEvent.click(screen.getByTestId('pause-all-btn'));
    fireEvent.click(screen.getByTestId('resume-all-btn'));
    fireEvent.click(screen.getByTestId('cancel-all-btn'));

    expect(onPauseAll).toHaveBeenCalledOnce();
    expect(onResumeAll).toHaveBeenCalledOnce();
    expect(onCancelAll).toHaveBeenCalledOnce();
  });

  it('does not show a stop action for a completed task', () => {
    renderQueue([createTask('done', { state: 'completed' })]);
    expect(screen.queryByTestId('cancel-btn-done')).toBeNull();
  });

  it('filter tabs filter correctly — shows only Active tasks', () => {
    const tasks = [
      createTask('t1', { state: 'running' }),
      createTask('t2', { state: 'completed' }),
      createTask('t3', { state: 'failed' }),
    ];
    renderQueue(tasks);

    // Click "Active" filter tab
    const activeTab = screen.getByTestId('filter-tab-active');
    fireEvent.click(activeTab);

    // Should show only running task
    expect(screen.getByTestId('task-row-t1')).toBeTruthy();
    expect(screen.queryByTestId('task-row-t2')).toBeNull();
    expect(screen.queryByTestId('task-row-t3')).toBeNull();
  });

  it('filter tabs — Completed filter shows only completed tasks', () => {
    const tasks = [
      createTask('t1', { state: 'running' }),
      createTask('t2', { state: 'completed' }),
      createTask('t3', { state: 'failed' }),
    ];
    renderQueue(tasks);

    fireEvent.click(screen.getByTestId('filter-tab-completed'));
    expect(screen.queryByTestId('task-row-t1')).toBeNull();
    expect(screen.getByTestId('task-row-t2')).toBeTruthy();
    expect(screen.queryByTestId('task-row-t3')).toBeNull();
  });

  it('filter tabs — Failed filter shows only failed tasks', () => {
    const tasks = [
      createTask('t1', { state: 'running' }),
      createTask('t2', { state: 'failed' }),
    ];
    renderQueue(tasks);

    fireEvent.click(screen.getByTestId('filter-tab-failed'));
    expect(screen.queryByTestId('task-row-t1')).toBeNull();
    expect(screen.getByTestId('task-row-t2')).toBeTruthy();
  });

  it('collapsed state shows active count', () => {
    const tasks = [
      createTask('t1', { state: 'running' }),
      createTask('t2', { state: 'completed' }),
    ];
    const summary: TransferSummary = { active: 1, failed: 0, progress: 0.5 };
    renderQueue(tasks, summary);

    // Collapse
    fireEvent.click(screen.getByTestId('queue-toggle'));

    // Collapsed strip should show active count
    expect(screen.getByTestId('queue-collapsed')).toBeTruthy();
    expect(screen.getByTestId('queue-collapsed')).toHaveTextContent('1');
  });

  it('progress bar width matches percentage', () => {
    const tasks = [createTask('t1', { totalBytes: 1000, transferredBytes: 250 })];
    renderQueue(tasks);

    const progressInner = screen.getByTestId('progress-inner-t1');
    // 250/1000 = 25%
    expect(progressInner.style.width).toBe('25%');
  });

  it('ETA displays when bytesPerSecond > 0', () => {
    const tasks = [
      createTask('t1', { state: 'running', totalBytes: 10000, transferredBytes: 2000, bytesPerSecond: 1000 }),
    ];
    renderQueue(tasks);

    const etaEl = screen.getByTestId('eta-t1');
    // 8000 bytes / 1000 bps = 8s → should show something like "8s"
    expect(etaEl).toBeTruthy();
    expect(etaEl.textContent).toMatch(/8/);
  });

  it('clear completed button works', () => {
    const onClearCompleted = vi.fn();
    const tasks = [
      createTask('t1', { state: 'completed' }),
      createTask('t2', { state: 'cancelled' }),
      createTask('t3', { state: 'running' }),
    ];
    renderQueue(tasks, defaultSummary(), { onClearCompleted });

    const clearBtn = screen.getByTestId('clear-completed-btn');
    fireEvent.click(clearBtn);
    expect(onClearCompleted).toHaveBeenCalledOnce();
  });

  it('empty state shows "无传输任务"', () => {
    renderQueue([], defaultSummary());

    expect(screen.getByText('无传输任务')).toBeTruthy();
  });

  it('显示任务错误详情', () => {
    renderQueue([createTask('failed', { state: 'failed', error: 'disk quota exceeded' })]);
    expect(screen.getByRole('alert')).toHaveTextContent('disk quota exceeded');
  });

  it.each([
    { tasks: [], summary: defaultSummary(), expected: '暂无传输任务' },
    { tasks: [createTask('failed', { state: 'failed' })], summary: { active: 0, failed: 1, progress: 0.2 }, expected: '1 个失败' },
    { tasks: [createTask('paused', { state: 'paused' })], summary: defaultSummary(), expected: '传输已暂停' },
    { tasks: [createTask('done', { state: 'completed' })], summary: defaultSummary(), expected: '传输完成' },
  ])('折叠摘要区分空/失败/暂停/完成：$expected', ({ tasks, summary, expected }) => {
    renderQueue(tasks, summary);
    fireEvent.click(screen.getByTestId('queue-toggle'));
    expect(screen.getByTestId('queue-collapsed')).toHaveTextContent(expected);
  });
});
