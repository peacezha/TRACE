import { describe, expect, it } from 'vitest';
import { isClarificationRequest, normalizeQuestionAnswer, looksLikeAwaitingUserChoice } from './questionIntent';
describe('explanation vs execution intent', () => {
  it.each(['有哪些修复方案', '有哪些修复方案？', '请先解释推荐方案', '请先别执行，解释方案', 'Please explain the options.', 'What are my recovery options?', 'What are the risks?'])('treats a follow-up as explanation, not consent: %s', text => expect(isClarificationRequest(text)).toBe(true));
  it.each(['按方案 A 继续', '解释方案后再修复', 'Explain the options and then apply the fix', '帮我鉴定差异表达基因并分析 GO', '/data/explain_options.fastq.gz', 'IWGSC RefSeq v1.0'])('preserves actual choices, work and literal paths: %s', text => expect(isClarificationRequest(text)).toBe(false));
  it('clears a selected option when the user asks to explain before deciding', () => {
    expect(normalizeQuestionAnswer({ selected: ['A'], custom: '请先解释风险' })).toEqual({ selected: [], custom: '请先解释风险', intent: 'clarification' });
    expect(normalizeQuestionAnswer({ selected: ['A'], custom: '保留对照' })).toEqual({ selected: ['A'], custom: '保留对照' });
  });
});

describe('looksLikeAwaitingUserChoice', () => {
  it('命中"请选择方向/方案"类文字提问', () => {
    expect(looksLikeAwaitingUserChoice('文献侧只有 peak BED。比对请选一个方向，我按你选的提交作业：')).toBe(true);
    expect(looksLikeAwaitingUserChoice('两个方案都可以。你要我按哪个方案执行？')).toBe(true);
    expect(looksLikeAwaitingUserChoice('Found two options. Which option should I proceed with?')).toBe(true);
  });
  it('陈述/知识性问句不误判', () => {
    expect(looksLikeAwaitingUserChoice('这个指标为什么偏低？因为测序深度不足。')).toBe(false);
    expect(looksLikeAwaitingUserChoice('你有任何问题吗？')).toBe(false);
    expect(looksLikeAwaitingUserChoice('流程已全部完成，报告在 results/。')).toBe(false);
    expect(looksLikeAwaitingUserChoice('')).toBe(false);
  });
});
