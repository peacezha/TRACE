import { useRef, useState, useCallback, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence } from 'motion/react';
import { Check, ClipboardPaste, Copy, Eraser, Sparkles, TextSelect } from 'lucide-react';
import { Socket } from 'socket.io-client';
import TerminalComponent, { TerminalHandle } from './Terminal';
import CommandSuggest from './CommandSuggest';
import FloatingToolbar from './FloatingToolbar';
import TerminalAssistPanel from './TerminalAssistPanel';
import { useContextMenuPosition } from './useContextMenuPosition';
import { requestAutocomplete, cancelAutocomplete, Suggestion } from '../services/aiTerminal';
import { isCommandComplete } from '../services/commandIndex';
import { recordCommand } from '../services/commandHistory';
import '../features/file-transfer/fileTransfer.css';
import { writeClipboardText, readClipboardText } from '../services/clipboard';

/** AI 辅助开关的持久化键（划词即弹出辅助小窗） */
const ASSIST_STORAGE_KEY = 'trace_terminal_assist';

interface TerminalAIProps {
  isSidebarOpen: boolean;
  isLoggedIn: boolean;
  sshSessionId: string | null;
  /** 多标签页下当前标签是否可见；变为可见时需要重新 fit 终端尺寸 */
  isActive?: boolean;
  onSocketReady: (socket: Socket) => void;
  onAnalyzeError?: (selectedText: string) => void;
  onSendToAI?: (selectedText: string) => void;
  onFileLinkClick?: (pathText: string) => void;
  terminalRef: React.RefObject<TerminalHandle | null>;
  scheduler?: string | null;
}

// Escape sequence regex for arrow keys, home, end, etc.
const ESCAPE_SEQ = /^\x1b/;
const BACKSPACE = '\x7f';

