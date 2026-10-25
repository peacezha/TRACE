// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import TerminalAssistPanel from './TerminalAssistPanel';

afterEach(cleanup);

function renderPanel(selectedText: string) {
  const props = {
    onExecuteCommand: vi.fn(),
    onSendToAI: vi.fn(),
    onAnalyzeError: vi.fn(),
    onClose: vi.fn(),
  };
  render(<TerminalAssistPanel selectedText={selectedText} {...props} />);
  return props;
}

describe('TerminalAssistPanel', () => {
  it('作业命令使用当前调度器', () => {
    const onExecuteCommand = vi.fn();
    render(<TerminalAssistPanel
      selectedText="582301" scheduler="slurm"
      onExecuteCommand={onExecuteCommand} onSendToAI={vi.fn()} onAnalyzeError={vi.fn()} onClose={vi.fn()}
    />);
    fireEvent.click(screen.getByRole('button', { name: '查看作业' }));
    expect(onExecuteCommand).toHaveBeenCalledWith('squeue -j 582301');
  });

  it('路径选区：展示路径摘要与一键命令，点击"进入该目录"执行 cd 并关闭', () => {
    const props = renderPanel('输出位于 /public/home/u/project 目录下');
    expect(screen.getByText('检测到路径')).toBeTruthy();
    expect(screen.getByText('/public/home/u/project')).toBeTruthy();

    fireEvent.click(screen.getByText('进入该目录'));
    expect(props.onExecuteCommand).toHaveBeenCalledWith('cd "/public/home/u/project"');
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it('压缩包选区：出现"解压"按钮，命令为 tar -xzf', () => {
    const props = renderPanel('/data/packs/result.tar.gz');
    fireEvent.click(screen.getByText('解压'));
    expect(props.onExecuteCommand).toHaveBeenCalledWith('tar -xzf "/data/packs/result.tar.gz"');
  });

  it('作业号选区：点击"终止作业"执行 bkill', () => {
    const props = renderPanel('582301');
    expect(screen.getByText('疑似作业号')).toBeTruthy();
    fireEvent.click(screen.getByText('终止作业'));
    expect(props.onExecuteCommand).toHaveBeenCalledWith('bkill 582301');
  });

  it('报错选区：展示命中行，点击"发给 AI 深度分析"走 onAnalyzeError', () => {
    const text = 'INFO start\nError: file not found\nfailed to open';
    const props = renderPanel(text);
    expect(screen.getByText('检测到报错信息')).toBeTruthy();
    fireEvent.click(screen.getByText('发给 AI 深度分析'));
    expect(props.onAnalyzeError).toHaveBeenCalledWith(text);
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it('普通文本选区：字符数摘要 + "发给 AI 解读"走 onSendToAI', () => {
    const props = renderPanel('hello world');
    expect(screen.getByText(/已选中/)).toBeTruthy();
    fireEvent.click(screen.getByText('发给 AI 解读'));
    expect(props.onSendToAI).toHaveBeenCalledWith('hello world');
  });

  it('输入框回车：命中意图立即执行命令并关闭', () => {
    const props = renderPanel('582301');
    const input = screen.getByPlaceholderText('输入操作，回车立即执行…');
    fireEvent.change(input, { target: { value: '终止这个任务' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(props.onExecuteCommand).toHaveBeenCalledWith('bkill 582301');
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it('输入框回车：识别不了意图 → 选区+用户的话发给 AI，并提示"已转交 AI"', () => {
    const props = renderPanel('582301');
    const input = screen.getByPlaceholderText('输入操作，回车立即执行…');
    fireEvent.change(input, { target: { value: '这个作业为什么排队这么久' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(props.onExecuteCommand).not.toHaveBeenCalled();
    expect(props.onSendToAI).toHaveBeenCalledWith('582301\n\n这个作业为什么排队这么久');
    expect(screen.getByText('已转交 AI')).toBeTruthy();
  });

  it('关闭按钮与 Esc 都触发 onClose', () => {
    const props = renderPanel('hello world');
    fireEvent.click(screen.getByRole('button', { name: '关闭' }));
    expect(props.onClose).toHaveBeenCalledTimes(1);

    cleanup();
    const props2 = renderPanel('hello world');
    fireEvent.keyDown(screen.getByPlaceholderText('输入操作，回车立即执行…'), { key: 'Escape' });
    expect(props2.onClose).toHaveBeenCalledTimes(1);
  });
});
