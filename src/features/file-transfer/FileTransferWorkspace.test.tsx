// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { Socket } from 'socket.io-client';
import FileTransferWorkspace from './FileTransferWorkspace';
import { pauseTransfer } from './api';
import { createTransferTask } from './testFixtures';

vi.mock('./api', () => ({
  enqueueTransfer: vi.fn(), enqueueTransfersBatch: vi.fn(), pauseTransfer: vi.fn(),
  resumeTransfer: vi.fn(), cancelTransfer: vi.fn(), retryTransfer: vi.fn(),
  clearCompletedTransfers: vi.fn(), copyRemote: vi.fn(), renameRemote: vi.fn(),
  mkdirRemote: vi.fn(), statRemote: vi.fn(), walkRemote: vi.fn(), preflightRemoteCopy: vi.fn(),
}));
vi.mock('./FileTransferDrawer', () => ({ default: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('./LocalFilePane', () => ({ default: () => <div data-testid="local-file-pane" /> }));
vi.mock('./RemoteFilePane', () => ({ default: () => <div data-testid="remote-file-pane" /> }));
vi.mock('./HostManager', () => ({ default: () => <div data-testid="host-manager" /> }));
vi.mock('./TransferQueue', () => ({
  default: ({ tasks, onPause }: { tasks: Array<{ id: string; state: string }>; onPause: (id: string) => void }) => (
    <div>
      {tasks.map(task => <span key={task.id} data-testid="workspace-task-state">{task.state}</span>)}
      <button type="button" onClick={() => onPause('task-1')}>暂停测试任务</button>
    </div>
  ),
}));
vi.mock('./ConflictDialog', () => ({ default: () => null }));
vi.mock('./SearchPanel', () => ({ default: () => null }));
vi.mock('./SyncPlannerDialog', () => ({ default: () => null }));
vi.mock('./FilePreview', () => ({ default: () => null }));
vi.mock('./PickConfirmBar', () => ({ default: () => null }));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

function workspaceProps(socket?: Socket) {
  return {
    sessionId: 's1', connectionState: 'connected' as const, socket,
    onClose: vi.fn(), onToggleMaximize: vi.fn(),
    endpoints: [{ id: 'local', label: '本地' }, { id: 's1', label: '集群', home: '/home/u' }],
  };
}

describe('FileTransferWorkspace UX', () => {
  it('无 SSH 的本地工作台直接显示本地文件窗格', () => {
    render(<FileTransferWorkspace {...workspaceProps()} sessionId={null} connectionState="disconnected" />);
    expect(screen.getAllByTestId('local-file-pane').length).toBeGreaterThan(0);
    expect(screen.queryByTestId('host-manager')).not.toBeInTheDocument();
  });

  it('队列操作 HTTP 失败时回滚状态并显示错误', async () => {
    vi.mocked(pauseTransfer).mockRejectedValue(new Error('HTTP 500'));
    let update: ((task: ReturnType<typeof createTransferTask>) => void) | undefined;
    const socket = {
      on: vi.fn((event: string, handler: (task: ReturnType<typeof createTransferTask>) => void) => {
        if (event === 'transfer:updated') update = handler;
      }),
      off: vi.fn(),
    } as unknown as Socket;
    render(<FileTransferWorkspace {...workspaceProps(socket)} />);
    act(() => update?.(createTransferTask({ state: 'running' })));
    expect(screen.getByTestId('workspace-task-state')).toHaveTextContent('running');

    fireEvent.click(screen.getByRole('button', { name: '暂停测试任务' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('暂停失败：HTTP 500');
    expect(screen.getByTestId('workspace-task-state')).toHaveTextContent('running');
  });

  it('向主导航报告传输活动与失败角标数量', () => {
    const onTransferIndicatorsChange = vi.fn();
    let update: ((task: ReturnType<typeof createTransferTask>) => void) | undefined;
    const socket = {
      on: vi.fn((event: string, handler: (task: ReturnType<typeof createTransferTask>) => void) => {
        if (event === 'transfer:updated') update = handler;
      }),
      off: vi.fn(),
    } as unknown as Socket;
    render(<FileTransferWorkspace {...workspaceProps(socket)} onTransferIndicatorsChange={onTransferIndicatorsChange} />);
    act(() => update?.(createTransferTask({ state: 'failed' })));
    expect(onTransferIndicatorsChange).toHaveBeenLastCalledWith({ active: 0, failed: 1 });
  });
});
