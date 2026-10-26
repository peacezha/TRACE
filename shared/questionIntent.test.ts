import { describe, expect, it } from 'vitest';
import { isClarificationRequest, normalizeQuestionAnswer } from './questionIntent';
describe('explanation vs execution intent', () => {
  it.each(['有哪些修复方案', '有哪些修复方案？', '请先解释推荐方案', '请先别执行，解释方案', 'Please explain the options.', 'What are my recovery options?', 'What are the risks?'])('treats a follow-up as explanation, not consent: %s', text => expect(isClarificationRequest(text)).toBe(true));
  it.each(['按方案 A 继续', '解释方案后再修复', 'Explain the options and then apply the fix', '帮我鉴定差异表达基因并分析 GO', '/data/explain_options.fastq.gz', 'IWGSC RefSeq v1.0'])('preserves actual choices, work and literal paths: %s', text => expect(isClarificationRequest(text)).toBe(false));
  it('clears a selected option when the user asks to explain before deciding', () => {
    expect(normalizeQuestionAnswer({ selected: ['A'], custom: '请先解释风险' })).toEqual({ selected: [], custom: '请先解释风险', intent: 'clarification' });
    expect(normalizeQuestionAnswer({ selected: ['A'], custom: '保留对照' })).toEqual({ selected: ['A'], custom: '保留对照' });
  });
});
