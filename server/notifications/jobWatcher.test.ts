import { describe, expect, it, vi } from 'vitest';
import { detectFinishedJobs, JobWatcher, loadJobEvents, type JobEvent, type WatchSessionLike } from './jobWatcher';
import type { JobEntry } from '../ai/types';
import type { NotifyConfig } from './notifyService';

// poll 级测试会把 job-events.json 落到 dataPath：把 paths 整体指到独立临时目录，
// 避免测试写进真实数据目录（mock 在模块加载前生效，EVENTS_PATH 也随之重定向）。
vi.mock('../paths', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jobwatcher-test-'));
  return {
    APP_ROOT: root,
    STATIC_ROOT: root,
    DATA_ROOT: root,
    appPath: (...segments: string[]) => path.join(root, ...segments),
    staticPath: (...segments: string[]) => path.join(root, ...segments),
    dataPath: (...segments: string[]) => path.join(root, ...segments),
    ensureDir: (dir: string) => { fs.mkdirSync(dir, { recursive: true }); return dir; },
  };
});

function job(jobId: string, status: JobEntry['status'], name = 'job-' + jobId): JobEntry {
  return { jobId, name, status, cores: 1, queue: 'normal', runtime: '' };
}

describe('detectFinishedJobs', () => {
  it('RUN → DONE 检出完成', () => {
    const finished = detectFinishedJobs(
      [job('1', 'RUN')],
      [job('1', 'DONE')],
    );
    expect(finished).toEqual([{ jobId: '1', name: 'job-1', status: 'DONE', queue: 'normal' }]);
  });

  it('RUN → EXIT 检出失败', () => {
    const finished = detectFinishedJobs([job('2', 'RUN')], [job('2', 'EXIT')]);
    expect(finished[0]?.status).toBe('EXIT');
  });

  it('在跑作业从列表消失视为完成', () => {
    const finished = detectFinishedJobs([job('3', 'RUN'), job('4', 'PEND')], []);
    expect(finished.map(f => f.jobId).sort()).toEqual(['3', '4']);
  });

  it('早已完成的作业不重复检出', () => {
    expect(detectFinishedJobs([job('5', 'DONE')], [job('5', 'DONE')])).toHaveLength(0);
  });

  it('仍在 RUN/PEND 的作业不检出', () => {
    expect(detectFinishedJobs([job('6', 'RUN')], [job('6', 'RUN')])).toHaveLength(0);
  });

  it('新增在跑作业不误报', () => {
    expect(detectFinishedJobs([], [job('7', 'RUN')])).toHaveLength(0);
  });
});

describe('JobWatcher.trackJobs', () => {
  it('立即把 Agent 新提交的作业加入下一轮对比基线，并隔离不同集群', () => {
    const watcher = new JobWatcher();
    watcher.trackJobs('cluster-a', ['101', '101', 'bad;id']);
    watcher.trackJobs('cluster-b', ['101']);
    const snapshots = (watcher as any).prevJobs as Map<string, JobEntry[]>;
    expect(snapshots.get('cluster-a')).toEqual([
      expect.objectContaining({ jobId: '101', status: 'UNKNOWN' }),
    ]);
    expect(snapshots.get('cluster-b')).toEqual([
      expect.objectContaining({ jobId: '101', status: 'UNKNOWN' }),
    ]);
  });
});

// ── poll 级测试（lsf；scheduler-config.json 缺省即 lsf）─────────────────────

const BJOBS_HEADER = 'JOBID USER STAT QUEUE FROM_HOST EXEC_HOST JOB_NAME SUBMIT_TIME';

function bjobsRaw(...rows: string[]): string {
  return [BJOBS_HEADER, ...rows].join('\n') + '\n';
}

interface PollHarness {
  watcher: JobWatcher;
  session: WatchSessionLike;
  exec: ReturnType<typeof vi.fn>;
  emitEvent: ReturnType<typeof vi.fn>;
  poll: (sessionId?: string) => Promise<void>;
  events: () => JobEvent[];
}

function makePollHarness(options: {
  exec: (cmd: string) => string | Promise<string>;
  hasPendingBinding?: (sessionId: string, jobId: string) => boolean;
}): PollHarness {
  const emitted: JobEvent[] = [];
  const exec = vi.fn(options.exec);
  const emitEvent = vi.fn((event: JobEvent) => { emitted.push(event); });
  const watcher = new JobWatcher({
    emitEvent,
    getNotifyConfig: async () => ({ enabled: false, channel: 'feishu' }) as NotifyConfig,
    hasPendingBinding: options.hasPendingBinding,
  });
  const session: WatchSessionLike = { cluster: { exec }, username: 'u' };
  return {
    watcher,
    session,
    exec,
    emitEvent,
    poll: (sessionId = 'sess-1') => (watcher as any).poll(sessionId, session) as Promise<void>,
    events: () => emitted,
  };
}

