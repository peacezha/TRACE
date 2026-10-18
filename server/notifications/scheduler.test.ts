import { describe, expect, it } from 'vitest';
import { parseSqueueOutput } from '../ai/clusterContext';
import {
  jobsCommand, lsfFinalStateCommand, lsfJobsByIdsCommand, parseJobsOutput, parseLsfJobsByIdsOutput,
  parseProcessesOutput, pbsFinalStateCommand, slurmFinalStateCommand, lsfOutputTailCommand, slurmOutputTailCommand,
  finalStateCommand, submitCommand, translateSchedulerDirectives,
  donauJobsByIdsCommand, parseDjobOutput, parseDonauJobsByIdsOutput, parseDjobFinalState, donauOutputTailCommand,
} from './scheduler';

describe('parseSqueueOutput', () => {
  it('解析管道分隔的 squeue 输出', () => {
    const jobs = parseSqueueOutput('12345|my-job|RUNNING|gpu|12:34\n');
    expect(jobs).toEqual([
      { jobId: '12345', name: 'my-job', status: 'RUN', cores: 0, queue: 'gpu', runtime: '12:34' },
    ]);
  });

  it('RUNNING → RUN，PENDING/CONFIGURING/SUSPENDED → PEND', () => {
    expect(parseSqueueOutput('1|a|RUNNING|p|0:01')[0]?.status).toBe('RUN');
    expect(parseSqueueOutput('2|a|PENDING|p|0:00')[0]?.status).toBe('PEND');
    expect(parseSqueueOutput('3|a|CONFIGURING|p|0:00')[0]?.status).toBe('PEND');
    expect(parseSqueueOutput('4|a|SUSPENDED|p|1:00')[0]?.status).toBe('PEND');
  });

  it('COMPLETED → DONE，FAILED/CANCELLED/TIMEOUT 等 → EXIT', () => {
    expect(parseSqueueOutput('5|a|COMPLETED|p|2:00')[0]?.status).toBe('DONE');
    for (const s of ['FAILED', 'CANCELLED', 'TIMEOUT', 'NODE_FAIL', 'PREEMPTED', 'OUT_OF_MEMORY']) {
      expect(parseSqueueOutput(`6|a|${s}|p|0:10`)[0]?.status).toBe('EXIT');
    }
  });

  it('未知状态 → UNKNOWN', () => {
    expect(parseSqueueOutput('7|a|REQUEUE|p|0:00')[0]?.status).toBe('UNKNOWN');
  });

  it('空输出与空行 → []', () => {
    expect(parseSqueueOutput('')).toEqual([]);
    expect(parseSqueueOutput('\n\n')).toEqual([]);
  });

  it('作业名含空格也能按管道正确解析', () => {
    const jobs = parseSqueueOutput('9|train model v2|RUNNING|cpu|1-02:03:04');
    expect(jobs[0]?.name).toBe('train model v2');
    expect(jobs[0]?.runtime).toBe('1-02:03:04');
  });
});

describe('parseJobsOutput', () => {
  it('slurm 走 squeue 解析', () => {
    expect(parseJobsOutput('slurm', '1|a|RUNNING|p|0:01')[0]?.status).toBe('RUN');
  });

  it('lsf 走 bjobs 解析', () => {
    const raw = 'JOBID USER STAT QUEUE FROM_HOST EXEC_HOST JOB_NAME SUBMIT_TIME\n101 u RUN normal h n1 myjob Jan 1\n';
    const jobs = parseJobsOutput('lsf', raw);
    expect(jobs[0]?.jobId).toBe('101');
    expect(jobs[0]?.status).toBe('RUN');
    expect(jobs[0]?.name).toBe('myjob');
  });
});

describe('parseProcessesOutput', () => {
  const header = '    PID STAT ELAPSED %CPU %MEM COMMAND';

  it('跳过表头并解析各字段', () => {
    const raw = `${header}\n  1234 R+   02:11:03 85.0 12.3 python train.py --epochs 10\n  2345 Ss   00:05    0.0  0.1  bash\n`;
    const procs = parseProcessesOutput(raw);
    expect(procs).toHaveLength(2);
    expect(procs[0]).toEqual({
      pid: '1234', stat: 'R+', etime: '02:11:03', cpu: '85.0', mem: '12.3',
      command: 'python train.py --epochs 10',
    });
    expect(procs[1]?.pid).toBe('2345');
    expect(procs[1]?.command).toBe('bash');
  });

  it('空输出与仅表头 → []', () => {
    expect(parseProcessesOutput('')).toEqual([]);
    expect(parseProcessesOutput(header + '\n')).toEqual([]);
  });

  it('超长命令截断到 120 字符', () => {
    const longCmd = 'x'.repeat(200);
    const procs = parseProcessesOutput(`${header}\n  1 R 00:01 1.0 0.1 ${longCmd}\n`);
    expect(procs[0]?.command).toHaveLength(121); // 120 + 省略号
    expect(procs[0]?.command.endsWith('…')).toBe(true);
  });
});

