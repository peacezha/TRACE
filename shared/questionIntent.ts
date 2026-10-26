import type { UserQuestionAnswer } from './aiQuestions';

/** An explanation is neither a choice nor permission to execute. Keep these
 * narrow: ordinary analysis requests and literal paths must remain usable. */
export function isClarificationRequest(text: string): boolean {
  const value = String(text || '').trim();
  if (/(?:然后|随后|并|再)(?:请|帮我|直接)?(?:执行|修复|继续|运行|提交)|\b(?:then|and)\s+(?:please\s+)?(?:execute|apply|fix|continue|run|submit)\b/i.test(value)) return false;
  return /^(?:不是[，,\s]*|那[，,\s]*|请(?:你)?(?:先)?|先|能否|能不能|可以|帮我|麻烦)?\s*(?:(?:有|都|还)?哪些(?:修复|恢复|处理)?(?:方案|方法|选项)|有什么(?:修复|恢复|处理)?(?:方案|办法|选项)|解释|说明(?:一下)?|讲(?:一下|清楚)|说(?:一下|清楚)|(?:各个|这些|这几个|两个)?方案.*(?:区别|风险|推荐|是什么)|为什么.*(?:选择|推荐|采用))/i.test(value)
    || /^(?:请|应该|该|建议)?(?:选择|选|用|采用)(?:哪个|哪种)/.test(value)
    || /^(?:please\s+)?(?:explain\b|clarify\b|tell me (?:the|my|about)\b|what (?:are|is) (?:the |my |our )?(?:repair |recovery )?(?:options|alternatives|plan|recommendation|risks|differences)|what options\b|which (?:option|approach).*(?:recommend|safer|should|choose|better)|why (?:do you|did you|choose|recommend))/i.test(value)
    || /^(?:请)?(?:先别|不要|别)(?:执行|操作|提交|运行).*(?:解释|说明|方案|选项)/.test(value);
}

export function normalizeQuestionAnswer(answer: UserQuestionAnswer): UserQuestionAnswer {
  if (answer.intent === 'clarification' || (answer.custom && isClarificationRequest(answer.custom))) {
    return { selected: [], custom: answer.custom?.trim(), intent: 'clarification' };
  }
  return answer;
}

export function clarificationInstruction(userText: string): string {
  return '[TRACE_CLARIFICATION_ONLY] The user is asking for an explanation, NOT selecting an option or authorizing execution. '
    + 'Explain the concrete alternatives, your recommendation, evidence and risks in the conversation before any decision. '
    + 'Do not ask the same question again, do not invent consent, and do not submit, cancel, write, overwrite or change scientific parameters in this explanation turn. '
    + 'If a required fact is unavailable, state exactly what is missing without another vague choice dialog. User follow-up: ' + userText;
}
