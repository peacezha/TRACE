import { useMemo, useState } from 'react';
import { CornerDownLeft, Sparkles, X } from 'lucide-react';
import { analyzeTerminalSelection, resolveAssistIntent, type AssistAction } from '../services/terminalAssist';

interface TerminalAssistPanelProps {
  /** 触发小窗的终端选区内容（再次划选会整体替换） */
  selectedText: string;
  /** 在终端里可见地执行命令（executeCommand(cmd, false, false)） */
  onExecuteCommand: (command: string) => void;
  onSendToAI: (text: string) => void;
  onAnalyzeError: (text: string) => void;
  onClose: () => void;
  /** 当前集群调度器（lsf/slurm/pbs/none），缺省兼容 LSF。 */
  scheduler?: string | null;
}

/**
 * 划词 AI 辅助小窗（终端容器右下角）。
 * 上半部分是本地即时分析（不联网）：路径/作业号/报错的摘要与一键命令；
 * 下半部分是自由操作输入框，回车立即执行，识别不了就转交 AI。
 * 卡片本身不抢焦点，由父级包一层 pointer-events-none，点击空白处直接落回终端。
 */
export default function TerminalAssistPanel({
  selectedText,
  onExecuteCommand,
  onSendToAI,
  onAnalyzeError,
  onClose,
  scheduler,
}: TerminalAssistPanelProps) {
  const analysis = useMemo(() => analyzeTerminalSelection(selectedText, scheduler), [selectedText, scheduler]);
  const [input, setInput] = useState('');
  // 转交 AI 后的短暂提示（随后自动关闭小窗）
  const [handedOff, setHandedOff] = useState(false);

  const runAction = (action: AssistAction) => {
    if (action.command) {
      onExecuteCommand(action.command);
    } else if (action.ai === 'analyze') {
      onAnalyzeError(selectedText);
    } else {
      onSendToAI(selectedText);
    }
    onClose();
  };

  const submitInput = () => {
    const text = input.trim();
    if (!text || handedOff) return;
    const intent = resolveAssistIntent(text, analysis, scheduler);
    if (intent.kind === 'command') {
      onExecuteCommand(intent.command);
      onClose();
      return;
    }
    // 识别不了意图：把"选区内容 + 用户的话"一起发给 AI
    onSendToAI(`${selectedText}\n\n${text}`);
    setHandedOff(true);
    window.setTimeout(onClose, 900);
  };

  return (
    <div
      data-testid="terminal-assist-panel"
      className="pointer-events-auto w-72 rounded-lg border border-scholar-600 bg-scholar-900/95 shadow-2xl backdrop-blur text-xs text-scholar-200"
    >
      {/* 头部 */}
      <div className="flex items-center gap-1.5 px-3 py-2 border-b border-scholar-700/60">
        <Sparkles className="w-3.5 h-3.5 text-accent" />
        <span className="font-medium text-scholar-100">AI 辅助</span>
        <button
          type="button"
          onClick={onClose}
          className="ml-auto p-0.5 rounded text-scholar-400 hover:text-scholar-100 hover:bg-scholar-700 transition-colors"
          title="关闭"
          aria-label="关闭"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* 本地即时分析摘要 */}
      <div className="px-3 py-2 border-b border-scholar-700/40">
        {analysis.kind === 'path' && (
          <div className="min-w-0">
            <span className="text-scholar-400">检测到路径</span>
            <code className="block mt-1 px-1.5 py-1 rounded bg-scholar-950/80 text-accent font-mono break-all">{analysis.path}</code>
          </div>
        )}
        {analysis.kind === 'job' && (
          <div>
            <span className="text-scholar-400">疑似作业号</span>
            <code className="ml-1.5 px-1.5 py-0.5 rounded bg-scholar-950/80 text-accent font-mono">{analysis.jobId}</code>
          </div>
        )}
        {analysis.kind === 'error' && (
          <div className="min-w-0">
            <span className="text-scholar-400">检测到报错信息</span>
            {analysis.errorLines && analysis.errorLines.length > 0 && (
              <pre className="mt-1 px-1.5 py-1 rounded bg-scholar-950/80 text-red-300 font-mono whitespace-pre-wrap break-all max-h-20 overflow-y-auto">
                {analysis.errorLines.join('\n')}
              </pre>
            )}
          </div>
        )}
        {analysis.kind === 'text' && (
          <span className="text-scholar-400">已选中 {analysis.charCount ?? 0} 个字符</span>
        )}
      </div>

      {/* 一键操作 */}
      <div className="flex flex-wrap gap-1.5 px-3 py-2">
        {analysis.actions.map(action => (
          <button
            key={action.id}
            type="button"
            onClick={() => runAction(action)}
            title={action.command}
            className="px-2 py-1 rounded bg-scholar-800 border border-scholar-600 text-scholar-200 hover:text-scholar-50 hover:bg-scholar-700 hover:border-scholar-500 transition-colors"
          >
            {action.label}
          </button>
        ))}
      </div>

      {/* 自由操作输入：回车立即执行 */}
      <div className="flex items-center gap-1.5 px-3 py-2 border-t border-scholar-700/40">
        {handedOff ? (
          <span className="py-1 text-accent">已转交 AI</span>
        ) : (
          <>
            <input
              value={input}
              onChange={event => setInput(event.target.value)}
              onKeyDown={event => {
                if (event.key === 'Enter') submitInput();
                if (event.key === 'Escape') onClose();
              }}
              placeholder="输入操作，回车立即执行…"
              className="flex-1 min-w-0 px-2 py-1 rounded bg-scholar-950 border border-scholar-700 text-scholar-100 placeholder:text-scholar-500 outline-none focus:border-accent"
            />
            <button
              type="button"
              onClick={submitInput}
              disabled={!input.trim()}
              className="p-1 rounded text-accent hover:bg-scholar-700 transition-colors disabled:opacity-40 disabled:hover:bg-transparent"
              title="立即执行"
              aria-label="立即执行"
            >
              <CornerDownLeft className="w-3.5 h-3.5" />
            </button>
          </>
        )}
      </div>
    </div>
  );
}
