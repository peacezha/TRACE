import { describe, expect, it, vi } from 'vitest';
import { createTranslateState, createTranslator } from './dshTranslate';

function setup(sessionId = 'sess-1') {
  const sent: any[] = [];
  const translator = createTranslator({ send: event => sent.push(event) });
  const state = createTranslateState(sessionId);
  return { sent, translator, state };
}

/** sdk 通道的 SessionEvent 信封（session.event 通知里的 event 本体）。 */
function sdkEvent(event: unknown) {
  return { seq: 1, time: 0, ...(event as object) };
}

describe('dshTranslate (sdk SessionEvent)', () => {
  it('pairs parallel run_command results with their own commands, not the last command issued', () => {
    const { sent, translator, state } = setup();
    translator.translateEvent(sdkEvent({ type: 'tool/call', data: { callId: 'submit', name: 'run_command', arguments: '{"command":"bsub < step-03.lsf"}' } }), state);
    translator.translateEvent(sdkEvent({ type: 'tool/call', data: { callId: 'read', name: 'run_command', arguments: '{"command":"cat logs/old.submit.txt"}' } }), state);
    translator.translateEvent(sdkEvent({ type: 'tool/result', data: { message: { role: 'tool', toolCallId: 'submit', content: [{ type: 'text', text: 'Job <12345> is submitted' }] } } }), state);
    expect(sent.at(-1)).toMatchObject({ type: 'tool_result', command: 'bsub < step-03.lsf' });
  });

  it('uses English for new engine errors and never presents an aborted partial turn as successful', () => {
    const sent: any[] = [];
    const translator = createTranslator({ send: e => sent.push(e), locale: 'en-US' });
    const state = createTranslateState('sess-1');
    state.accumulatedText = 'In progress…';
    translator.translateEvent(sdkEvent({ type: 'turn/end', data: { reason: { kind: 'aborted' } } }), state);
    expect(sent).toEqual([{ type: 'done', content: '__CANCELLED__' }]);
    translator.translateEvent(sdkEvent({ type: 'turn/end', data: { reason: { kind: 'error', error: { code: 'QUOTA', message: 'Insufficient Balance' } } } }), state);
    expect(sent.at(-1)?.error).toBe('DSH execution failed (QUOTA): Insufficient Balance');
  });

  it('emits each assistant message snapshot as one content event and accumulates across steps', () => {
    const { sent, translator, state } = setup();
    translator.translateEvent(sdkEvent({ type: 'assistant/message', data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '你好' }] } } }), state);
    translator.translateEvent(sdkEvent({ type: 'assistant/message', data: { turn: 1, step: 2, message: { role: 'assistant', content: [{ type: 'text', text: '，世界' }] } } }), state);
    expect(sent).toEqual([
      { type: 'content', content: '你好' },
      { type: 'content', content: '，世界' },
    ]);
    expect(state.accumulatedText).toBe('你好，世界');
    expect(state.lastAssistantText).toBe('，世界');
  });

  it('emits reasoning blocks as reasoning events without touching accumulated text', () => {
    const { sent, translator, state } = setup();
    translator.translateEvent(sdkEvent({ type: 'assistant/message', data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'reasoning', text: '先想' }, { type: 'text', text: '再说' }] } } }), state);
    expect(sent).toEqual([
      { type: 'content', content: '再说' },
      { type: 'reasoning', content: '先想' },
    ]);
    expect(state.accumulatedText).toBe('再说');
  });

  it('ignores audit and lifecycle events (approval pair, policy, titles, request headers)', () => {
    const { sent, translator, state } = setup();
    for (const event of [
      { type: 'permission/preset', data: {} },
      { type: 'sandbox/mode', data: {} },
      { type: 'approval/policy', data: { policy: 'ask' } },
      { type: 'approval/asked', data: { id: 'a1', toolName: 'bash', reason: 'HPClaw 命令确认\n风险级: write\n命令: ls' } },
      { type: 'approval/decided', data: { id: 'a1', outcome: 'allowed-once' } },
      { type: 'agent/inbox/spliced', data: {} },
      { type: 'turn/start', data: { turn: 1 } },
      { type: 'system/message', data: { message: { content: [{ type: 'text', text: 'sys' }] } } },
      { type: 'user/message', data: { content: [{ type: 'text', text: 'hi' }] } },
      { type: 'request/header', data: {} },
      { type: 'request/context', data: {} },
      { type: 'session/title', data: { title: 't' } },
      { type: 'session-log-deepseek/delivery-accepted', data: {} },
      { type: 'step/end', data: { turn: 1, step: 1 } },
    ]) {
      translator.translateEvent(sdkEvent(event), state);
    }
    translator.translateEvent(null, state);
    translator.translateEvent({}, state);
    expect(sent).toEqual([]);
  });

  it('translates tool/call into tool_call with parsed args and remembers the callId', () => {
    const { sent, translator, state } = setup();
    translator.translateEvent(sdkEvent({ type: 'tool/call', data: { turn: 1, step: 1, callId: 'call-1', name: 'bash', arguments: '{"command":"ls -la"}' } }), state);
    expect(sent).toEqual([{ type: 'tool_call', name: 'bash', args: { command: 'ls -la' } }]);
    expect(state.toolNames.get('call-1')).toBe('bash');
  });

  it('keeps raw arguments when the JSON does not parse', () => {
    const { sent, translator, state } = setup();
    translator.translateEvent(sdkEvent({ type: 'tool/call', data: { turn: 1, step: 1, callId: 'c2', name: 'bash', arguments: '{broken' } }), state);
    expect(sent).toEqual([{ type: 'tool_call', name: 'bash', args: '{broken' }]);
  });

  it('translates tool/result into tool_result using the remembered tool name', () => {
    const { sent, translator, state } = setup();
    translator.translateEvent(sdkEvent({ type: 'tool/call', data: { turn: 1, step: 1, callId: 'call-1', name: 'wheatomics_query', arguments: '{}' } }), state);
    sent.length = 0;
    translator.translateEvent(sdkEvent({
      type: 'tool/result',
      data: {
        turn: 1,
        step: 1,
        message: { role: 'tool', toolCallId: 'call-1', content: [{ type: 'text', text: 'total: 17' }, { type: 'text', text: 'records: [...]' }] },
      },
    }), state);
    expect(sent).toEqual([{ type: 'tool_result', name: 'wheatomics_query', result: 'total: 17\nrecords: [...]' }]);
  });

  it('falls back to a generic name for unknown callIds', () => {
    const { sent, translator, state } = setup();
    translator.translateEvent(sdkEvent({
      type: 'tool/result',
      data: { turn: 1, step: 1, message: { role: 'tool', toolCallId: 'nope', content: [{ type: 'text', text: 'x' }] } },
    }), state);
    expect(sent).toEqual([{ type: 'tool_result', name: 'tool', result: 'x' }]);
  });

  it('preserves the complete received tool result and prefixes [error] on failure', () => {
    const { sent, translator, state } = setup();
    const long = 'START: ' + 'y'.repeat(5000) + ' END: fatal error';
    translator.translateEvent(sdkEvent({
      type: 'tool/result',
      data: {
        turn: 1,
        step: 1,
        message: { role: 'tool', toolCallId: 'c1', content: [{ type: 'text', text: long }], isError: true },
      },
    }), state);
    expect(sent).toHaveLength(1);
    expect(sent[0].result).toBe('[error] ' + long);

    sent.length = 0;
    translator.translateEvent(sdkEvent({
      type: 'tool/result',
      data: { turn: 1, step: 1, error: { name: 'ToolError', code: 'X' }, message: { role: 'tool', toolCallId: 'c2', isError: true, content: [{ type: 'text', text: 'outer' }] } },
    }), state);
    expect(sent[0].result).toBe('[error] outer');
  });

  it('translates step/start into a step event', () => {
    const { sent, translator, state } = setup();
    translator.translateEvent(sdkEvent({ type: 'step/start', data: { turn: 1, step: 3 } }), state);
    expect(sent).toEqual([{ type: 'step', step: 3 }]);
  });

  it('uses the last assistant conclusion instead of concatenating intermediate analysis', () => {
    const { sent, translator, state } = setup();
    translator.translateEvent(sdkEvent({ type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'text', text: '中间分析' }] } } }), state);
    translator.translateEvent(sdkEvent({ type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'text', text: '最终总结' }] } } }), state);
    translator.translateEvent(sdkEvent({ type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } }), state);
    expect(sent.at(-1)).toEqual({ type: 'done', content: '最终总结' });
    expect(sent.at(-1).content).not.toContain('中间分析');
  });

  it('turn/end error becomes a visible error and redacts an API key used as the URL', () => {
    const { sent, translator, state } = setup();
    translator.translateEvent(sdkEvent({
      type: 'turn/end',
      data: {
        turn: 1,
        reason: {
          kind: 'error',
          error: { code: 'TRANSPORT', message: 'DeepSeek API request to sk-1234567890abcdef failed' },
        },
      },
    }), state);
    expect(sent).toEqual([{
      type: 'error',
      error: 'dsh 引擎执行失败（TRANSPORT）：DeepSeek API request to sk-*** failed',
    }]);
  });

  it('turn/end error is also written to the server log for diagnosis', () => {
    // QUOTA(余额不足)等 dsh 侧错误此前只发前端、服务端无日志，排查无迹可查
    const { translator, state } = setup();
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      translator.translateEvent(sdkEvent({
        type: 'turn/end',
        data: { turn: 1, reason: { kind: 'error', error: { code: 'QUOTA', message: 'Insufficient Balance' } } },
      }), state);
      expect(spy).toHaveBeenCalledWith('[dsh] 引擎执行失败（%s）: %s', 'QUOTA', 'Insufficient Balance');
    } finally {
      spy.mockRestore();
    }
  });

  it('does not report an empty completed turn as a successful answer', () => {
    const { sent, translator, state } = setup();
    translator.translateEvent(sdkEvent({ type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } }), state);
    expect(sent).toEqual([{ type: 'error', error: 'dsh 引擎已结束，但没有返回可显示的回答' }]);
  });

  it('maps aborted turns to the existing cancelled sentinel', () => {
    const { sent, translator, state } = setup();
    translator.translateEvent(sdkEvent({ type: 'turn/end', data: { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } } }), state);
    expect(sent).toEqual([{ type: 'done', content: '__CANCELLED__' }]);
  });

  it('treats blocked/max-tokens turn ends as errors, not success', () => {
    const { sent, translator, state } = setup();
    translator.translateEvent(sdkEvent({ type: 'turn/end', data: { turn: 1, reason: { kind: 'max-tokens' } } }), state);
    translator.translateEvent(sdkEvent({ type: 'turn/end', data: { turn: 1, reason: { kind: 'blocked' } } }), state);
    expect(sent[0].type).toBe('error');
    expect(sent[1].type).toBe('error');
  });
});
