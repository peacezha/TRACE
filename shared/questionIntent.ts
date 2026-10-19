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

/**
 * 兜底识别"模型把等用户选择写成了普通文本、没调用 ask_user"的轮次结尾。
 * 保守:只命中明确的"请用户选择/确认/回答"型结尾;陈述句和反问修辞不算。
 * 命中时运行时应把这段文字转成正式 ask(带选项),而不是直接结束。
 */
export function looksLikeAwaitingUserChoice(text: string): boolean {
  const value = String(text || '').trim();
  if (!value) return false;
  const tail = value.slice(-160);
  // 问号收尾:且内容在请求选择/确认/回答,不是知识性问句(问句里在解释事物)
  const endsQuestion = /[？?]\s*$/.test(tail);
  const endsColonChoice = /[：:]\s*$/.test(tail);
  const asksChoice = /请(?:你)?(?:从中)?选(?:择|一个|一条|一项|一下)|选(?:择|一个|一条|一项|哪个|哪种)(?:方向|方案|方式|之一)?|哪个方案|哪种方案|告诉我(?:你选|选择)|是否同意|要不要我|需要你(?:的)?(?:确认|选择|回答)|请(?:你)?(?:确认|回答|选择)|how (?:shall|should) (?:i|we) proceed|which (?:option|approach|direction)|please (?:choose|select|confirm|pick)|would you like me to/i.test(tail);
  const asksOpenQuestion = /(?:你有|你有啥|有什么)(?:问题|疑问|想法|意见)|有任何问题|需要我(?:解释|补充)|怎么看|怎么想/.test(tail);
  if (asksOpenQuestion) return false;
  return asksChoice && (endsQuestion || endsColonChoice);
}
