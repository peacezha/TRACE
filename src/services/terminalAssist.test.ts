import { describe, it, expect } from 'vitest';
import { analyzeTerminalSelection, resolveAssistIntent } from './terminalAssist';

describe('analyzeTerminalSelection', () => {
  it('识别目录路径：进入该目录 + 查看内容，无解压', () => {
    const result = analyzeTerminalSelection('输出位于 /public/home/u/project 目录下');
    expect(result.kind).toBe('path');
    expect(result.path).toBe('/public/home/u/project');
    expect(result.directory).toBe('/public/home/u/project');
    expect(result.extractCommand).toBeUndefined();
    expect(result.actions.map(a => a.id)).toEqual(['path-cd', 'path-ls']);
    expect(result.actions[0].command).toBe('cd "/public/home/u/project"');
    expect(result.actions[1].command).toBe('ls -la "/public/home/u/project"');
  });

  it('识别文件路径：cd 目标取所在目录', () => {
    const result = analyzeTerminalSelection('/public/home/u/data/sample.fastq.gz');
    expect(result.kind).toBe('path');
    expect(result.directory).toBe('/public/home/u/data');
    expect(result.actions[0].command).toBe('cd "/public/home/u/data"');
    // fastq.gz 不是归档 → 没有解压按钮
    expect(result.actions.find(a => a.id === 'path-extract')).toBeUndefined();
  });

  it('识别压缩包：tar.gz → tar -xzf，zip → unzip -q', () => {
    const tar = analyzeTerminalSelection('/data/packs/result.tar.gz');
    expect(tar.kind).toBe('path');
    expect(tar.extractCommand).toBe('tar -xzf "/data/packs/result.tar.gz"');
    expect(tar.actions.map(a => a.id)).toContain('path-extract');

    const zip = analyzeTerminalSelection('/data/packs/result.zip');
    expect(zip.extractCommand).toBe('unzip -q "/data/packs/result.zip"');

    const plain = analyzeTerminalSelection('/data/packs/result.tar');
    expect(plain.extractCommand).toBe('tar -xf "/data/packs/result.tar"');
  });

  it('识别 Windows 路径（日志里打印的 C:\\ 形式）', () => {
    const result = analyzeTerminalSelection('输出在 C:\\data\\pack.zip 完成');
    expect(result.kind).toBe('path');
    expect(result.path).toBe('C:\\data\\pack.zip');
    expect(result.extractCommand).toBe(`unzip -q ${JSON.stringify('C:\\data\\pack.zip')}`);
  });

  it('结尾带斜杠的目录：cd 目标去掉斜杠', () => {
    const result = analyzeTerminalSelection('/data/dir/');
    expect(result.directory).toBe('/data/dir');
    expect(result.actions[0].command).toBe('cd "/data/dir"');
  });

  it('整段 5–9 位纯数字 → 作业号，给出 bjobs/bpeek/bkill', () => {
    const result = analyzeTerminalSelection('  582301\n');
    expect(result.kind).toBe('job');
    expect(result.jobId).toBe('582301');
    expect(result.actions.map(a => a.command)).toEqual(['bjobs 582301', 'bpeek 582301', 'bkill 582301']);
  });

  it('按当前调度器生成 Slurm / PBS / Donau / 无调度器作业命令，未知时不猜 LSF', () => {
    expect(analyzeTerminalSelection('582301', 'slurm').actions.map(a => a.command))
      .toEqual(['squeue -j 582301', 'scontrol show job 582301', 'scancel 582301']);
    expect(analyzeTerminalSelection('582301', 'pbs').actions.map(a => a.command))
      .toEqual(['qstat 582301', 'tracejob 582301', 'qdel 582301']);
    expect(analyzeTerminalSelection('582301', 'donau').actions.map(a => a.command))
      .toEqual(['djob 582301', 'dpeek 582301', 'dkill 582301']);
    expect(analyzeTerminalSelection('582301', 'none').actions.map(a => a.command))
      .toEqual(['ps -p 582301 -f', 'ps -p 582301 -f', 'kill 582301']);
    expect(analyzeTerminalSelection('582301', 'LSF').actions.map(a => a.command))
      .toEqual(['bjobs 582301', 'bpeek 582301', 'bkill 582301']);
    expect(analyzeTerminalSelection('582301', 'unknown').actions[0].ai).toBe('explain');
    expect(resolveAssistIntent('终止', analyzeTerminalSelection('582301', 'unknown'), 'unknown').kind).toBe('ai');
  });

  it('位数不符（4 位 / 10 位）不算作业号', () => {
    expect(analyzeTerminalSelection('1234').kind).toBe('text');
    expect(analyzeTerminalSelection('1234567890').kind).toBe('text');
  });

  it('错误关键词 → 报错分析：命中行最多 3 行，优先于路径', () => {
    const text = [
      'INFO start /x/y/z.sh',
      'Error: file not found',
      '普通一行',
      'failed to open /x/y/input.txt',
      'Traceback (most recent call last):',
      '又一个 失败 的行',
    ].join('\n');
    const result = analyzeTerminalSelection(text);
    expect(result.kind).toBe('error');
    expect(result.errorLines).toEqual([
      'Error: file not found',
      'failed to open /x/y/input.txt',
      'Traceback (most recent call last):',
    ]);
    expect(result.actions).toEqual([{ id: 'ai-analyze', label: '发给 AI 深度分析', ai: 'analyze' }]);
  });

  it('超长错误行截断到 120 字符', () => {
    const result = analyzeTerminalSelection(`error: ${'x'.repeat(200)}`);
    expect(result.kind).toBe('error');
    expect(result.errorLines![0].length).toBe(121); // 120 + 省略号
    expect(result.errorLines![0].endsWith('…')).toBe(true);
  });

  it('普通文本 → 字符数摘要 + 发给 AI 解读', () => {
    const result = analyzeTerminalSelection('hello world');
    expect(result.kind).toBe('text');
    expect(result.charCount).toBe(11);
    expect(result.actions).toEqual([{ id: 'ai-explain', label: '发给 AI 解读', ai: 'explain' }]);
  });

  it('空选区 → 文本兜底', () => {
    expect(analyzeTerminalSelection('   ').kind).toBe('text');
  });
});