describe('JobWatcher.poll excerpt 与首轮绑定例外', () => {
  it('does not turn missing, unavailable or still-active LSF accounting into DONE; retries without losing the job', async () => {
    let state = '';
    const h = makePollHarness({ exec: cmd => {
      if (cmd.includes('bjobs -w')) return bjobsRaw();
      if (cmd.includes('bjobs -a')) { if (state === 'ERROR') throw new Error('connection failed'); return state; }
      return '';
    } });
    h.watcher.trackJobs('sess-1', ['111']);
    for (state of ['', 'ERROR', 'RUN']) {
      await h.poll();
      expect(h.events()).toHaveLength(0);
      expect((h.watcher as any).prevJobs.get('sess-1')).toEqual([expect.objectContaining({ jobId: '111', status: 'UNKNOWN' })]);
    }
    state = 'DONE';
    await h.poll();
    expect(h.events()).toEqual([expect.objectContaining({ jobId: '111', status: 'DONE' })]);
  });

  it('LSF 已跟踪作业按 ID 定点查询（一条命令查全部），消失作业走 30s 终态补查', async () => {
    let targeted = '111 RUN\n222 PEND\n';
    const h = makePollHarness({ exec: cmd => {
      if (cmd.includes('bjobs -noheader')) return targeted;
      if (cmd.includes('bjobs -a')) return 'DONE\n';
      return '';
    } });
    h.watcher.trackJobs('sess-1', ['111', '222']);
    await h.poll();
    // 定点查询：远端 timeout 50 自杀包装，本地 60s；不再全量 bjobs -w
    expect(h.exec).toHaveBeenCalledWith('timeout 50 bjobs -noheader -o "jobid stat" 111 222 2>/dev/null; true', 60_000);
    expect(h.exec.mock.calls.some(([cmd]) => String(cmd).includes('bjobs -w'))).toBe(false);
    expect(h.events()).toHaveLength(0); // 两个作业都还在跑
    // 下一轮 111 从定点结果消失 → 终态补查（远端 timeout 25，本地 30s）→ DONE 事件
    targeted = '222 PEND\n';
    await h.poll();
    expect(h.exec).toHaveBeenCalledWith('timeout 25 bjobs -a -noheader -o stat 111 2>/dev/null | head -1', 30_000);
    expect(h.events()).toEqual([expect.objectContaining({ jobId: '111', status: 'DONE' })]);
  });

  it('requires explicit terminal Slurm/PBS accounting and serializes overlapping polls', async () => {
    const h = makePollHarness({ exec: () => '' });
    const watcher = h.watcher as any;
    for (const raw of ['', 'RUNNING', 'PENDING']) {
      h.exec.mockResolvedValue(raw);
      expect(await watcher.resolveSlurmFinalStatus(h.session, '222')).toBeUndefined();
    }
    h.exec.mockResolvedValue('FAILED');
    expect(await watcher.resolveSlurmFinalStatus(h.session, '222')).toBe('EXIT');
    h.exec.mockResolvedValue('COMPLETED');
    expect(await watcher.resolveSlurmFinalStatus(h.session, '222')).toBe('DONE');
    h.exec.mockResolvedValue('job_state = R\nExit_status = 0');
    expect(await watcher.resolvePbsFinalStatus(h.session, '222')).toBeUndefined();
    h.exec.mockResolvedValue('job_state = F\nExit_status = 0');
    expect(await watcher.resolvePbsFinalStatus(h.session, '222')).toBe('DONE');
    let release!: (raw: string) => void;
    h.exec.mockImplementation(() => new Promise<string>(resolve => { release = resolve; }));
    const first = h.poll();
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    const calls = h.exec.mock.calls.length;
    await h.poll();
    expect(h.exec.mock.calls.length).toBe(calls);
    release(bjobsRaw());
    await first;
  });

  it('PBS C/F 仍在列表时也补查 Exit_status，无法核实则保留 UNKNOWN 下轮重试', async () => {
    let firstExit = '';
    const h = makePollHarness({ exec: cmd => {
      if (cmd.includes('qstat -u')) return [
        'Job ID Name User Time Use S Queue',
        '501.mgr first u 00:00:00 C batch',
        '502.mgr second u 00:00:00 F batch',
      ].join('\n');
      if (cmd.includes('qstat -x -f 501')) return `job_state = C${firstExit}`;
      if (cmd.includes('qstat -x -f 502')) return 'job_state = F Exit_status = 3';
      return '';
    } });
    h.session.scheduler = 'pbs';
    h.watcher.trackJobs('sess-1', ['501', '502']);
    await h.poll();
    expect(h.events()).toEqual([expect.objectContaining({ jobId: '502', status: 'EXIT' })]);
    expect((h.watcher as any).prevJobs.get('sess-1')).toEqual(expect.arrayContaining([
      expect.objectContaining({ jobId: '501', status: 'UNKNOWN' }),
    ]));
    firstExit = ' Exit_status = 0';
    await h.poll();
    expect(h.events()).toEqual(expect.arrayContaining([
      expect.objectContaining({ jobId: '501', status: 'DONE' }),
    ]));
    expect(h.exec.mock.calls.some(([cmd]) => String(cmd).includes('qstat -x -f 501'))).toBe(true);
  });

  it('终态事件带 bpeek 输出尾部摘要，并持久化到 job-events.json', async () => {
    const h = makePollHarness({
      exec: cmd => {
        if (cmd.includes('bjobs -w')) return bjobsRaw(); // 作业已从列表消失
        if (cmd.includes('bjobs -a')) return 'DONE\n';
        if (cmd.includes('bpeek')) return 'result line A\nresult line B\n';
        return '';
      },
    });
    h.watcher.trackJobs('sess-1', ['424242']);
    await h.poll();

    expect(h.events()).toHaveLength(1);
    expect(h.events()[0]).toMatchObject({ jobId: '424242', status: 'DONE' });
    expect(h.events()[0].excerpt).toBe('result line A\nresult line B');
    expect(h.exec).toHaveBeenCalledWith('bpeek 424242 2>/dev/null | tail -n 30', 10_000);
    const persisted = await loadJobEvents();
    expect(persisted[0]?.excerpt).toBe('result line A\nresult line B');
  });

  it('excerpt 超过 2000 字符时保留最末尾', async () => {
    const tail = `${'a'.repeat(2500)}${'b'.repeat(2500)}`;
    const h = makePollHarness({
      exec: cmd => {
        if (cmd.includes('bjobs -w')) return bjobsRaw();
        if (cmd.includes('bjobs -a')) return 'EXIT\n';
        if (cmd.includes('bpeek')) return tail;
        return '';
      },
    });
    h.watcher.trackJobs('sess-1', ['424243']);
    await h.poll();

    const excerpt = h.events()[0]?.excerpt ?? '';
    expect(excerpt).toHaveLength(2000);
    expect(excerpt).toBe('b'.repeat(2000));
    expect(h.events()[0].status).toBe('EXIT');
  });

  it('bpeek 失败或无输出时 excerpt 缺省，不阻塞事件', async () => {
    const h = makePollHarness({
      exec: cmd => {
        if (cmd.includes('bjobs -noheader')) return '313 DONE\n'; // 定点查询直接看到终态
        if (cmd.includes('bpeek')) return '   \n';
        return '';
      },
    });
    h.watcher.trackJobs('sess-1', ['313']);
    await h.poll();

    expect(h.events()).toHaveLength(1);
    expect(h.events()[0].excerpt).toBeUndefined();
  });

  it('首轮基线：有未唤醒绑定的终态作业发事件，无绑定的历史作业静默', async () => {
    const h = makePollHarness({
      exec: cmd => {
        if (cmd.includes('bjobs -w')) {
          return bjobsRaw(
            '777 u DONE normal h n1 bound-job Jan 1',
            '999 u EXIT normal h n1 history-job Jan 1',
            '888 u RUN normal h n1 running-job Jan 1',
          );
        }
        if (cmd.includes('bpeek')) return 'bound output';
        return '';
      },
      hasPendingBinding: (_sessionId, jobId) => jobId === '777',
    });
    await h.poll(); // 首轮：777 有绑定 → 事件；999 无绑定 → 基线；888 在跑 → 忽略

    expect(h.events()).toHaveLength(1);
    expect(h.events()[0]).toMatchObject({ jobId: '777', status: 'DONE', excerpt: 'bound output' });

    await h.poll(); // 第二轮快照未变：不重复发事件
    expect(h.events()).toHaveLength(1);
  });

  it('重启恢复：trackJobs 后首轮即终态的绑定作业只发一次事件', async () => {
    const h = makePollHarness({
      exec: cmd => {
        if (cmd.includes('bjobs -noheader')) return '555 DONE\n'; // 定点查询：已跟踪作业首轮即终态
        if (cmd.includes('bpeek')) return 'restored output';
        return '';
      },
      hasPendingBinding: () => true,
    });
    h.watcher.trackJobs('sess-1', ['555']); // restoreJobAgentBindings 的落点
    await h.poll();
    await h.poll();

    expect(h.events()).toHaveLength(1);
    expect(h.events()[0]).toMatchObject({ jobId: '555', status: 'DONE', excerpt: 'restored output' });
  });
});