export default function TerminalAI({
  isSidebarOpen,
  isLoggedIn,
  sshSessionId,
  isActive = true,
  onSocketReady,
  onAnalyzeError,
  onSendToAI,
  onFileLinkClick,
  terminalRef,
  scheduler,
}: TerminalAIProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  // ─── Command buffer for autocomplete ──────────────────────────────
  const [commandBuffer, setCommandBuffer] = useState('');
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [cursorPixel, setCursorPixel] = useState({ x: 0, y: 0 });
  // 终端实际 fontSize 为 16（Terminal.tsx）：按 16px × 1.2 倍行高、16px × 0.6 倍字宽估算
  const lineHeight = 19.2; // JetBrains Mono 16px 行高估算（16 × 1.2）
  const charWidth = 9.6; // 16px × 0.6（等宽字符宽估算）
  const [commandComplete, setCommandComplete] = useState(false);
  const cmdGenRef = useRef(0);  // generation counter to reject stale AI callbacks

  // ─── Selection state for toolbar ──────────────────────────────────
  const [selectedText, setSelectedText] = useState('');
  const [toolbarVisible, setToolbarVisible] = useState(false);
  const [toolbarPixel, setToolbarPixel] = useState({ x: 0, y: 0 });
  const toolbarTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ─── 右键菜单（复制/粘贴/全选/清屏 + AI 辅助开关）───────────────────
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);
  // 右键菜单视口收拢：实测菜单宽高后修正 left/top，避免在窗口右/下沿被裁
  const contextMenuStyle = useContextMenuPosition(
    contextMenuRef,
    contextMenu?.x ?? null,
    contextMenu?.y ?? null,
  );

  // ─── AI 辅助小窗（开关持久化；开启后划选即在右下角弹出解释与快捷操作）──
  const [assistEnabled, setAssistEnabled] = useState(
    () => window.localStorage.getItem(ASSIST_STORAGE_KEY) === '1',
  );
  const [assistText, setAssistText] = useState<string | null>(null);

  // Cancel pending AI requests when command becomes complete
  useEffect(() => {
    if (commandComplete) {
      cancelAutocomplete();
    }
  }, [commandComplete]);

  // ─── Update cursor pixel position from xterm textarea ─────────────
  const updateCursorPosition = useCallback(() => {
    const term = terminalRef.current;
    const container = containerRef.current;
    if (!term || !container) return;

    // Use xterm's actual cursor textarea position — far more accurate
    // than estimating from buffer coords * charWidth/lineHeight.
    const termEl = term.getTerminalElement();
    if (!termEl) return;

    const textarea = termEl.querySelector('.xterm-helper-textarea') as HTMLElement | null;
    if (!textarea) return;

    const containerRect = container.getBoundingClientRect();
    const textareaRect = textarea.getBoundingClientRect();

    setCursorPixel({
      x: textareaRect.left - containerRect.left,
      y: textareaRect.top - containerRect.top,
    });
  }, [terminalRef]);

  // ─── Handle command input from terminal ───────────────────────────
  const commandBufferRef = useRef('');
  const handleCommandInput = useCallback((data: string) => {
    // 回车：记录这条命令到历史（补全学习信号），然后重置缓冲
    if (data.includes('\r') || data.includes('\n')) {
      if (commandBufferRef.current.trim().length >= 3) {
        recordCommand(commandBufferRef.current);
      }
      commandBufferRef.current = '';
      cancelAutocomplete();
      setSuggestions([]);
      setCommandComplete(false);
      setCommandBuffer('');
      return;
    }

    setCommandBuffer(prev => {
      let next = prev;

      // Skip escape sequences (arrow keys, etc.)
      if (ESCAPE_SEQ.test(data)) {
        cancelAutocomplete();
        setSuggestions([]);
        setCommandComplete(false);
        commandBufferRef.current = '';
        return ''; // Reset — user is navigating history or moving cursor
      }

      // Skip tab when no suggestions
      if (data === '\t') {
        return prev;
      }

      // Paste detection: multi-char paste resets buffer
      if (data.length > 1) {
        cancelAutocomplete();
        setSuggestions([]);
        commandBufferRef.current = '';
        return '';
      }

      // Backspace
      if (data === BACKSPACE) {
        next = prev.slice(0, -1);
      } else if (data.length === 1) {
        next = prev + data;
      }

      // Trigger autocomplete (local instant at 2 chars, AI at 2+ chars)
      if (next.trim().length >= 2) {
        updateCursorPosition();
        const gen = ++cmdGenRef.current;
        requestAutocomplete(
          next,
          (sugs) => {
            // Reject stale AI callbacks (user typed more since)
            if (gen !== cmdGenRef.current) return;
            const filtered = sugs.filter(s => s.completion !== next);
            setSuggestions(filtered);
            // 有建议就显示：无语法覆盖的命令（cat/ls/cd）同样有路径/历史建议
            if (filtered.length > 0) setCommandComplete(false);
          },
          () => {
            if (gen !== cmdGenRef.current) return;
            setSuggestions([]);
          },
        );
        setCommandComplete(isCommandComplete(next));
      } else {
        cancelAutocomplete();
        setSuggestions([]);
        setCommandComplete(false);
      }

      commandBufferRef.current = next;
      return next;
    });
  }, [updateCursorPosition]);

  // ─── Handle selection changes ─────────────────────────────────────
  const lastSelectionRef = useRef(0);
  const handleSelection = useCallback((text: string, endCol: number, endRow: number) => {
    const now = Date.now();
    const hasText = !!(text && text.trim().length > 0);

    if (hasText) {
      lastSelectionRef.current = now;
      if (toolbarTimerRef.current) clearTimeout(toolbarTimerRef.current);
      setSelectedText(text);

      // AI 辅助开着：划选即在右下角小窗给出本地解释与快捷操作（再次划选更新内容）
      if (assistEnabled) setAssistText(text);

      // Compute pixel position for toolbar near the selection end
      const term = terminalRef.current;
      const container = containerRef.current;
      if (term && container) {
        const termEl = term.getTerminalElement();
        if (termEl) {
          const containerRect = container.getBoundingClientRect();
          const termRect = termEl.getBoundingClientRect();
          setToolbarPixel({
            x: termRect.left - containerRect.left + (endCol + 1) * charWidth,
            y: termRect.top - containerRect.top + endRow * lineHeight,
          });
        }
      }

      toolbarTimerRef.current = setTimeout(() => {
        setToolbarVisible(true);
      }, 300);
    } else if (now - lastSelectionRef.current > 500) {
      // Only dismiss if the last valid selection was >500ms ago (debounce double-fire)
      if (toolbarTimerRef.current) clearTimeout(toolbarTimerRef.current);
      setSelectedText('');
      setToolbarVisible(false);
    }
    // If empty within 500ms of a valid selection, ignore (xterm double-fire quirk)
  }, [charWidth, lineHeight, terminalRef, assistEnabled]);

  // ─── 右键菜单：开/关与菜单动作 ─────────────────────────────────────
  const handleContextMenu = useCallback((event: React.MouseEvent) => {
    event.preventDefault();
    setContextMenu({ x: event.clientX, y: event.clientY });
  }, []);

  // 右键菜单：外点关闭
  useEffect(() => {
    if (!contextMenu) return;
    const handleClick = (event: MouseEvent) => {
      if (contextMenuRef.current && !contextMenuRef.current.contains(event.target as Node)) {
        setContextMenu(null);
      }
    };
    document.addEventListener('click', handleClick);
    return () => document.removeEventListener('click', handleClick);
  }, [contextMenu]);

  // 右键菜单：Esc 关闭
  useEffect(() => {
    if (!contextMenu) return;
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setContextMenu(null);
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [contextMenu]);

  const handleCopySelection = useCallback(() => {
    if (selectedText) void writeClipboardText(selectedText).catch(() => {});
    setContextMenu(null);
  }, [selectedText]);

  const handlePaste = useCallback(() => {
    setContextMenu(null);
    readClipboardText()
      .then(text => {
        if (!text) return;
        terminalRef.current?.pasteText(text);
        terminalRef.current?.focus();
      })
      .catch(() => { /* 剪贴板不可用 */ });
  }, [terminalRef]);

  const handleSelectAll = useCallback(() => {
    terminalRef.current?.selectAll();
    setContextMenu(null);
  }, [terminalRef]);

  const handleClearScreen = useCallback(() => {
    terminalRef.current?.clearScreen();
    terminalRef.current?.focus();
    setContextMenu(null);
  }, [terminalRef]);

  // 开关项切换后保持菜单展开，勾选状态即时可见；关闭辅助时同时收起小窗
  const handleToggleAssist = useCallback(() => {
    setAssistEnabled(prev => {
      const next = !prev;
      window.localStorage.setItem(ASSIST_STORAGE_KEY, next ? '1' : '0');
      if (!next) setAssistText(null);
      return next;
    });
  }, []);

  // ─── AI 辅助小窗的执行通道：终端可见执行后焦点还给终端 ─────────────
  const handleAssistExecute = useCallback((command: string) => {
    void terminalRef.current?.executeCommand(command, false, false);
    terminalRef.current?.focus();
  }, [terminalRef]);

  // ─── Accept autocomplete suggestion ────────────────────────────────
  const handleAcceptSuggestion = useCallback((completion: string) => {
    const socket = terminalRef.current?.getSocket();

    // Find the partial token — everything after the last space
    const lastSpaceIdx = commandBuffer.lastIndexOf(' ');
    const partialToken = lastSpaceIdx >= 0
      ? commandBuffer.slice(lastSpaceIdx + 1)
      : commandBuffer;

    let suffix: string;
    let newBuffer: string;

    if (partialToken && completion.startsWith(partialToken)) {
      // Completion extends the last token being typed — replace it
      suffix = completion.slice(partialToken.length);
      newBuffer = commandBuffer.slice(0, commandBuffer.length - partialToken.length) + completion;
    } else if (completion.startsWith(commandBuffer)) {
      // Completion extends the entire command buffer (e.g. ls → ls -la)
      suffix = completion.slice(commandBuffer.length);
      newBuffer = completion;
    } else {
      // Plain append (e.g. samtools  → view)
      suffix = completion;
      newBuffer = commandBuffer + completion;
    }

    // 防重复保护：补全没有带来任何新增内容时直接丢弃
    // （例如建议与已输入内容完全一致，避免 "pathpath" 式重复）
    if (!suffix || newBuffer === commandBuffer) {
      cancelAutocomplete();
      setSuggestions([]);
      return;
    }

    if (socket?.connected && suffix) {
      socket.emit('data', suffix);
    }

    cancelAutocomplete();
    setSuggestions([]);
    commandBufferRef.current = newBuffer;
    setCommandBuffer(newBuffer);

    // Check if command is now complete — stop if so
    const nextInput = newBuffer + ' ';
    if (isCommandComplete(nextInput)) {
      setCommandComplete(true);
      return;
    }

    // Still incomplete — suggest next expected token
    setCommandComplete(false);
    updateCursorPosition();
    requestAutocomplete(
      nextInput,
      (sugs) => setSuggestions(sugs),
      () => {},
    );
  }, [terminalRef, commandBuffer, updateCursorPosition]);

  // ─── Dismiss suggestions ──────────────────────────────────────────
  const handleDismissSuggestions = useCallback(() => {
    setSuggestions([]);
    cancelAutocomplete();
  }, []);

  // ─── Error analysis handlers ──────────────────────────────────────
  const handleAnalyzeError = useCallback((text: string) => {
    if (onAnalyzeError) onAnalyzeError(text);
  }, [onAnalyzeError]);

  const handleSendToAI = useCallback((text: string) => {
    if (onSendToAI) onSendToAI(text);
  }, [onSendToAI]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      cancelAutocomplete();
      if (toolbarTimerRef.current) clearTimeout(toolbarTimerRef.current);
    };
  }, []);

  return (
    <div ref={containerRef} className="flex-1 relative flex flex-col min-h-0" onContextMenu={handleContextMenu}>
      <TerminalComponent
        ref={terminalRef}
        isSidebarOpen={isSidebarOpen}
        isLoggedIn={isLoggedIn}
        isActive={isActive}
        sshSessionId={sshSessionId}
        onSocketReady={onSocketReady}
        onCommandInput={handleCommandInput}
        onTerminalSelection={handleSelection}
        onFileLinkClick={onFileLinkClick}
      />

      {/* AI overlays — absolutely positioned over terminal */}
      <CommandSuggest
        suggestions={suggestions}
        cursorPixelX={cursorPixel.x}
        cursorPixelY={cursorPixel.y}
        lineHeight={lineHeight}
        charWidth={charWidth}
        containerRef={containerRef}
        onAccept={handleAcceptSuggestion}
        onDismiss={handleDismissSuggestions}
        commandComplete={commandComplete}
      />

      <AnimatePresence>
        {toolbarVisible && selectedText ? (
          <FloatingToolbar
            key="floating-toolbar"
            visible={toolbarVisible}
            selectedText={selectedText}
            pixelX={toolbarPixel.x}
            pixelY={toolbarPixel.y}
            lineHeight={lineHeight}
            containerRef={containerRef}
            onSendToAI={(text) => {
              handleSendToAI(text);
              setToolbarVisible(false);
              setSelectedText('');
            }}
            onAnalyzeError={(text) => {
              handleAnalyzeError(text);
              setToolbarVisible(false);
              setSelectedText('');
            }}
            onDismiss={() => {
              setToolbarVisible(false);
              setSelectedText('');
            }}
          />
        ) : null}
      </AnimatePresence>

      {/* AI 辅助小窗：终端右下角浮出。pointer-events 只在卡片上，
          点击小窗空白处直接落回终端，不阻塞输入。 */}
      {assistEnabled && assistText ? (
        <div className="absolute bottom-3 right-3 z-40 pointer-events-none">
          <TerminalAssistPanel
            selectedText={assistText}
            onExecuteCommand={handleAssistExecute}
            onSendToAI={handleSendToAI}
            onAnalyzeError={handleAnalyzeError}
            onClose={() => setAssistText(null)}
            scheduler={scheduler}
          />
        </div>
      ) : null}

      {/* 终端右键菜单：portal 到 body（fixed 定位 + 视口收拢，避免被 overflow 容器裁剪） */}
      {contextMenu && createPortal(
        <div
          ref={contextMenuRef}
          className="file-transfer-context-menu"
          style={contextMenuStyle}
          data-testid="terminal-context-menu"
          role="menu"
        >
          <button
            type="button"
            className="context-menu-item"
            disabled={!selectedText.trim()}
            onClick={handleCopySelection}
          >
            <Copy className="w-3.5 h-3.5" />
            复制
          </button>
          <button type="button" className="context-menu-item" onClick={handlePaste}>
            <ClipboardPaste className="w-3.5 h-3.5" />
            粘贴
          </button>
          <button type="button" className="context-menu-item" onClick={handleSelectAll}>
            <TextSelect className="w-3.5 h-3.5" />
            全选
          </button>
          <button type="button" className="context-menu-item" onClick={handleClearScreen}>
            <Eraser className="w-3.5 h-3.5" />
            清屏
          </button>
          <div className="context-menu-divider" />
          <button
            type="button"
            className="context-menu-item"
            onClick={handleToggleAssist}
            aria-pressed={assistEnabled}
            title="开启后划选内容会弹出解释与快捷操作"
          >
            <Sparkles className="w-3.5 h-3.5 text-accent" />
            AI 辅助
            <span className="ml-auto w-3.5 h-3.5 flex items-center justify-center">
              {assistEnabled ? <Check className="w-3.5 h-3.5 text-accent" /> : null}
            </span>
          </button>
        </div>,
        document.body,
      )}
    </div>
  );
}
