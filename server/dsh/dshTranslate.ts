// dsh sdk 通道 SessionEvent → TRACE SSE 事件的纯翻译层（无 IO，单测友好）。
// 输入是 session.event 通知里的完整事件信封 {type, seq, time, data}（dsh-session 的
// SessionEvent）；与 0.1.0 的 events.mux 帧不同，assistant/message 是整步快照而非
// delta——这里把每条 assistant 消息的文本块整体作为一段 content 发出，流式刷新由
// 前端按消息边界渲染。
// 产出形状与前端既有契约一致：content/reasoning/tool_call/tool_result/step/done/error。
// 审批与反问不再经过翻译层：sdk 协议不回传 approval/request 与 user-questions/request
// 瀑布（它们是会话内审计事件 approval/asked|decided + ask_user_question 工具调用），
// 交互由插件内 HTTP 应答器 → /api/bridge/interaction/* → 各 runner 注册的
// interaction handler 完成（见 bridgeState.registerDshInteractionHandler）。

import { redactDshSensitiveText } from './dshConfigSafety';

export interface TranslateState {
  sessionId: string;
  /** 已流出的正文累计（每条 assistant/message 的文本依次拼接），turn/end 时回填 done.content */
  accumulatedText: string;
  /** 最近一条 assistant/message 的快照正文（给 done.content 兜底） */
  lastAssistantText: string;
  /** tool/call 的 callId → name，供 tool/result 找回工具名 */
  toolNames: Map<string, string>;
  toolArguments: Map<string, unknown>;
}

export function createTranslateState(sessionId: string): TranslateState {
  return {
    sessionId,
    accumulatedText: '',
    lastAssistantText: '',
    toolNames: new Map(),
    toolArguments: new Map(),
  };
}

export interface TranslatorHooks {
  send: (event: any) => void;
  locale?: 'zh-CN' | 'en-US';
  onToolOutcome?: (meta: { name: string; args: unknown; result: string; failed: boolean }) => void;
}

export interface DshTranslator {
  translateEvent: (event: any, state: TranslateState) => void;
}

function tryParseJson(text: unknown): unknown {
  if (typeof text !== 'string') return text ?? {};
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** 提取消息 content 里的纯文本块（忽略 reasoning/image/file 等非文本块）。 */
function textOf(content: unknown, joiner = ''): string {
  if (!Array.isArray(content)) return '';
  return content
    .filter(block => block?.type === 'text' && typeof block.text === 'string')
    .map(block => block.text as string)
    .join(joiner);
}

export function createTranslator(hooks: TranslatorHooks): DshTranslator {
  const send = hooks.send;
  const zh = hooks.locale !== 'en-US';

  const translateAssistantMessage = (data: any, state: TranslateState): void => {
    const content = data?.message?.content;
    if (!Array.isArray(content)) return;
    const text = textOf(content);
    if (text) {
      state.lastAssistantText = text;
      state.accumulatedText += text;
      send({ type: 'content', content: text });
    }
    const reasoning = content
      .filter(block => block?.type === 'reasoning' && typeof block.text === 'string')
      .map(block => block.text as string)
      .join('');
    if (reasoning) send({ type: 'reasoning', content: reasoning });
  };

  const translateToolCall = (data: any, state: TranslateState): void => {
    const name = typeof data?.name === 'string' && data.name ? data.name : 'tool';
    const args = tryParseJson(data?.arguments);
    if (data?.callId !== undefined && data?.callId !== null) {
      state.toolNames.set(String(data.callId), name);
      state.toolArguments.set(String(data.callId), args);
    }
    send({ type: 'tool_call', name, args });
  };

  const translateToolResult = (data: any, state: TranslateState): void => {
    // dsh-session 的 tool/result：data.message = ToolResultMessage
    // { role:'tool', toolCallId, isError?, content: ContentBlock[]（文本块直接内联） }。
    const message = data?.message;
    if (!message || !Array.isArray(message.content)) return;
    const callId = String(message.toolCallId ?? '');
    const name = state.toolNames.get(callId) || 'tool';
    const args = state.toolArguments.get(callId) as { command?: unknown } | undefined;
    state.toolArguments.delete(callId);
    let result = textOf(message.content, '\n');
    if (message.isError || data?.isError) result = `[error] ${result}`;
    hooks.onToolOutcome?.({ name, args, result, failed: Boolean(message.isError || data?.isError) });
    send({ type: 'tool_result', name, result, ...(name === 'run_command' && typeof args?.command === 'string' ? { command: args.command } : {}) });
  };

  const translateEvent = (event: any, state: TranslateState): void => {
    try {
      if (!event || typeof event !== 'object') return;
      const data = event.data;
      switch (event.type) {
        case 'assistant/message':
          translateAssistantMessage(data, state);
          return;
        case 'tool/call':
          translateToolCall(data, state);
          return;
        case 'tool/result':
          translateToolResult(data, state);
          return;
        case 'step/start': {
          if (typeof data?.step === 'number') send({ type: 'step', step: data.step });
          return;
        }
        case 'turn/end': {
          const kind = data?.reason?.kind;
          if (kind === 'error') {
            const failure = data.reason.error || {};
            const code = typeof failure.code === 'string' && failure.code ? failure.code : 'UNKNOWN';
            const detail = redactDshSensitiveText(failure.message || 'dsh 未提供详细错误信息');
            // 同步写服务端日志：此类错误只发前端的话，排查（如 QUOTA 余额不足）时无迹可查
            console.error('[dsh] 引擎执行失败（%s）: %s', code, detail);
            send({ type: 'error', error: zh ? `dsh 引擎执行失败（${code}）：${detail}` : `DSH execution failed (${code}): ${detail}` });
            return;
          }
          if (kind === 'aborted') {
            send({ type: 'done', content: '__CANCELLED__' });
            return;
          }
          if (kind && kind !== 'completed') {
            // blocked / max-tokens / interrupted / forked 等：不是正常完成。
            console.error('[dsh] 引擎异常结束（%s）', kind);
            send({ type: 'error', error: zh ? `dsh 引擎异常结束（${redactDshSensitiveText(kind)}）` : `DSH ended unexpectedly (${redactDshSensitiveText(kind)})` });
            return;
          }
          // 最后一条 assistant/message 才是面向用户的结论；各步中间分析只用于执行记录。
          const content = state.lastAssistantText || state.accumulatedText;
          if (content.trim()) send({ type: 'done', content });
          else {
            console.error('[dsh] 引擎已结束，但没有返回可显示的回答');
            send({ type: 'error', error: zh ? 'dsh 引擎已结束，但没有返回可显示的回答' : 'DSH ended without a displayable answer; results have not been verified.' });
          }
          return;
        }
        default:
          // turn/start、step/end、system/message、user/message、request/header、
          // request/context、session/title、permission/preset、sandbox/mode、
          // approval/policy、approval/asked|decided（审计对）、agent/inbox/spliced、
          // session-log-deepseek/delivery-accepted 等一律忽略。
          return;
      }
    } catch (err) {
      console.warn('[dsh] 事件翻译异常（已忽略）: %s', err instanceof Error ? err.message : String(err));
    }
  };

  return { translateEvent };
}
