// dsh 引擎编排：server.ts 的 /api/ai/stream agent 分支在 selectDshEngine 判为 dsh 时调用。
// 流程：ensureSidecar（失败 → 'fallback' 让调用方走 legacy）→ 会话映射冷恢复
// （session/resume；失败建新会话）→ working-directory 对齐 → session/prompt →
// session.event 订阅翻译 → 审批/反问经桥 HTTP 应答器挂起确认 → turn/end 收尾。
//
// 0.2.1-alpha.5 迁移要点：
// - 通信面是 stdio JSON-RPC（dshSdkClient），没有 mux/history/selectModel/cancel；
//   provider+model 在 sidecar initialize 时确定（改模型 = 重启 sidecar，由
//   dshSidecar 的 optionsFingerprint 处理）。
// - 审批（approval/request）与反问（user-questions/request）由插件内 HTTP 应答器
//   桥回本进程，这里经 registerDshInteractionHandler 认领本会话的交互。
// - 协议没有会话级取消：本地中止只做收尾，引擎侧回合跑到当前工具调用结束；
//   所有集群命令仍受桥策略闸门约束，不会失控。

import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { bindDshSession, setDshSessionReadOnly, registerDshInteractionHandler, type DshConfirmationPolicy } from './bridgeState';
import { isClarificationRequest, normalizeQuestionAnswer, clarificationInstruction } from '../../shared/questionIntent';
import { ensureUserChoiceOptions } from '../../shared/askOptions';
import { getQuestionLoopGuard } from '../ai/questionLoopGuard';
import { classifyCommandRisk } from '../ai/commandSafety';
import { ensureSidecar, getSidecarClient } from './dshSidecar';
import type { DshSdkClient } from './dshSdkClient';
import { createTranslateState, createTranslator } from './dshTranslate';
import { normalizeDeepSeekBaseUrl, redactDshSensitiveText } from './dshConfigSafety';
import { writeFileAtomic0600 } from './fileUtils';
import { addBindings, extractSubmittedJobIds, initJobAgentBindings, isSubmissionCommand } from './jobAgentBindings';
import type { ApprovalDecision } from '../ai/commandApprovals';

export interface DshAgentProfile {
  provider: string;
  model: string;
  apiKey?: string;
  baseUrl?: string;
}

export interface DshAgentOptions {
  send: (event: any) => void;
  requestAbort: AbortSignal;
  requestId: string;
  profile: DshAgentProfile;
  userText: string;
  summary?: string;
  recentMessages?: Array<{ role: string; content: string }>;
  locale: 'zh-CN' | 'en-US';
  /** 本次 agent 请求对应的集群 SSH 会话（桥路由靠它定位目标连接） */
  sshSessionId?: string;
  /** 用户选择的本地工作区（dsh 会话 cwd；不同目录映射不同 dsh 会话） */
  workspace?: string;
  /** 当前激活的 TRACE 对话 id（作业唤醒时回写续跑内容用；可能未保存过） */
  conversationId?: string;
  /** TRACE 会话标识 → dsh sessionId 的持久化映射键 */
  conversationKey: string;
  /** 与内置 Agent 相同的命令/文件确认策略。 */
  confirmationPolicy?: DshConfirmationPolicy;
  dataRoot: string;
  pluginSourceDir: string;
  skillDirs: string[];
  /** Agent 拿到作业号后立即交给服务端 watcher，避免短作业漏检。 */
  onJobsSubmitted?: (jobIds: string[]) => void;
  /** 复用 server.ts 的挂起确认机制：给用户发 confirm、等待 /api/ai/confirm 裁决 */
  onConfirm: (meta: { rpcId: string; sessionId: string; approvalId: string; command: string; risk: string }) => Promise<boolean | ApprovalDecision>;
  /** 把 dsh ask_user_question 交给前端，在原 SSE 连接上等待用户回答。 */
  onQuestion: (meta: {
    rpcId: string;
    sessionId: string;
    questions: Array<{
      id: string;
      question: string;
      detail?: string;
      header?: string;
      options?: Array<{ label: string; description?: string }>;
      multiSelect?: boolean;
    }>;
  }) => Promise<{ answers: Array<{ id: string; selected: string[]; custom?: string; intent?: 'clarification' }> } | null>;
}