describe('输出尾部摘要命令', () => {
  it('lsf 用 bpeek 取尾部 30 行，非法作业号降级为 false', () => {
    expect(lsfOutputTailCommand('424242')).toBe('bpeek 424242 2>/dev/null | tail -n 30');
    expect(lsfOutputTailCommand('123.4')).toBe('bpeek 123.4 2>/dev/null | tail -n 30');
    expect(lsfOutputTailCommand('1;rm -rf /')).toBe('false');
    expect(lsfOutputTailCommand('')).toBe('false');
  });

  it('slurm 读默认输出文件尾部 30 行，非法作业号降级为 false', () => {
    expect(slurmOutputTailCommand('7890')).toBe('tail -q -n 30 "slurm-7890.out" "$HOME/slurm-7890.out" 2>/dev/null');
    expect(slurmOutputTailCommand('abc')).toBe('false');
  });
});

describe('远端自杀包装与 LSF 定点查询', () => {
  it('轮询与终态补查命令都带远端 timeout，本地放弃后远端进程也会退出', () => {
    expect(jobsCommand('lsf')).toBe('timeout 50 bjobs -w 2>/dev/null');
    expect(jobsCommand('slurm')).toContain('timeout 50 squeue');
    expect(jobsCommand('pbs')).toContain('timeout 50 qstat');
    expect(jobsCommand('none')).toBe('true');
    expect(lsfFinalStateCommand('123')).toBe('timeout 25 bjobs -a -noheader -o stat 123 2>/dev/null | head -1');
    expect(slurmFinalStateCommand('123')).toContain('timeout 25 sacct -j 123');
    expect(pbsFinalStateCommand('123')).toContain('timeout 25 qstat -x -f 123');
    expect(lsfFinalStateCommand('1;id')).toBe('false');
  });

  it('lsfJobsByIdsCommand 一条命令查全部 ID，非法 ID 被过滤', () => {
    expect(lsfJobsByIdsCommand(['111', '222'])).toBe('timeout 50 bjobs -noheader -o "jobid stat" 111 222 2>/dev/null; true');
    expect(lsfJobsByIdsCommand(['111', '1;rm -rf /', 'abc'])).toBe('timeout 50 bjobs -noheader -o "jobid stat" 111 2>/dev/null; true');
    expect(lsfJobsByIdsCommand([])).toBe('true');
    expect(lsfJobsByIdsCommand(['bad;id'])).toBe('true');
  });

  it('parseLsfJobsByIdsOutput 解析 jobid/stat 行并归一化状态', () => {
    expect(parseLsfJobsByIdsOutput('111 RUN\n222 PEND\n333 DONE\n444 EXIT\n555 ZZZ\n')).toEqual([
      { jobId: '111', status: 'RUN' },
      { jobId: '222', status: 'PEND' },
      { jobId: '333', status: 'DONE' },
      { jobId: '444', status: 'EXIT' },
      { jobId: '555', status: 'UNKNOWN' },
    ]);
    expect(parseLsfJobsByIdsOutput('')).toEqual([]);
    expect(parseLsfJobsByIdsOutput('noise\n\n')).toEqual([]);
  });
});