describe('resolveAssistIntent', () => {
  const pathAnalysis = analyzeTerminalSelection('/public/home/u/data/sample.tar.gz');
  const jobAnalysis = analyzeTerminalSelection('582301');
  const textAnalysis = analyzeTerminalSelection('随便一段文字');

  it('进入/跳转/cd → cd 到选区路径', () => {
    expect(resolveAssistIntent('进入这个目录', pathAnalysis))
      .toEqual({ kind: 'command', command: 'cd "/public/home/u/data"' });
    expect(resolveAssistIntent('cd 过去', pathAnalysis).kind).toBe('command');
  });

  it('解压 → 对选区压缩包解压', () => {
    expect(resolveAssistIntent('解压一下', pathAnalysis))
      .toEqual({ kind: 'command', command: 'tar -xzf "/public/home/u/data/sample.tar.gz"' });
  });

  it('终止/杀 → bkill 选区作业号', () => {
    expect(resolveAssistIntent('终止这个任务', jobAnalysis))
      .toEqual({ kind: 'command', command: 'bkill 582301' });
  });

  it('查看/状态 → bjobs；输出 → bpeek', () => {
    expect(resolveAssistIntent('查看状态', jobAnalysis))
      .toEqual({ kind: 'command', command: 'bjobs 582301' });
    expect(resolveAssistIntent('看看输出', jobAnalysis))
      .toEqual({ kind: 'command', command: 'bpeek 582301' });
  });

  it('查看路径选区 → ls -la', () => {
    expect(resolveAssistIntent('看看里面有啥，查看一下', pathAnalysis))
      .toEqual({ kind: 'command', command: 'ls -la "/public/home/u/data/sample.tar.gz"' });
  });

  it('识别不了意图 → ai 兜底', () => {
    expect(resolveAssistIntent('这段话什么意思', textAnalysis)).toEqual({ kind: 'ai' });
    expect(resolveAssistIntent('', textAnalysis)).toEqual({ kind: 'ai' });
  });

  it('意图需要的能力缺失时 → ai 兜底（文本选区里"解压"/"终止"）', () => {
    expect(resolveAssistIntent('解压', textAnalysis)).toEqual({ kind: 'ai' });
    expect(resolveAssistIntent('终止', textAnalysis)).toEqual({ kind: 'ai' });
    expect(resolveAssistIntent('终止', pathAnalysis)).toEqual({ kind: 'ai' });
  });

  it('cd 子串不误伤（abcdef 不触发 cd 意图）', () => {
    expect(resolveAssistIntent('abcdef', pathAnalysis)).toEqual({ kind: 'ai' });
  });
});