export type DshAgentOutcome = 'completed' | 'fallback';

/** 90 秒无事件触发一次活性探测，不把慢推理/长工具调用误判成失败。 */
const IDLE_TIMEOUT_MS = 90_000;

/** 插件审批 reason 的固定格式："HPClaw 命令确认\n风险级: <risk>\n命令: <cmd>"（旧版前缀 TRACE 也兼容）。 */
const CONFIRM_REASON_PATTERN = /^(?:TRACE|HPClaw) 命令确认\r?\n风险级\s*[:：]\s*(.+?)\r?\n命令\s*[:：]\s*([\s\S]*)$/;

function readSessionMap(file: string): Record<string, string> {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      const out: Record<string, string> = {};
      for (const [key, value] of Object.entries(raw)) {
        if (typeof value === 'string') out[key] = value;
      }
      return out;
    }
  } catch { /* 文件不存在或损坏：按空映射处理 */ }
  return {};
}

function newSessionId(): string {
  return `trace-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
}

/**
 * 冷恢复映射会话：session/resume 恢复持久化会话；已在本进程打开视为成功；
 * 不存在/不可读则返回 undefined 让调用方建新会话。
 */
async function resumeMappedSession(client: DshSdkClient, sessionId: string): Promise<boolean> {
  try {
    await client.resume(sessionId);
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/already (open|owned|opening)/i.test(message)) return true;
    console.warn('[dsh] 会话冷恢复失败（将新建会话）: %s', redactDshSensitiveText(message));
    return false;
  }
}

export async function runDshAgent(opts: DshAgentOptions): Promise<DshAgentOutcome> {
  const zh = opts.locale !== 'en-US';
  opts.send({
    type: 'status',
    phase: 'preparing',
    message: zh ? '正在启动 dsh 引擎…' : 'Starting the dsh engine…',
    requestId: opts.requestId,
  });

  const extraEnv: Record<string, string | undefined> = {};
  if (opts.profile.provider === 'deepseek' && opts.profile.apiKey) {
    extraEnv.DEEPSEEK_API_KEY = opts.profile.apiKey;
    try {
      extraEnv.DEEPSEEK_BASE_URL = normalizeDeepSeekBaseUrl(opts.profile.baseUrl);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      opts.send({ type: 'error', error: redactDshSensitiveText(message), requestId: opts.requestId });
      return 'completed';
    }
  }

  // 无集群会话时 dsh 桥工具（run_command 走集群）不可用：不发 error 事件，回退
  // legacy 引擎由调用方重跑本轮，避免把"requires an active SSH session"硬错误抛给用户。
  if (!opts.sshSessionId) {
    console.warn('[dsh] 无活动集群会话，回退 legacy 引擎');
    return 'fallback';
  }

  const sidecar = await ensureSidecar({
    pluginSourceDir: opts.pluginSourceDir,
    skillDirs: opts.skillDirs,
    extraEnv,
    provider: 'deepseek-official',
    model: opts.profile.model,
  });
  if (!sidecar.ok) {
    // sidecar 不可用：不发 error 事件，由调用方无缝回退 legacy 引擎重跑本轮。
    console.warn('[dsh] sidecar 不可用，回退 legacy 引擎: %s', sidecar.reason || 'unknown');
    return 'fallback';
  }
  const client = getSidecarClient();
  if (!client) {
    console.warn('[dsh] sidecar 就绪但无 sdk 客户端，回退 legacy 引擎');
    return 'fallback';
  }

  try {
    // TRACE 会话 → dsh sessionId 映射落盘（读-改-写），重启后冷恢复上下文。
    // 选了工作区时：cwd 用工作区（dsh 的本地文件/bash 工具落点），映射键带上
    // 目录哈希——不同工作区是独立的 dsh 会话。
    const sessionCwd = opts.workspace || opts.dataRoot;
    const mapKey = opts.workspace
      ? `${opts.conversationKey}@${createHash('sha1').update(opts.workspace).digest('hex').slice(0, 10)}`
      : opts.conversationKey;
    const mapFile = path.join(opts.dataRoot, 'dsh-sessions.json');
    const sessionMap = readSessionMap(mapFile);
    const mappedSessionId = sessionMap[mapKey];
    let sessionId = mappedSessionId;
    if (sessionId && !(await resumeMappedSession(client, sessionId))) sessionId = undefined;
    if (!sessionId) sessionId = newSessionId();

    // 会话目录对齐到当前工作区（未知 sessionId 会被该调用创建；恢复的旧会话
    // 沿用存储目录时，这里把有效目录切回用户本轮选择的工作区）。
    await client.setWorkingDirectory(sessionId, sessionCwd);

    if (sessionId !== mappedSessionId) {
      sessionMap[mapKey] = sessionId;
      try {
        writeFileAtomic0600(mapFile, JSON.stringify(sessionMap, null, 2));
      } catch (err) {
        console.warn('[dsh] 会话映射落盘失败: %s', err instanceof Error ? err.message : String(err));
      }
    }

    bindDshSession({
      dshSessionId: sessionId,
      sshSessionId: opts.sshSessionId,
      workspaceRoot: sessionCwd,
      conversationKey: opts.conversationKey,
      confirmationPolicy: opts.confirmationPolicy || 'dangerous',
      readOnly: isClarificationRequest(opts.userText),
      resume: { conversationId: opts.conversationId, locale: opts.locale,
        profile: { provider: opts.profile.provider, model: opts.profile.model, baseUrl: opts.profile.baseUrl } },
    });

    const languageInstruction = zh
      ? '面向用户的内容使用中文。命令、路径、目录名、文件名、工具原始输出和科学标识符必须逐字原样引用，禁止翻译或改写。生物信息学固定术语、实验类型、软件名、参数名、文件格式和指标使用领域通行写法，不逐词硬译；ChIP-seq、ATAC-seq、DAP-seq、FRiP、SPOT、TSS enrichment、IDR、bigWig、deepTools 等原样保留，确需解释时首次写“规范中文解释（英文术语）”。'
      : 'Use English for all user-facing text. Keep commands, paths, directory names, filenames, raw tool output, scientific identifiers, assay names, software names, parameter flags, file formats, and established bioinformatics metrics unchanged — never translate or paraphrase them.';
    const displayInstruction = zh
      ? '在对话中展示图片或图表时，直接用标准 Markdown 图片语法写文件路径（![描述](路径)）：集群绝对路径、本地绝对路径（C:\\...）和工作区相对路径都会被客户端自动内联渲染；不要为此启动临时 HTTP 服务，也不要 base64 内联。表格用标准 Markdown 表格语法。'
      : 'To show images or charts in chat, write standard Markdown image syntax with plain file paths (![desc](path)): cluster absolute paths, local absolute paths (C:\\...) and workspace-relative paths are all rendered inline by the client. Never start a temporary HTTP server or inline base64 for this. Use standard Markdown tables for tabular data.';
    const autonomyInstruction = zh
      ? '目标和路径明确时直接使用工具完成安全操作并验证结果，不要只把命令发给用户自己执行；仅在缺少关键科学参数或遇到高风险操作确认时暂停。'
      : 'When the goal and paths are clear, use tools to complete safe operations and verify the result instead of handing commands back to the user; pause only for a missing scientific decision or a high-risk confirmation.';
    const evidenceInstruction = zh
      ? '汇报先给出明确状态：已完成并验收、已提交等待作业、执行失败、或结果尚未核验。提交回执不等于分析完成，连接超时不等于集群作业失败。每个 QC 数值必须来自本轮读取的具体文件与字段，注明 reads/片段及过滤前后口径；同一指标的正文、表格、可视化必须一致。不得把生成的报告卡片当作实测证据，不能核实的参数和结论明确标为待确认。恢复前先查作业状态与已有产物，不重复提交仍存活的作业。'
      : 'Lead with an explicit outcome: completed and validated, submitted and awaiting jobs, failed, or not yet verified. A submission receipt does not prove analysis completion; a connection timeout does not prove a cluster job failed. Cite the exact file and field for each QC value read in this turn, distinguishing reads from fragments and pre-filter from post-filter counts. Keep narrative, tables and visualizations consistent. Generated report cards are not measured evidence. Label unverified parameters and conclusions explicitly. Check existing jobs and outputs before recovery; never resubmit a live job.';
    const finalInstruction = zh
      ? '最后一条回复必须直接给出简短结果总结：完成了什么、证据是什么、还有什么阻碍。不要把内部推理、中间分析或重复思考当作最终答复。'
      : 'End with a concise result summary: what completed, the evidence and any blocker. Never use internal reasoning, intermediate analysis or repeated thinking as the final answer.';
    const text = languageInstruction
      + '\n' + finalInstruction
      + '\nQUESTION POLICY: Explain user follow-up questions before requesting a decision. Use concrete options for real choices. Never repeat a question already answered unless a materially new input is missing. A request to explain is not authorization; approvals remain separate. After a valid answer, continue the existing safe task rather than asking the same permission again.'
      + (isClarificationRequest(opts.userText) ? '\n' + clarificationInstruction(opts.userText) : '')
      + `\n${zh ? '在流程质控步骤中，必须读取真实指标并按该流程已声明的标准记录 pass/warn/fail，命令执行成功不等于质控通过。fail 时明确提醒“质量不佳，不建议继续下游分析”，列出未达标指标、标准及来源，暂停自动推进，不提交下游作业；仅用户明确确认风险后才能继续，且保留失败记录。warn 只作警告，不误报失败。不得凭空归因为测序深度不足、擅自降低阈值或把失败改成通过。' : 'For workflow QC, read real metrics and record pass/warn/fail against the declared assay-specific criteria; command success is not QC pass. On failure, warn "QC failed: poor quality; downstream analysis is not recommended", cite the failed metrics, criteria and sources, and pause automatic progression without submitting downstream jobs. Continue only after explicit user acknowledgement, retaining the failed QC record. A warning alone is not a failure. Never invent a sequencing-depth explanation, lower scientific cutoffs without approval, or relabel failed QC as passed.'}`
      + `\n${displayInstruction}`
      + `\n${autonomyInstruction}`
      + `\n${evidenceInstruction}`
      + `\n${zh ? '定量指标必须注明来源、样本、处理阶段和 reads/fragments 单位；表格与正文数值冲突时先复核，不可直接判通过。BAM 完整且比对率高只证明比对阶段结果，不能代替文库复杂度、富集、对照适用性和重复一致性质控。未获得相应指标时不得宣称文库全部合格。样本名不能证明对照适用性；基因组版本和有效基因组大小要用核实过的参考证据，不能套用 hs 或未经验证的组装长度比例。SSUSP、137、Killed 本身不能确定为内存不足；先查 bjobs -l/-s、历史和错误日志，再按当前站点核实的资源政策处理；#BSUB -n 是处理器 slots，不是物理节点数。' : 'For every quantitative metric identify its source, sample, processing stage and reads/fragments unit. Reconcile conflicting table and narrative values before a QC conclusion. A valid BAM and high alignment rate do not establish overall library quality; separately evaluate assay-appropriate complexity, enrichment, control suitability and replicate reproducibility. Missing QC is not a pass. A sample name does not establish control suitability. Verify the genome build and effective genome size; do not use hs or an unverified fraction of assembly length. SSUSP, exit 137 or Killed alone does not establish out-of-memory: inspect scheduler reasons, history and stderr, then follow the verified site resource policy. #BSUB -n specifies processor slots, not physical node count.'}`
      + `\n${zh ? '审批结果必须精确区分用户主动拒绝、策略自动拦截、超时、取消和通道故障，禁止猜测用户犹豫或点了拒绝。只在收到执行结果并核验状态后说操作已完成。PEND 是待调度，USUSP/SSUSP/PSUSP 是挂起，不等于 RUN；挂起作业可能保留资源，以调度器实测为准。bjobs 中作业消失/not found 不证明 DONE，需 bhist/bacct 或其他终态证据及产物验收。取消待调度作业不会删除已有结果，也不证明某路线的结果全部放弃；说明实际影响和仍存在的产物。未提交执行的命令应称“已尝试请求执行，未执行”，不可称“已经执行”。' : 'Distinguish explicit user rejection, policy denial, expiry, cancellation and transport failure; never speculate about user hesitation. Claim an operation completed only after execution evidence and state verification. PEND is pending; USUSP/SSUSP/PSUSP are suspended, not RUN, and may retain allocations. A job disappearing from bjobs or returning not found does not prove DONE: inspect bhist/bacct or equivalent terminal evidence and validate outputs. Cancelling a pending job does not delete existing outputs or prove all results of a route are abandoned. A blocked command was requested, not executed.'}`
      + (opts.summary ? `\n\n${zh ? '对话摘要：' : 'Conversation summary: '}${opts.summary}` : '')
      + `\n\n${opts.userText}`;
    return await runEventLoop(opts, client, sessionId, zh, text);
  } catch (err) {
    const message = redactDshSensitiveText(err instanceof Error ? err.message : String(err));
    console.error('[dsh] 运行失败: %s', message);
    opts.send({
      type: 'error',
      error: zh ? `dsh 引擎运行失败：${message}` : `dsh engine failed: ${message}`,
      requestId: opts.requestId,
    });
    return 'completed';
  }
}

function runEventLoop(opts: DshAgentOptions, client: DshSdkClient, sessionId: string, zh: boolean, promptText: string): Promise<DshAgentOutcome> {
  return new Promise(resolve => {
    const state = createTranslateState(sessionId);
    let finished = false;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    let promptStarted = false;
    let lastTool = '';
    let explainOnly = isClarificationRequest(opts.userText);
    let blockedQuestions = 0;
    const submittedJobIds = new Set<string>();
    const questionGuard = getQuestionLoopGuard(opts.dataRoot + ':' + opts.conversationKey);
    questionGuard.observeHistory(opts.recentMessages || []);
    if (!explainOnly) questionGuard.beginTurn(opts.userText);

    const sendError = (message: string): void => {
      opts.send({ type: 'error', error: message, outcome: 'unverified', lastTool,
        jobIds: [...submittedJobIds], requestId: opts.requestId });
    };

    const unregisterInteraction = registerDshInteractionHandler(sessionId, {
      onApproval: async req => {
        if (idleTimer) clearTimeout(idleTimer);
        try {
          const reason = typeof req.reason === 'string' ? req.reason : '';
          const match = CONFIRM_REASON_PATTERN.exec(reason);
          const command = match ? match[2].trim() : (reason || (zh ? '(未提供)' : '(not provided)'));
          const risk = match ? match[1].trim() : 'unknown';
          let decision: ApprovalDecision = { approved: false, reason: 'unavailable' };
          try {
            const answer = await opts.onConfirm({
              rpcId: req.requestId, sessionId, approvalId: req.requestId, command, risk,
            });
            decision = typeof answer === 'boolean'
              ? { approved: answer, reason: answer ? 'allowed' : 'rejected' } : answer;
          } catch {
            decision = { approved: false, reason: 'unavailable' };
          }
          if (finished) return 'unavailable';
          if (decision.approved) return 'allowed-once';
          if (decision.reason === 'rejected') return 'rejected';
          // 非拒绝类失败（expired/cancelled/unavailable）：命令未执行且不是用户拒绝——
          // 如实告知并收尾本轮；引擎侧回合会带着 fail-closed 的工具结果自行结束。
          sendError(zh
            ? `命令尚未执行：确认${decision.reason === 'expired' ? '已超时' : decision.reason === 'cancelled' ? '已取消' : '通道不可用'}，不是用户拒绝。已暂停本轮 Agent；集群作业未被终止。`
            : `Command not executed: approval ${decision.reason}. This was not a user rejection. The Agent turn is paused; cluster jobs were not terminated.`);
          finish('completed');
          return 'unavailable';
        } finally {
          if (!finished) armIdleTimer();
        }
      },
      onQuestions: async req => {
        if (finished) return null;
        if (idleTimer) {
          clearTimeout(idleTimer);
          idleTimer = undefined;
        }
        try {
          const questions = Array.isArray(req.questions) ? req.questions : [];
          if (questions.length === 0) return { answers: [] };
          const forwarded: typeof questions = [];
          const corrections: Array<{ id: string; selected: string[]; custom: string }> = [];
          for (const question of questions) {
            const decision = questionGuard.decide(String(question.question || ''), question.options, explainOnly);
            if (decision.allowed) {
              // dsh 插件的提问可能没有选项:先过守卫(空泛提问仍被拦截),
              // 再按内置引擎同一兜底规则补齐可点选项,保证提问卡永远带建议。
              const ensuredLabels = ensureUserChoiceOptions(
                String(question.question || ''),
                (question.options || []).map(option => option.label),
                zh ? 'zh-CN' : 'en-US',
              );
              forwarded.push({ ...question, options: ensuredLabels.map(label => ({ label })) });
            } else {
              corrections.push({ id: String(question.id || ''), selected: [], custom: decision.feedback });
            }
          }
          if (corrections.length) blockedQuestions++;
          if (blockedQuestions >= 3) {
            // 旧实现在此 cancel 会话；sdk 协议无会话级取消——把纠偏答案送回，
            // 让模型带着"解释或继续"的反馈自行收尾，效果等价且不留隐形挂起。
            sendError(zh ? '已拦截重复反问，但引擎仍未解释或推进任务，本轮 Agent 已暂停；没有代你选择、批准或终止集群作业。'
              : 'Repeated questions were blocked, but the engine did not explain or advance the task. This Agent turn is paused; no choice or approval was invented and cluster jobs were not terminated.');
            finish('completed');
            return { answers: corrections };
          }
          if (corrections.length) opts.send({ type: 'status', phase: 'working', requestId: opts.requestId,
            message: zh ? '已拦截空泛或重复反问，要求 Agent 解释方案或使用已有回答继续。' : 'Blocked a vague or repeated question; the Agent must explain options or use the existing answer.' });
          const answer = forwarded.length ? await opts.onQuestion({ rpcId: req.requestId, sessionId, questions: forwarded }) : { answers: [] };
          if (finished) return null;
          if (!answer) {
            // 用户关闭提问卡片：本轮按取消收尾；工具侧由插件交还瀑布（NO_PROVIDER），
            // 模型得到"提问通道不可用"的工具结果后自然结束，不留挂起等待。
            opts.send({ type: 'done', content: '__CANCELLED__', requestId: opts.requestId });
            finish('completed');
            return null;
          }
          const responses = answer.answers.map(raw => {
            const normalized = normalizeQuestionAnswer(raw);
            const question = forwarded.find((q: any) => String(q.id) === String(raw.id));
            if (question) questionGuard.answer(String(question.question || ''), normalized);
            if (normalized.intent === 'clarification') {
              explainOnly = true;
              setDshSessionReadOnly(sessionId, true);
              return { id: raw.id, selected: [], custom: clarificationInstruction(normalized.custom || 'Explain options first.') };
            }
            return { id: raw.id, selected: normalized.selected, ...(normalized.custom ? { custom: normalized.custom } : {}) };
          });
          return { answers: [...responses, ...corrections] };
        } finally {
          if (!finished) armIdleTimer();
        }
      },
    });

    const finish = (result: DshAgentOutcome): void => {
      if (finished) return;
      finished = true;
      if (idleTimer) clearTimeout(idleTimer);
      opts.requestAbort.removeEventListener('abort', onAbort);
      unregisterInteraction();
      unsubscribeEvents();
      resolve(result);
    };

    const translator = createTranslator({
      locale: opts.locale,
      onToolOutcome: ({ name, args, result, failed }) => {
        if (failed || /^\[error\]|^(?:run_command|cluster_fs) failed:/i.test(result)) return;
        let data: any;
        try { data = JSON.parse(result); } catch { /* Non-JSON native tools use their error flag. */ }
        if (data?.ok === false || data?.success === false || data?.error || (typeof data?.exitCode === 'number' && data.exitCode !== 0)) return;
        if ((name === 'get_workflow_run' || name === 'update_workflow_run') && data?.steps && questionGuard.observeRun(data)) blockedQuestions = 0;
        if ((name === 'run_command' && typeof (args as any)?.command === 'string' && classifyCommandRisk((args as any).command) !== 'read')
          || /^(?:write|edit|apply_patch)$/.test(name)
          || (name === 'cluster_fs' && /^(?:write|push)$/.test((args as any)?.action || ''))) { questionGuard.progress(); blockedQuestions = 0; }
      },
      send: (event: any) => {
        if (finished) return;
        if (!event || typeof event !== 'object') return;
        // 作业绑定：run_command 输出捕获 bsub 作业号 → 登记（jobWatcher 终态时
        // dshJobResumer 凭绑定把"作业完成"注入同一条 dsh 会话，闭合 Agent 外圈）。
        // v0.4.31：只有命令本身是提交命令（bsub/sbatch/qsub）才登记——cat 历史
        // submit 日志/bjobs 查询输出同样含 "Job <id> is submitted"，不能当新提交。
        if (event.type === 'tool_call') lastTool = String(event.name || 'tool');
        if (event.type === 'tool_result' && event.name === 'run_command' && sessionId) {
          try {
            const jobIds = isSubmissionCommand(String(event.command || ''))
              ? extractSubmittedJobIds(String(event.result ?? ''))
              : [];
            if (jobIds.length > 0) {
              for (const id of jobIds) submittedJobIds.add(id);
              initJobAgentBindings(opts.dataRoot);
              const added = addBindings(jobIds, {
                sshSessionId: opts.sshSessionId || '',
                conversationKey: opts.conversationKey,
                dshSessionId: sessionId,
                engine: 'dsh',
                conversationId: opts.conversationId,
                workspace: opts.workspace,
                confirmationPolicy: opts.confirmationPolicy,
                // apiKey 不写入绑定文件（明文落盘风险）；唤醒时由 resumer 从服务端加密配置读取
                profile: {
                  provider: opts.profile.provider,
                  model: opts.profile.model,
                  baseUrl: opts.profile.baseUrl,
                },
                locale: opts.locale,
              });
              opts.onJobsSubmitted?.(jobIds);
              if (added > 0) console.log('[dsh] 作业绑定登记: %s → session %s', jobIds.join(','), sessionId);
            }
          } catch (err) {
            console.warn('[dsh] 作业绑定登记失败: %s', err instanceof Error ? err.message : String(err));
          }
        }
        if (event.type === 'done' || event.type === 'error') {
          opts.send({ ...event, requestId: opts.requestId });
        } else {
          opts.send(event);
        }
        if (event.type === 'done' || event.type === 'error') finish('completed');
      },
    });

    const unsubscribeEvents = client.onSessionEvent(({ sessionId: target, event }) => {
      if (finished || target !== sessionId || !promptStarted) return;
      armIdleTimer();
      translator.translateEvent(event, state);
    });

    const armIdleTimer = (): void => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => void onIdle(), IDLE_TIMEOUT_MS);
      idleTimer.unref?.();
    };

    /**
     * 空闲探测：stdio 是有序可靠通道，事件不会"丢失"；90s 无事件只可能是
     * 长推理/长工具。用 session/wait 竞速区分仍在执行与会话异常消失。
     */
    const onIdle = async (): Promise<void> => {
      if (finished || !promptStarted) return;
      try {
        const probe = await client.probeSession(sessionId, 5_000);
        if (finished) return;
        if (probe === 'running') {
          opts.send({ type: 'status', phase: 'working', requestId: opts.requestId,
            message: zh ? `DSH 已确认仍在执行${lastTool ? `（${lastTool}）` : ''}，正在等待结果；未重复提交任务。`
              : `DSH confirms the task is still running${lastTool ? ` (${lastTool})` : ''}; awaiting results. No duplicate submission.` });
          console.info('[dsh] idle probe: running=true request=%s lastTool=%s', opts.requestId, lastTool);
          armIdleTimer();
          return;
        }
        if (probe === 'idle') {
          // idle 但没看到 turn/end：会话状态与事件流不一致，如实报未核验。
          sendError(zh ? 'DSH 会话已转入空闲，但未收到本轮的结束记录；结果尚未核验。请先检查作业状态和输出文件，勿直接重跑。'
            : 'The DSH session became idle, but no end-of-turn record arrived. Results are unverified. Check jobs and output files before rerunning.');
          finish('completed');
          return;
        }
        sendError(zh ? 'DSH 会话不存在（sidecar 可能已重启）。结果尚未核验，未自动重跑；已提交的集群作业可能仍在运行，请先核对作业和产物。'
          : 'The DSH session is unknown (the sidecar may have restarted). Results are unverified; no automatic rerun was attempted. Submitted cluster jobs may still be running. Check jobs and outputs first.');
        finish('completed');
      } catch (err) {
        if (finished) return;
        sendError(zh ? `DSH 通信中断，状态查询未成功${lastTool ? `；最后工具：${lastTool}` : ''}。结果尚未核验，未自动重跑；已提交的集群作业可能仍在运行，请先核对作业和产物。`
          : `DSH communication was interrupted and a status check failed${lastTool ? `; last tool: ${lastTool}` : ''}. Results are unverified; no automatic rerun was attempted. Submitted cluster jobs may still be running. Check jobs and outputs first.`);
        finish('completed');
      }
    };

    const start = async (): Promise<void> => {
      if (finished) return;
      // 防重投：本会话已有任务在执行时，不把新指令排到旧 turn 后面。
      // 状态来自 session.status 通知缓存；未知（如 sidecar 重启后）时用 wait 竞速探测。
      let running = client.sessionStatusOf(sessionId) === 'running';
      if (!running && client.sessionStatusOf(sessionId) === undefined && client.isAlive) {
        running = await client.probeSession(sessionId, 2_000) === 'running';
      }
      if (finished) return;
      if (running) {
        sendError(zh ? '本对话的 DSH 任务仍在执行，本次指令未重复提交。请先查看现有任务状态，或明确停止旧任务后再发新指令。'
          : 'A DSH task in this conversation is still running. This instruction was not resubmitted. Check the existing task, or explicitly stop it before sending a new instruction.');
        finish('completed');
        return;
      }
      promptStarted = true;
      try {
        await client.prompt({ sessionId, text: promptText });
      } catch (err) {
        const detail = redactDshSensitiveText(err instanceof Error ? err.message : String(err));
        sendError(zh ? `DSH 请求应答通信失败：${detail}。本次请求是否已受理尚未核验，未自动重投；请先检查现有任务状态。` : `DSH prompt communication failed: ${detail}. Acceptance is unverified; no automatic retry was attempted. Check the existing task first.`);
        finish('completed');
        return;
      }
      if (finished) return;
      opts.send({
        type: 'status',
        phase: 'working',
        message: zh ? 'dsh 引擎已接管，正在执行…' : 'The dsh engine is working…',
        requestId: opts.requestId,
      });
      armIdleTimer();
    };

    const onAbort = (): void => {
      // sdk 协议没有会话级取消：本地收尾。引擎侧回合会跑到当前工具调用结束，
      // 集群命令全程受桥策略闸门约束，不会失控。
      console.warn('[dsh] 请求已中止：sdk 协议无会话级取消，引擎侧回合将在当前工具调用结束后收尾');
      finish('completed');
    };

    opts.requestAbort.addEventListener('abort', onAbort, { once: true });
    if (opts.requestAbort.aborted) {
      onAbort();
      return;
    }

    void start();
  });
}