describe('Donau（多瑙）调度器', () => {
  // djob 列表输出无真实样例可参照：以下样例按技能文档的状态名与 --output 列名合成。
  it('jobsCommand 用 djob 列当前用户作业', () => {
    expect(jobsCommand('donau')).toBe('timeout 50 djob 2>/dev/null');
  });

  it('finalStateCommand 用 djob -l 补查终态，非法作业号降级为 false', () => {
    expect(finalStateCommand('donau', '123')).toBe('timeout 25 djob -l 123 2>/dev/null');
    expect(finalStateCommand('donau', '1;id')).toBe('false');
    expect(finalStateCommand('donau', '123.4')).toBe('false'); // Donau 作业号为纯数字
  });

  it('donauJobsByIdsCommand 循环逐个 djob 并打 DJOB_ID 标记，非法 ID 被过滤', () => {
    expect(donauJobsByIdsCommand(['111', '222']))
      .toBe('timeout 50 sh -c \'for id in 111 222; do echo "DJOB_ID:$id"; djob $id 2>/dev/null; done\'; true');
    expect(donauJobsByIdsCommand(['111', '1;rm -rf /', '123.4']))
      .toBe('timeout 50 sh -c \'for id in 111; do echo "DJOB_ID:$id"; djob $id 2>/dev/null; done\'; true');
    expect(donauJobsByIdsCommand([])).toBe('true');
    expect(donauJobsByIdsCommand(['bad;id'])).toBe('true');
  });

  it('parseDjobOutput 按文档列序（jobId name user state queue）解析并映射状态', () => {
    const raw = [
      'JOBID  NAME      USER   STATE      QUEUE',
      '1001   blastx    alice  RUNNING    arm',
      '1002   trim      alice  PENDING    arm',
      '1003   assembly  bob    SUCCEEDED  x86',
      '1004   qc        bob    FAILED     x86',
    ].join('\n');
    expect(parseDjobOutput(raw)).toEqual([
      { jobId: '1001', name: 'blastx', status: 'RUN', cores: 0, queue: 'arm', runtime: '' },
      { jobId: '1002', name: 'trim', status: 'PEND', cores: 0, queue: 'arm', runtime: '' },
      { jobId: '1003', name: 'assembly', status: 'DONE', cores: 0, queue: 'x86', runtime: '' },
      { jobId: '1004', name: 'qc', status: 'EXIT', cores: 0, queue: 'x86', runtime: '' },
    ]);
  });

  it('parseDjobOutput 状态映射：WAITING→PEND，STOPPED/SSTOPPED→EXIT', () => {
    expect(parseDjobOutput('1 a u WAITING q')[0]?.status).toBe('PEND');
    expect(parseDjobOutput('2 a u STOPPED q')[0]?.status).toBe('EXIT');
    expect(parseDjobOutput('3 a u SSTOPPED q')[0]?.status).toBe('EXIT');
  });

  it('parseDjobOutput 容错：空输出/表头/无作业号行跳过，乱序行退化解析', () => {
    expect(parseDjobOutput('')).toEqual([]);
    expect(parseDjobOutput('JOBID NAME STATE QUEUE\n\n')).toEqual([]);
    expect(parseDjobOutput('state: RUNNING')).toEqual([]); // 无纯数字作业号
    const jobs = parseDjobOutput('Job 2048 当前状态 RUNNING');
    expect(jobs[0]).toMatchObject({ jobId: '2048', status: 'RUN' });
  });

  it('parseDonauJobsByIdsOutput 按 DJOB_ID 标记分节，空节（作业消失）不出现在结果中', () => {
    const raw = [
      'DJOB_ID:111',
      '111  jobA  alice  RUNNING  arm',
      'DJOB_ID:222',
      'Job 222 state: SUCCEEDED',
      'DJOB_ID:333',
      '',
    ].join('\n');
    expect(parseDonauJobsByIdsOutput(raw)).toEqual([
      { jobId: '111', status: 'RUN' },
      { jobId: '222', status: 'DONE' },
    ]);
    expect(parseDonauJobsByIdsOutput('')).toEqual([]);
  });

  it('parseDjobFinalState：SUCCEEDED→DONE，FAILED/STOPPED/SSTOPPED→EXIT，活跃态/空→undefined', () => {
    expect(parseDjobFinalState('jobId: 1001\nstate: SUCCEEDED\nexitCode: 0')).toBe('DONE');
    expect(parseDjobFinalState('state: FAILED')).toBe('EXIT');
    expect(parseDjobFinalState('state: STOPPED')).toBe('EXIT');
    expect(parseDjobFinalState('state: SSTOPPED')).toBe('EXIT');
    expect(parseDjobFinalState('state: RUNNING')).toBeUndefined();
    expect(parseDjobFinalState('state: WAITING')).toBeUndefined();
    expect(parseDjobFinalState('')).toBeUndefined();
  });

  it('parseJobsOutput 分发 donau 到 parseDjobOutput', () => {
    expect(parseJobsOutput('donau', '1001 a u RUNNING arm')[0]?.status).toBe('RUN');
  });

  it('submitCommand 用 dsub -s 且先 chmod +x', () => {
    expect(submitCommand('donau', '/r/code/step-01.sh')).toBe("chmod +x '/r/code/step-01.sh' && dsub -s '/r/code/step-01.sh'");
  });

  it('translateSchedulerDirectives 对 donau 剥掉 #BSUB 指令（#DSUB 翻译未接入）', () => {
    const script = '#!/bin/bash\n#BSUB -J x\n#BSUB -n 8\necho hi\n';
    const out = translateSchedulerDirectives(script, 'donau');
    expect(out).not.toContain('#BSUB');
    expect(out).toContain('echo hi');
  });

  it('donauOutputTailCommand 用 dpeek 取尾部，非法作业号降级为 false', () => {
    expect(donauOutputTailCommand('123')).toBe('dpeek 123 2>/dev/null | tail -n 30');
    expect(donauOutputTailCommand('x;id')).toBe('false');
  });
});
