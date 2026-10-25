import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { isPublicWeb, readPublicPreference, savePublicPreference } from '../services/publicWeb';
import {
  Bot, Settings, Send, Brain, Loader2, ChevronDown, ChevronRight, Save, Check, FolderOpen, Folder, FolderTree,
  AlertCircle, Wifi, WifiOff, RefreshCw, Search, BookOpen, Library, FileText, X, MessageSquarePlus,
  Cpu, GitBranch, Paperclip, ShieldCheck, ArrowDown
} from 'lucide-react';
import { v4 as uuidv4 } from 'uuid';
import WorkflowPanel from './WorkflowPanel';
import FlowRunnerDrawer from './FlowRunnerDrawer';
import WorkflowConfigCard from './WorkflowConfigCard';
import WorkflowRunCard from './WorkflowRunCard';
import ExecutionTrace, { type ExecutionTraceItem } from './ExecutionTrace';
import DetectedFilesStrip from './DetectedFilesStrip';
import WebEmbedList from './WebEmbedList';
import { matchWorkflows as matchWorkflowsApi } from '../features/workflows/api';
import type { Workflow } from '@/shared/workflow';
import type { PickPathKind } from '@/shared/fileTransfer';
import { RichContentMessage, extractDshUiSpecs, DshUiSpecCard } from './rich-content';
import MarkdownMessage from './MarkdownMessage';
import type { WebPanelRequest } from './WebPanelDrawer';
import { motion, AnimatePresence } from 'motion/react';
import { Socket } from 'socket.io-client';
import { useObservationLogger } from '../hooks/useObservationLogger';
import { PROVIDER_MODELS, AIProvider, loadAIProfile, saveAIProfile } from '../services/aiProfile';
import { shouldSubmitOnKey } from '../services/chatInputKeys';
import {
  buildOutgoingMessages,
  findLatestAgentPlanCheckpoint,
  isAgentDoneCancelled,
  isCurrentAiRun,
  latestUserMessage,
  prepareMessagesForAiTransport,
  resolveAgentDoneText,
  shouldDisableChatInput,
  shouldRenderSystemMessage,
  upsertAgentPlanCheckpoint,
} from '../services/chatFlow';
import {
  findLatestWorkflowExecutionContext,
  formatWorkflowConfigureDirective,
  formatWorkflowRunDetached,
  parseWorkflowConfigureDirective,
  parseWorkflowExecutionContext,
  stripWorkflowConfigureDirectives,
  stripWorkflowExecutionMarkers,
  stripWorkflowRunDetachedMarkers,
  workflowRunIdentity,
} from '@/shared/workflowExecution';
import { closeSseReader, type SseReaderCloseReason } from '../services/sseReaderLifecycle';
import { prepareAiRequestBody } from '../services/aiRequestBody';
import { useCommandApprovals } from '../services/useCommandApprovals';
import { useUserQuestions } from '../services/useUserQuestions';
import { usePlanReviews } from '../services/usePlanReviews';
import { AgentTurnClock } from '@/shared/agentTurnClock';
import AIQuestionDialog from './AIQuestionDialog';
import PlanReviewCard from './PlanReviewCard';
import AgentPlanPanel from './AgentPlanPanel';
import {
  appendAttachmentRefs,
  baseName,
  joinLocalPath,
  CLUSTER_ATTACHMENT_DIR,
  type ChatAttachment,
} from '../services/chatAttachments';
import { enqueueTransfer, mkdirRemote } from '../features/file-transfer/api';
import { resolveTransferProfileId } from '../features/file-transfer/sessionIdentity';
import { makeTemporaryTransferName } from '@/shared/fileTransfer';
import {
  loadAgentSettings,
  saveAgentSettings,
  type AgentEnginePreference,
  type AgentConfirmationPolicy,
  type AgentPathPolicy,
  type AgentPlanningPolicy,
  type AgentPlanReviewPolicy,
} from '../services/agentSettings';
import {
  loadAgentWorkspaces,
  saveAgentWorkspaces,
  clearAgentWorkspace,
  needsAgentWorkspaceHint,
} from '../services/agentWorkspace';

import { NCPGR_SYSTEM_PROMPT_CN } from '@/shared/ncpgrRules';
import { LanguageToggle, useI18n } from '../i18n';
import { reportBasePaths } from '@/shared/reportPaths';
import {
  MAX_AGENT_COMMANDS,
  MAX_AGENT_STEPS,
  MIN_AGENT_COMMANDS,
  MIN_AGENT_STEPS,
} from '@/shared/agentLimits';
import { IS_COMPETITION_EDITION } from '../edition';

//  Types 
interface Message {
  role: 'system' | 'user' | 'assistant';
  content: string;
  thoughtSteps?: { step: number; content: string }[];
}

interface Skill {
  filename: string;
  content?: string;
  size?: number;
  isSystem?: boolean;
  name?: string;
  description?: string;
  category?: string;
  source?: string;
}

interface AIChatProps {
  isOpen: boolean;
  executeCommand: (cmd: string, waitAndCapture?: boolean) => Promise<string>;
  socket: Socket | null;
  /** 当前标签页的集群会话 ID：AI 请求通过 X-SSH-Session-Id 路由到对应集群 */
  sessionId?: string | null;
  onSkillsChange: () => void;
  messages: Message[];
  onMessagesChange: (msgs: Message[]) => void;
  onNewChat?: () => void;
  triggerAI?: { tabId: string; count: number }; // external trigger: increments → auto-respond to last user msg (agent mode)
  activeConversationId?: string | null; // changes → abort any running AI request
  /** Stable per-conversation key; unlike sessionId it changes for every new chat. */
  conversationContextId?: string;
  loadingConversationId?: string | null; // non-null while a conversation is being loaded
  onSaveToCluster?: () => void | Promise<void>;
  aiClusterControl?: boolean;
  /** 当前会话的历史摘要（来自会话存储），随请求注入供模型参考 */
  conversationSummary?: string;
  /** 打开集群文件树/传输工作区选择集群文件或目录（流程参数选路径、ask_user 选路径），取消时 resolve null */
  onPickRemoteFolder?: (kind?: PickPathKind) => Promise<string | null>;
  /** 直接在文件传输工作区定位到指定集群目录。 */
  onOpenRemoteFolder?: (path: string, sessionId?: string | null) => void;
  /** Codex 风格主工作区布局：对话居中，流程入口由左侧导航承载。 */
  workspaceLayout?: boolean;
  /** 当前后台计算目标，仅用于工作台标题栏展示。 */
  workspaceTargetLabel?: string;
  workspaceTargetConnected?: boolean;
  onOpenComputeBackend?: () => void;
  /** 主对话标题栏下方的集群任务概览。由 App 提供，避免 AIChat 承担作业领域状态。 */
  jobStatusBar?: React.ReactNode;
  /** 打开右侧网页栏：http(s) 链接或集群远程 HTML（report.html 等） */
  onOpenWebPanel?: (request: WebPanelRequest) => void;
  /** 启动流程运行：交给 App 开该次运行专属的对话执行（避免串对话）；缺省时回退为当前对话内执行 */
  onStartWorkflowRun?: (message: string) => void;
  /** 提交前确保对话已入存档并返回 id：后台运行（detached）要凭 conversationId 回写结果 */
  onEnsureConversation?: (messages: Message[]) => Promise<string | null>;
}

//  Provider defaults 
const PROVIDERS: Record<string, string[]> = {
  ...PROVIDER_MODELS,
  kimi: PROVIDER_MODELS.moonshot,
};

//  Text similarity for dedup detection 
function textSimilarity(a: string, b: string): number {
  if (!a || !b) return 0;
  const wordsA = new Set(a.slice(0, 500).split(/\s+/));
  const wordsB = new Set(b.slice(0, 500).split(/\s+/));
  if (wordsA.size === 0 || wordsB.size === 0) return 0;
  let intersection = 0;
  for (const w of wordsA) { if (wordsB.has(w)) intersection++; }
  return intersection / Math.max(wordsA.size, wordsB.size);
}

//  Extract file paths for result detection 
export function extractOutputFiles(text: string): string[] {
  const patterns = [
    /(?<![\w./~:\\-])(?:\/[\w.-]+)+\.(?:png|jpg|jpeg|gif|svg|bmp|webp|csv|tsv|pdf|html)\b/gi,
    /(?<![\w./:\\-])~(?:\/[\w.-]+)+\.(?:png|jpg|jpeg|gif|svg|bmp|webp|csv|tsv|pdf|html)\b/gi,
  ];
  const paths = new Set<string>();
  for (const p of patterns) {
    const matches = text.match(p) || [];
    matches.forEach(m => paths.add(m));
  }
  return Array.from(paths);
}

export type ConversationTimelineItem =
  | { type: 'message'; message: Message; absoluteIndex: number }
  | { type: 'execution'; items: ExecutionTraceItem[]; key: string };

function isExecutionTraceMessage(message: Message): boolean {
  if (message.role !== 'system') return false;
  return /^\[(?:AI 执行命令|命令输出|命令执行结果|命令输出已隐藏|Agent step|Agent 计划|计划进度|🔧|📄|📋|技能搜索|搜索技能|技能结果|工具|监控作业|已保存技能|AI command|Command output|Tool call|Tool result)/.test(message.content.trim());
}

export function buildConversationTimeline(messages: Message[], absoluteStart: number): ConversationTimelineItem[] {
  const timeline: ConversationTimelineItem[] = [];
  let executionItems: ExecutionTraceItem[] = [];
  // 同一轮（两条用户消息之间）的执行内容合并为一张"执行过程"大卡，
  // 插到该轮首个执行项的位置，保持"解说→过程→结果"的阅读顺序
  let insertAt = -1;
  const flushExecution = () => {
    if (executionItems.length === 0) return;
    timeline.splice(insertAt < 0 ? timeline.length : insertAt, 0, {
      type: 'execution',
      key: `execution-${executionItems[0].absoluteIndex}`,
      items: executionItems,
    });
    executionItems = [];
    insertAt = -1;
  };
  messages.forEach((message, relativeIndex) => {
    const absoluteIndex = absoluteStart + relativeIndex;
    if (isExecutionTraceMessage(message)) {
      if (executionItems.length === 0) insertAt = timeline.length;
      executionItems.push({ message, absoluteIndex });
      return;
    }
    if (message.role === 'user') flushExecution();
    timeline.push({ type: 'message', message, absoluteIndex });
  });
  flushExecution();
  return timeline;
}

function buildFollowUpSuggestions(content: string, isEnglish: boolean, contextText = ''): string[] {
  const text = content.toLowerCase();
  const context = `${contextText}\n${text}`.toLowerCase();

  // AI 答复本身是半成品（很短、或明显是「我先…/接下来…」的开头句）时，唯一有意义的
  // 下一步是让它把话说完；此时给固定套话就是用户抱怨的「建议不按上下文」。
  const trimmed = content.trim();
  if (trimmed.length < 60 || /(?:我先|让我先|我接下来|接下来|准备|正在|先读取|先查看|先检查)[^。！？]*[。！]?$/.test(trimmed)) {
    return isEnglish ? ['Continue', 'Give me the conclusion directly'] : ['继续说下去', '直接给出结论'];
  }

  // 上下文感知：根据流程/对话当前状态给方向，而不是固定三条
  if (/blocked_env|环境缺失|环境未就绪|缺少环境/.test(context)) {
    return isEnglish
      ? ['Deploy the missing environment first', 'Show the missing items', 'Continue the workflow after deploy']
      : ['一键部署缺失环境', '查看缺失清单', '环境装好后继续流程'];
  }
  if (/死循环|没有新进展|安全上限|已明确暂停|waiting_user|等待用户/.test(context)) {
    return isEnglish
      ? ['Continue the workflow from this step', 'Show the current step details', 'Try a different approach for this step']
      : ['继续执行流程', '查看当前步骤详情', '换个思路处理当前步骤'];
  }
  if (/waiting_jobs|已提交.*作业|job .* submitted|作业完成后/.test(context)) {
    return isEnglish
      ? ['Check the job status', 'Continue when the job finishes']
      : ['查看作业真实状态', '作业完成后继续流程'];
  }
  if (/失败|错误|异常|error|failed|exception|exit/.test(text)) {
    return isEnglish
      ? ['Recommended: diagnose the root cause', 'Show a safe fix', 'Resume the workflow after fixing']
      : ['推荐：定位失败根因', '给出安全修复方案', '修复后继续流程'];
  }
  if (/完成|成功|已生成|done|completed|success/.test(text)) {
    return isEnglish
      ? ['Recommended: verify the result', 'Show the key output files', 'Turn this into a reusable workflow']
      : ['推荐：验证结果是否完整', '查看关键输出文件', '整理成可复用流程'];
  }
  if (/确认|选择|是否|which|choose|confirm/.test(text)) {
    return isEnglish
      ? ['Recommended: continue with your recommendation', 'Compare the options first', 'Let me add more details']
      : ['推荐：按你的建议继续', '先比较各选项差异', '我再补充一些信息'];
  }
  if (/流程|workflow/.test(context) && /running|运行中|执行中/.test(context)) {
    return isEnglish
      ? ['Continue the workflow', 'Show current progress']
      : ['继续执行流程', '查看当前进度'];
  }
  // 没有可识别的上下文时不显示建议，而不是给三条固定套话（用户实测反馈：
  // 固定建议不贴上下文，点了反而误导）。
  return [];
}

//  Message Bubble 
// React.memo：流式期间每个 token 都触发 AIChat 整体重渲染；消息列表不可变追加、msg 引用稳定，
// memo 后历史气泡跳过渲染体内的 thought 正则、extractOutputFiles 与逐行 split 等重计算
const MessageBubble = React.memo(function MessageBubble({ msg, index, sessionId, workspace, workflowRunDir, remoteBasePaths, onOpenWebPanel, expandDetails = false }: { msg: Message; index: number; sessionId?: string | null; workspace?: string; workflowRunDir?: string | null; remoteBasePaths?: string[]; onOpenWebPanel?: (request: WebPanelRequest) => void; expandDetails?: boolean }) {
  const { isEnglish } = useI18n();
  const [thoughtExpanded, setThoughtExpanded] = useState(false);
  useEffect(() => setThoughtExpanded(expandDetails), [expandDetails]);

  // Parse thought steps
  const thoughtRegex = /<thought>([\s\S]*?)<\/thought>/g;
  const thoughts: string[] = [];
  let match;
  while ((match = thoughtRegex.exec(msg.content)) !== null) {
    thoughts.push(match[1].trim());
  }
  for (const step of msg.thoughtSteps || []) {
    if (step.content.trim() && !thoughts.includes(step.content.trim())) thoughts.push(step.content.trim());
  }
  const cleanContent = msg.content.replace(/<thought>[\s\S]*?<\/thought>/g, '').trim();
  const outputFiles = extractOutputFiles(msg.content);
  // validate_dsh_ui 的 UI spec JSON：从正文剥离改渲染为卡片（仅 assistant 答复），
  // 剥离后的文本也喂给路径卡片，避免 spec 内嵌路径被重复渲染
  const dshUi = msg.role === 'assistant' ? extractDshUiSpecs(cleanContent) : { specs: [] as const, strippedText: cleanContent };
  const markdownContent = dshUi.strippedText.trim();
  const isRemoteSession = !!sessionId && sessionId !== 'local-workbench';

  if (msg.role === 'system') {
    // Filter noisy system messages
    // 流程解绑标记（[TRACE_WORKFLOW_RUN_DETACHED]…）是协议行，不展示原始文本
    const text = stripWorkflowRunDetachedMarkers(msg.content || '');
    if (!text || !shouldRenderSystemMessage(text)) {
      return null; // Don't render noisy progress messages
    }
    if (/^\[❌ Error\]/.test(text.trim())) {
      return (
        <div role="alert" data-user-content="true" className="mx-1 mb-3 max-w-[95%] rounded-lg border border-red-500/30 bg-red-500/5 px-3 py-2 text-sm leading-6 text-red-400 whitespace-pre-wrap break-words">
          {text.replace(/^\[❌ Error\]\s*/, '')}
        </div>
      );
    }
    return (
      <div className="flex items-start mb-1.5">
        <div data-user-content="true" className="text-scholar-400 text-xs px-2 py-0.5 max-w-[95%]">
          {text}
          {/* system 通知里的图片路径同样内联出图（其余类型保持路径 + 下载） */}
          <DetectedFilesStrip files={outputFiles} role="system" sessionId={sessionId} workspace={workspace} />
        </div>
      </div>
    );
  }

  return (
    <div className={`flex flex-col mb-3 ${msg.role === 'user' ? 'items-end' : 'items-start'}`}>
      <div data-message-bubble={msg.role} className={`p-2.5 rounded-lg max-w-[95%] ${
        msg.role === 'user'
          ? 'bg-accent/10 text-scholar-100 border border-accent/20'
          : 'bg-scholar-800 text-scholar-100 border border-scholar-700/60'
      }`}>
        {/* Thought chain visualization */}
        {thoughts.length > 0 && (
          <div className="mb-2 rounded-lg border border-scholar-700/70 bg-scholar-950/30 px-2.5 py-2">
            <button
              onClick={() => setThoughtExpanded(!thoughtExpanded)}
              className="flex w-full items-center gap-1.5 text-left text-[11px] text-scholar-400 hover:text-scholar-200"
            >
              {thoughtExpanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
              <span>{isEnglish ? 'Reasoning details' : '思考过程'}</span>
              <span className="text-scholar-500">{isEnglish ? `· ${thoughts.length} ${thoughts.length === 1 ? 'step' : 'steps'}` : `· ${thoughts.length} 步`}</span>
            </button>
            <AnimatePresence>
              {thoughtExpanded && (
                <motion.div
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: 'auto', opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  className="overflow-hidden"
                >
                  {thoughts.map((t, i) => (
                    <div key={i} className="mt-2 bg-scholar-900/60 border border-scholar-600/50 rounded p-2 text-[11px] text-scholar-300">
                      <div className="text-[10px] text-accent-dark/70 mb-0.5 font-medium">Step {i + 1}</div>
                      <div data-user-content="true" className="whitespace-pre-wrap break-words">{t}</div>
                    </div>
                  ))}
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        )}

        {/* Clean content */}
        {markdownContent && <div data-user-content="true"><MarkdownMessage content={markdownContent} onOpenWebPanel={onOpenWebPanel} sessionId={sessionId} workspace={workspace} /></div>}

        {/* validate_dsh_ui 的 UI spec 卡片 */}
        {dshUi.specs.length > 0 && (
          <div data-user-content="true">
            {dshUi.specs.map((spec, i) => (
              <DshUiSpecCard key={i} spec={spec} sessionId={isRemoteSession ? sessionId : undefined} local={!isRemoteSession} workspace={workspace} />
            ))}
          </div>
        )}

            {/* RichContent cards: auto-detect and display file outputs */}
            {msg.role === 'assistant' && (
              <div data-user-content="true">
                <RichContentMessage className="mt-2" sessionId={sessionId} workspace={workspace} pathBase={workflowRunDir} remoteBasePaths={remoteBasePaths} onOpenWebPanel={onOpenWebPanel}>
                  {dshUi.strippedText}
                </RichContentMessage>
              </div>
            )}

            {/* 网页内嵌预览：答复中的 http(s) 链接出可折叠预览卡（默认收起，不自动加载外网） */}
            {msg.role === 'assistant' && (
              <WebEmbedList text={dshUi.strippedText} onOpenWebPanel={onOpenWebPanel} />
            )}

        {/* Detected files：图片路径内联出图，其余路径文本 + 下载 */}
        <DetectedFilesStrip files={outputFiles} role={msg.role} sessionId={sessionId} workspace={workspace} />
      </div>
    </div>
  );
});

//  AI 配置表单字段（设置面板与首次配置共用，消除重复）
function AIProfileFields({
  datalistId, aiProvider, aiApiKey, aiModel, aiBaseUrl,
  onProviderChange, onApiKeyChange, onModelChange, onBaseUrlChange,
  apiKeyRequired = false,
}: {
  datalistId: string;
  aiProvider: AIProvider;
  aiApiKey: string;
  aiModel: string;
  aiBaseUrl: string;
  onProviderChange: (p: AIProvider) => void;
  onApiKeyChange: (v: string) => void;
  onModelChange: (v: string) => void;
  onBaseUrlChange: (v: string) => void;
  apiKeyRequired?: boolean;
}) {
  const fieldClass = "w-full bg-scholar-950 border border-scholar-600 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent/50 focus:border-accent";
  return (
    <>
      <div>
        <label className="block text-xs text-scholar-300 mb-1">AI 服务商</label>
        <select
          value={aiProvider}
          onChange={e => onProviderChange(e.target.value as AIProvider)}
          className={fieldClass}
        >
          <option value="deepseek">DeepSeek</option>
          <option value="openai">ChatGPT (OpenAI)</option>
          <option value="gemini">Gemini (Google)</option>
          <option value="grok">Grok (xAI)</option>
          <option value="moonshot">Moonshot/Kimi</option>
          <option value="custom-openai">Custom OpenAI-compatible</option>
        </select>
      </div>
      <div>
        <label className="block text-xs text-scholar-300 mb-1">API Key</label>
        <input
          type="password" required={apiKeyRequired} value={aiApiKey}
          onChange={e => onApiKeyChange(e.target.value)}
          className={fieldClass}
        />
      </div>
      <div>
        <label className="block text-xs text-scholar-300 mb-1">模型</label>
        <input
          list={datalistId}
          value={aiModel}
          onChange={e => onModelChange(e.target.value)}
          className={fieldClass}
        />
        <datalist id={datalistId}>
          {(PROVIDERS[aiProvider] || []).map(m => (
            <option key={m} value={m} />
          ))}
        </datalist>
      </div>
      {(aiProvider === 'custom-openai' || aiBaseUrl) && (
        <div>
          <label className="block text-xs text-scholar-300 mb-1">Base URL</label>
          <input
            value={aiBaseUrl}
            onChange={e => onBaseUrlChange(e.target.value)}
            placeholder="https://api.example.com/v1"
            className={fieldClass}
          />
        </div>
      )}
    </>
  );
}

function AgentSettingsFields({
  engine,
  onEngineChange,
  planningPolicy,
  confirmationPolicy,
  pathPolicy,
  maxCommands,
  maxSteps,
  planReview,
  onPlanningPolicyChange,
  onConfirmationPolicyChange,
  onPathPolicyChange,
  onMaxCommandsChange,
  onMaxStepsChange,
  onPlanReviewChange,
}: {
  engine: AgentEnginePreference;
  onEngineChange: (value: AgentEnginePreference) => void;
  planningPolicy: AgentPlanningPolicy;
  confirmationPolicy: AgentConfirmationPolicy;
  pathPolicy: AgentPathPolicy;
  maxCommands: number;
  maxSteps: number;
  planReview: AgentPlanReviewPolicy;
  onPlanningPolicyChange: (value: AgentPlanningPolicy) => void;
  onConfirmationPolicyChange: (value: AgentConfirmationPolicy) => void;
  onPathPolicyChange: (value: AgentPathPolicy) => void;
  onMaxCommandsChange: (value: number) => void;
  onMaxStepsChange: (value: number) => void;
  onPlanReviewChange: (value: AgentPlanReviewPolicy) => void;
}) {
  const fieldClass = 'w-full bg-scholar-950 border border-scholar-600 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent/50 focus:border-accent';
  return (
    <div className="space-y-3 border-t border-scholar-700 pt-3">
      <div className="text-xs font-medium text-scholar-200">Agent 执行策略</div>
      <div>
        <label className="block text-xs text-scholar-300 mb-1">智能体引擎</label>
        {IS_COMPETITION_EDITION || isPublicWeb() ? (
          <div className={`${fieldClass} text-scholar-300`}>原生智能体{isPublicWeb() ? '（集群执行）' : '（竞赛版固定）'}</div>
        ) : (
          <select value={engine} onChange={e => onEngineChange(e.target.value as AgentEnginePreference)} className={fieldClass}>
            <option value="auto">智能选择（推荐）</option>
            <option value="native">TRACE 原生智能体</option>
            <option value="dsh">DSH 智能体</option>
          </select>
        )}
        <p className="mt-1 text-[10px] text-scholar-500">
          {isPublicWeb() ? '网页端只在当前用户连接的集群上执行命令，不提供部署服务器本地工具。' : IS_COMPETITION_EDITION
            ? '竞赛版仅移除 DSH，固定使用 TRACE 原生智能体；流程功能完整保留。'
            : 'DSH 当前用于 DeepSeek 普通 Agent 任务；正式流程自动使用原生引擎，以保留断点、证据和作业监控。'}
        </p>
      </div>
      <div>
        <label className="block text-xs text-scholar-300 mb-1">规划方式</label>
        <select value={planningPolicy} onChange={e => onPlanningPolicyChange(e.target.value as AgentPlanningPolicy)} className={fieldClass}>
          <option value="auto">智能判断（推荐）</option>
          <option value="always">所有任务先规划</option>
        </select>
      </div>
      <div>
        <label className="block text-xs text-scholar-300 mb-1">计划审批</label>
        <select value={planReview} onChange={e => onPlanReviewChange(e.target.value as AgentPlanReviewPolicy)} className={fieldClass}>
          <option value="auto">较大或含写操作的计划（推荐）</option>
          <option value="always">所有计划都先审批</option>
        </select>
        <p className="mt-1 text-[10px] text-scholar-500">Agent 制定的执行计划先给你过目：可原样批准、修改步骤后批准或取消；批准后才动手。仅普通对话生效，正式流程按其自身步骤执行。</p>
      </div>
      <div>
        <label className="block text-xs text-scholar-300 mb-1">集群路径权限</label>
        <select value={pathPolicy} onChange={e => onPathPolicyChange(e.target.value as AgentPathPolicy)} className={fieldClass}>
          <option value="full_access">全部路径 / 多路径（高风险）</option>
          <option value="scoped">仅流程与明确指定路径（推荐）</option>
        </select>
        <p className="mt-1 text-[10px] text-scholar-500">全部路径模式允许 AI 在同一任务中切换、复制和处理 SSH 账号可访问的多个目录。</p>
      </div>
      <div>
        <label className="block text-xs text-scholar-300 mb-1">执行前确认</label>
        <select value={confirmationPolicy} onChange={e => onConfirmationPolicyChange(e.target.value as AgentConfirmationPolicy)} className={fieldClass}>
          <option value="dangerous">仅高风险操作（推荐）</option>
          <option value="never">自动执行（终止作业仍需确认）</option>
          <option value="state_changes">写入、联网、提交作业都确认</option>
          <option value="every_command">每条命令都确认</option>
        </select>
      </div>
      <div>
        <label className="block text-xs text-scholar-300 mb-1">单次最多命令数（{MIN_AGENT_COMMANDS}–{MAX_AGENT_COMMANDS}）</label>
        <input type="number" min={MIN_AGENT_COMMANDS} max={MAX_AGENT_COMMANDS} value={maxCommands} onChange={e => onMaxCommandsChange(Number(e.target.value))} className={fieldClass} />
      </div>
      <div>
        <label className="block text-xs text-scholar-300 mb-1">单次最多 Agent 步骤（{MIN_AGENT_STEPS}–{MAX_AGENT_STEPS}）</label>
        <input type="number" min={MIN_AGENT_STEPS} max={MAX_AGENT_STEPS} value={maxSteps} onChange={e => onMaxStepsChange(Number(e.target.value))} className={fieldClass} />
        <p className="mt-1 text-[10px] text-scholar-500">达到上限时会暂停当前任务，不会删除对话；已保存流程会自动使用 200 步执行档，通常可一轮跑完整个流程。</p>
      </div>
    </div>
  );
}

// 
// AIChat Component
// 
export default function AIChat({ isOpen, executeCommand, socket, sessionId, onSkillsChange, messages, onMessagesChange, onNewChat, triggerAI, activeConversationId, conversationContextId, loadingConversationId, onSaveToCluster, aiClusterControl, conversationSummary, onPickRemoteFolder, onOpenRemoteFolder, workspaceLayout = false, workspaceTargetLabel, workspaceTargetConnected = false, onOpenComputeBackend, jobStatusBar, onOpenWebPanel, onStartWorkflowRun, onEnsureConversation }: AIChatProps) {
  const { locale, isEnglish, t } = useI18n();
  // AI Config
  // 惰性初始化：localStorage 同步读取 + JSON.parse 仅在挂载时执行一次；
  // 此前每次渲染（含流式每个 token）都重复解析，且 isOpen=false 提前返回在 hooks 之后，所有标签页实例都承担这份开销
  const [initialProfile] = useState(() => loadAIProfile(sessionId));
  const [aiProvider, setAiProvider] = useState(initialProfile.provider);
  const [aiApiKey, setAiApiKey] = useState(initialProfile.apiKey);
  const [aiModel, setAiModel] = useState(initialProfile.model);
  const [aiBaseUrl, setAiBaseUrl] = useState(initialProfile.baseUrl || '');
  const [initialAgentSettings] = useState(() => loadAgentSettings());
  const [agentEngine, setAgentEngine] = useState<AgentEnginePreference>(
    IS_COMPETITION_EDITION ? 'native' : initialAgentSettings.engine,
  );
  const [agentPlanningPolicy, setAgentPlanningPolicy] = useState<AgentPlanningPolicy>(initialAgentSettings.planningPolicy);
  const [agentConfirmationPolicy, setAgentConfirmationPolicy] = useState<AgentConfirmationPolicy>(initialAgentSettings.confirmationPolicy);
  const [agentPathPolicy, setAgentPathPolicy] = useState<AgentPathPolicy>(initialAgentSettings.pathPolicy);
  const [agentMaxCommands, setAgentMaxCommands] = useState(initialAgentSettings.maxCommands);
  const [agentMaxSteps, setAgentMaxSteps] = useState(initialAgentSettings.maxSteps);
  const [agentPlanReview, setAgentPlanReview] = useState<AgentPlanReviewPolicy>(initialAgentSettings.planReview);
  const [isAiSetup, setIsAiSetup] = useState(!!initialProfile.apiKey);
  const [showSettings, setShowSettings] = useState(false);

  const [inputValue, setInputValue] = useState('');

  // Ref to track latest messages for use in async closures
  const messagesRef = useRef(messages);
  messagesRef.current = messages; // Immediate sync (not useEffect - too slow for rapid updates)

  const addMessage = useCallback((msg: Message) => {
    messagesRef.current = [...messagesRef.current, msg];
    onMessagesChange(messagesRef.current);
  }, [onMessagesChange]);

  const addMessages = useCallback((msgs: Message[]) => {
    messagesRef.current = [...messagesRef.current, ...msgs];
    onMessagesChange(messagesRef.current);
  }, [onMessagesChange]);
  const [isAiLoading, setIsAiLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  // Agent 本地工作区：dsh 引擎本地工具的落点目录（随 agent 请求体发给服务端）
  const [agentWorkspaces, setAgentWorkspaces] = useState<string[]>(() => loadAgentWorkspaces());
  const agentWorkspace = agentWorkspaces[0] || '';
  const [workspaceError, setWorkspaceError] = useState('');

  const handlePickAgentWorkspace = useCallback(async () => {
    const desktop = window.traceDesktop;
    if (!desktop?.dialog || !desktop.localFiles) return;
    try {
      const picked = await desktop.dialog.pickDirectory();
      if (!picked) return; // 用户取消
      const stat = await desktop.localFiles.stat(picked);
      if (stat.kind !== 'directory') throw new Error('not a directory');
      setWorkspaceError('');
      setAgentWorkspaces(saveAgentWorkspaces([...agentWorkspaces, picked]));
    } catch {
      setWorkspaceError(t('所选路径不是有效文件夹'));
    }
  }, [agentWorkspaces, t]);

  const handleClearAgentWorkspace = useCallback(() => {
    clearAgentWorkspace();
    setAgentWorkspaces([]);
    setWorkspaceError('');
  }, []);

  const handleRemoveAgentWorkspace = useCallback((workspace: string) => {
    const next = agentWorkspaces.filter(item => item !== workspace);
    if (next.length > 0) setAgentWorkspaces(saveAgentWorkspaces(next));
    else {
      clearAgentWorkspace();
      setAgentWorkspaces([]);
    }
  }, [agentWorkspaces]);

  // 纯 Web 开发环境没有桌面目录选择器，也无法校验路径，blur 时原样保存
  const handleWorkspaceInputBlur = useCallback((value: string) => {
    const trimmed = value.trim();
    if (trimmed) {
      const added = trimmed.split(/[;\n]+/).map(item => item.trim()).filter(Boolean);
      setAgentWorkspaces(saveAgentWorkspaces([...agentWorkspaces, ...added]));
    } else {
      setAgentWorkspaces(agentWorkspaces);
    }
    setWorkspaceError('');
  }, [agentWorkspaces]);

  //  对话附件：仅保存路径引用，发送时把路径追加进消息文本 
  const attachmentInputRef = useRef<HTMLInputElement>(null);
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [attachmentError, setAttachmentError] = useState('');
  const [attachmentBusy, setAttachmentBusy] = useState(false);
  const isClusterChat = !!sessionId && sessionId !== 'local-workbench';

  const handleAttachClick = useCallback(() => {
    setAttachmentError('');
    if (isPublicWeb() && isClusterChat) { attachmentInputRef.current?.click(); return; }
    if (!window.traceDesktop?.getPathForFile || !window.traceDesktop.localFiles) {
      setAttachmentError(t('附件功能需要桌面端支持，浏览器模式无法获取文件路径'));
      return;
    }
    if (!isClusterChat && !agentWorkspace.trim()) {
      setAttachmentError(t('请先选择工作文件夹，再添加附件'));
      return;
    }
    attachmentInputRef.current?.click();
  }, [t, isClusterChat, agentWorkspace]);

  const handleAttachmentFiles = useCallback(async (files: FileList | null) => {
    const desktop = window.traceDesktop;
    if (!files || files.length === 0 || (!isPublicWeb() && (!desktop?.getPathForFile || !desktop.localFiles))) return;
    setAttachmentBusy(true);
    setAttachmentError('');
    try {
      for (const file of Array.from(files)) {
        if (isPublicWeb() && sessionId) {
          const state = await fetch('/api/public/session', { headers: { 'X-SSH-Session-Id': sessionId } }).then(response => response.json());
          const home = state.home;
          if (!home?.startsWith('/')) throw new Error('无法确定当前集群的用户目录');
          const directory = `${home.replace(/\/$/, '')}/${CLUSTER_ATTACHMENT_DIR}`;
          const directoryExists = await fetch(`/api/remote/stat?path=${encodeURIComponent(directory)}`, { headers: { 'X-SSH-Session-Id': sessionId } });
          if (!directoryExists.ok) await mkdirRemote(sessionId, directory);
          const remotePath = `${directory}/${uuidv4()}-${file.name}`;
          const response = await fetch(`/api/public/upload?path=${encodeURIComponent(remotePath)}`, {
            method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-SSH-Session-Id': sessionId }, body: file,
          });
          const result = await response.json();
          if (!response.ok || !result.success) throw new Error(result.error || '附件上传失败');
          setAttachments(previous => [...previous, { id: uuidv4(), name: file.name, refPath: remotePath }]);
          continue;
        }
        const localPath = desktop.getPathForFile(file);
        if (!localPath) throw new Error('empty file path');
        const name = file.name || baseName(localPath) || 'attachment';
        if (isClusterChat && sessionId) {
          // 集群模式：固定上传到 ~/trace_uploads/（SFTP 相对路径即家目录），走传输队列可见进度
          try { await mkdirRemote(sessionId, CLUSTER_ATTACHMENT_DIR); } catch { /* 已存在则忽略 */ }
          const remotePath = `${CLUSTER_ATTACHMENT_DIR}/${name}`;
          await enqueueTransfer(sessionId, {
            profileId: resolveTransferProfileId({ sessionId }),
            sessionId,
            direction: 'upload' as const,
            localPath,
            remotePath,
            temporaryPath: makeTemporaryTransferName(remotePath, uuidv4(), 'remote'),
            totalBytes: file.size,
            transferredBytes: 0,
            conflictPolicy: 'overwrite' as const,
            verificationMode: 'size' as const,
            retryCount: 0,
          });
          setAttachments(prev => [...prev, { id: uuidv4(), name, refPath: `~/${remotePath}` }]);
        } else {
          // 本地模式：复制进工作区 attachments/ 子目录（copy 内部重名自动加序号，不覆盖）
          const workspace = agentWorkspace.trim();
          const attachDir = joinLocalPath(workspace, 'attachments');
          await desktop.localFiles.mkdir(attachDir);
          const copied = await desktop.localFiles.copy([localPath], attachDir);
          const destName = baseName(copied.paths[0] || '') || name;
          setAttachments(prev => [...prev, { id: uuidv4(), name: destName, refPath: `attachments/${destName}` }]);
        }
      }
    } catch (error: any) {
      setAttachmentError(`${t('附件添加失败')}：${error?.message || String(error)}`);
    } finally {
      setAttachmentBusy(false);
    }
  }, [t, isClusterChat, sessionId, agentWorkspace]);

  const removeAttachment = useCallback((id: string) => {
    setAttachments(prev => prev.filter(item => item.id !== id));
  }, []);
  const { log } = useObservationLogger();
  // 把本地 AI 配置同步到服务端共享（QQ 机器人等服务端功能直接复用同一份配置）
  const pushAiProfileToServer = useCallback((profile: { provider: string; model: string; apiKey: string; baseUrl?: string }) => {
    if (!profile.apiKey) return;
    void fetch('/api/ai-profile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(isPublicWeb() && sessionId ? { 'X-SSH-Session-Id': sessionId } : {}) },
      body: JSON.stringify({ profile }),
    }).then(async response => {
      if (isPublicWeb() && !response.ok) throw new Error((await response.json()).error || 'AI 配置未保存到集群');
    }).catch(error => { if (isPublicWeb()) setErrorMessage(error.message || 'AI 配置未保存到集群'); });
  }, [sessionId]);
  const persistAiProfile = useCallback(() => {
    const saved = saveAIProfile({
      provider: aiProvider,
      model: aiModel,
      apiKey: aiApiKey,
      baseUrl: aiBaseUrl,
    }, sessionId);
    setAiProvider(saved.provider);
    setAiModel(saved.model);
    setAiApiKey(saved.apiKey);
    setAiBaseUrl(saved.baseUrl || '');
    setIsAiSetup(!!saved.apiKey);
    const agentSettings = saveAgentSettings({
      engine: IS_COMPETITION_EDITION ? 'native' : agentEngine,
      planningPolicy: agentPlanningPolicy,
      confirmationPolicy: agentConfirmationPolicy,
      pathPolicy: agentPathPolicy,
      maxCommands: agentMaxCommands,
      maxSteps: agentMaxSteps,
      planReview: agentPlanReview,
    });
    setAgentEngine(agentSettings.engine);
    setAgentPlanningPolicy(agentSettings.planningPolicy);
    setAgentConfirmationPolicy(agentSettings.confirmationPolicy);
    setAgentPathPolicy(agentSettings.pathPolicy);
    setAgentMaxCommands(agentSettings.maxCommands);
    setAgentMaxSteps(agentSettings.maxSteps);
    setAgentPlanReview(agentSettings.planReview);
    pushAiProfileToServer(saved);
  }, [aiProvider, aiModel, aiApiKey, aiBaseUrl, agentEngine, agentPlanningPolicy, agentConfirmationPolicy, agentPathPolicy, agentMaxCommands, agentMaxSteps, agentPlanReview, pushAiProfileToServer]);

  // 启动时同步一次已有配置，保证服务端（QQ 机器人）开箱即用
  useEffect(() => {
    const p = loadAIProfile(sessionId);
    if (p.apiKey) pushAiProfileToServer(p);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  // Streaming state
  const [streamingReasoning, setStreamingReasoning] = useState('');
  const [streamingContent, setStreamingContent] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const [aiStatus, setAiStatus] = useState('AI 正在准备…');
  const abortRef = useRef<AbortController | null>(null);
  const agentReaderRef = useRef<ReadableStreamDefaultReader<Uint8Array> | null>(null);
  const aiRunIdRef = useRef(0);
  const aiRunningRef = useRef(false); // ref guard — avoids stale isAiLoading races
  const aiRequestIdRef = useRef(''); // 服务端在 SSE 事件里下发的 requestId，用于后台运行管理
  const stoppedByUserRef = useRef(false); // distinguish user stop from timeout abort
  const lastUserTextRef = useRef(''); // 最近一次提交的用户输入，断流重试用
  const agentPlanRef = useRef<any>(null); // ask_user/断线后的跨轮结构化计划
  // 任务清单面板用的 React 状态镜像（ref 变更不触发渲染，面板需要随计划事件刷新）
  const [agentPlan, setAgentPlan] = useState<any>(null);
  const agentPlanConversationRef = useRef<string | null | undefined>(activeConversationId);
  const persistAgentPlan = useCallback((plan: any | null) => {
    agentPlanRef.current = plan || null;
    setAgentPlan(plan || null);
    messagesRef.current = upsertAgentPlanCheckpoint(messagesRef.current, plan || null) as Message[];
    onMessagesChange(messagesRef.current);
  }, [onMessagesChange]);
  // 中途插话提示：发送后置上，steer_applied / 轮末 / 停止时更新或清除
  const [steerNotice, setSteerNotice] = useState('');
  const lastTriggerRef = useRef({
    agent: triggerAI && sessionId && triggerAI.tabId === sessionId ? triggerAI.count : 0,
  });

  // Skills
  const [skills, setSkills] = useState<Skill[]>([]);
  const [activeTab, setActiveTab] = useState<'chat' | 'skills' | 'workflows'>('chat');
  // 流程可视化运行面板当前打开的流程
  const [runnerWorkflow, setRunnerWorkflow] = useState<Workflow | null>(null);
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  // 聊天输入关键词匹配到的流程
  const [wfMatches, setWfMatches] = useState<(Workflow & { score: number })[]>([]);

  //  Command Confirmation Gates 
  type ConfirmMode = 'ask' | 'trust_all';
  // 信任状态跨轮次、跨重启保留：用户点一次"信任全部"后不再逐条弹确认，
  // 直到在输入区上方主动取消（此前每轮开头强制重置为 ask，信任等于无效）。
  const CONFIRM_MODE_KEY = 'trace-confirm-mode';
  const [confirmMode, setConfirmMode] = useState<ConfirmMode>(() => {
    try { return (isPublicWeb() ? readPublicPreference(CONFIRM_MODE_KEY) : localStorage.getItem(CONFIRM_MODE_KEY)) === 'trust_all' ? 'trust_all' : 'ask'; }
    catch { return 'ask'; }
  });
  // SSE 事件循环读 ref 而不是 state：React 闭包在流式循环运行期间不会更新，
  // 点"信任全部"必须当轮立即生效（旧实现读 state 快照，信任从来不生效）。
  const confirmModeRef = useRef<ConfirmMode>(confirmMode);
  const applyConfirmMode = useCallback((mode: ConfirmMode) => {
    confirmModeRef.current = mode;
    setConfirmMode(mode);
    try { if (isPublicWeb()) savePublicPreference(CONFIRM_MODE_KEY, mode); else localStorage.setItem(CONFIRM_MODE_KEY, mode); } catch { /* 隐私模式下忽略 */ }
  }, []);
  const [currentCwd, setCurrentCwd] = useState<string>('');
  const commandApprovals = useCommandApprovals({ english: isEnglish,
    trusted: () => confirmModeRef.current === 'trust_all', onTrust: () => applyConfirmMode('trust_all') });
  const pendingCommand = commandApprovals.pending?.command;
  const currentPwdRef = useRef<string>('');
  const pendingCommandDirWarning = pendingCommand ? checkDirBoundary(pendingCommand) : false;
  const userQuestions = useUserQuestions({ english: isEnglish,
    onAnswered: text => addMessage({ role: 'user', content: text }),
    onLegacyAnswer: async text => { await submitToAI(text, { appendUserMessage: true }); } });
  const pendingAsk = userQuestions.pending;
  const [deferredQuestionKey, setDeferredQuestionKey] = useState('');
  const planReviews = usePlanReviews({ english: isEnglish });
  const pendingPlanReview = planReviews.pending;

  function checkDirBoundary(cmd: string): boolean {
    // Check if command accesses paths outside common safe locations
    const paths = cmd.match(/[\s'"](\/(?!tmp|share|dev|proc|sys)[\w.-]+(?:\/[\w.-]*)*)/g) || [];
    const pwd = currentPwdRef.current;
    if (!pwd) return false;
    for (const p of paths) {
      const clean = p.trim().replace(/^['"]|['"]$/g, '');
      if (clean.startsWith(pwd)) continue;
      if (clean.startsWith('/tmp') || clean.startsWith('/share') || clean.startsWith('/dev')) continue;
      return true;
    }
    return false;
  }

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  // 用户是否贴在底部附近（阈值 80px）：上翻阅读时置 false，流式追加不再打断阅读
  const stickToBottomRef = useRef(true);
  // 渲染态镜像(ref 不触发重渲染):"回到底部"悬浮按钮的显隐依据
  const [atBottom, setAtBottom] = useState(true);
  const handleMessagesScroll = () => {
    const el = messagesContainerRef.current;
    if (!el) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    stickToBottomRef.current = near;
    setAtBottom(near);
  };
  // 直接滚动消息容器：scrollIntoView 会滚动所有可滚动祖先，与浏览器滚动锚定拉扯导致列表闪烁。
  // 容器 CSS 已加 overflow-anchor:none，贴底判定由 stickToBottomRef 负责。
  const scrollToBottom = () => {
    const el = messagesContainerRef.current;
    if (el && stickToBottomRef.current) el.scrollTop = el.scrollHeight;
  };
  const jumpToBottom = () => {
    const el = messagesContainerRef.current;
    if (!el) return;
    stickToBottomRef.current = true;
    el.scrollTop = el.scrollHeight;
    setAtBottom(true);
  };
  useEffect(() => { scrollToBottom(); }, [messages, streamingContent, isStreaming]);
  // 技能库/流程页切回对话时消息容器重建（scrollTop 归零），恢复贴底位置
  useEffect(() => { if (activeTab === 'chat') scrollToBottom(); }, [activeTab]);
  // 消息区内图片/HTML 卡片异步加载会撑高内容把视口顶到中间:
  // 任何子资源加载完成时,只要用户原本贴在底部就重新贴底(不影响上翻阅读的人)。
  const handleContentLoad = () => {
    if (stickToBottomRef.current) {
      const el = messagesContainerRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    }
  };

  // Only a real conversation switch clears interactions. Adding the question to
  // messages must NOT immediately erase the answer controls (v0.4.47 regression).
  useEffect(() => {
    const previous = agentPlanConversationRef.current;
    // 新对话首次保存会从 null 获得 id，此时保留正在运行的计划；真正切换会话时清理。
    if (previous != null && previous !== activeConversationId) {
      // Detach the old view, not the cluster job or server-side Agent run.
      aiRunIdRef.current++;
      aiRunningRef.current = false;
      aiRequestIdRef.current = '';
      const oldReader = agentReaderRef.current;
      agentReaderRef.current = null;
      if (oldReader) void closeSseReader(oldReader, 'stale-run');
      setIsAiLoading(false);
      setIsStreaming(false);
      setStreamingContent('');
      agentPlanRef.current = null;
      setAgentPlan(null);
      commandApprovals.clear();
      userQuestions.clear();
      planReviews.clear();
      setSteerNotice('');
      setDeferredQuestionKey('');
      stickToBottomRef.current = true;
    }
    agentPlanConversationRef.current = activeConversationId;
  }, [activeConversationId]);

  // 打开/切换对话后多次贴底:消息是异步拉取填充的,图片与 HTML 卡片还会继续
  // 撑高,单次贴底会被顶回中间(用户实测"点开记录停在中间")。50/250/800ms
  // 三个时点兜底,配合 onLoadCapture 的增量贴底。
  useEffect(() => {
    if (!activeConversationId) return;
    const timers = [50, 250, 800].map(ms => setTimeout(() => {
      const el = messagesContainerRef.current;
      if (el && stickToBottomRef.current) el.scrollTop = el.scrollHeight;
    }, ms));
    return () => { for (const timer of timers) clearTimeout(timer); };
  }, [activeConversationId]);

  useEffect(() => {
    const savedPlan = findLatestAgentPlanCheckpoint(messages);
    if (savedPlan) { agentPlanRef.current = savedPlan; setAgentPlan(savedPlan); }
    else if (!aiRunningRef.current) { agentPlanRef.current = null; setAgentPlan(null); }
  }, [messages]);

  // 组件卸载（切换对话/计算目标/视图触发重挂载）时只安静断开连接：
  // 服务端会把带 conversationId 的运行转为后台 detached 继续执行，
  // 终态自动回写对话存档；回到该对话时由 attach 机制接续显示。
  useEffect(() => {
    return () => {
      aiRunIdRef.current++;
      aiRunningRef.current = false;
      if (agentReaderRef.current) {
        void closeSseReader(agentReaderRef.current, 'stale-run');
        agentReaderRef.current = null;
      }
    };
  }, []);

  // Manual save-to-cluster button handler
  const handleSaveToClusterClick = async () => {
    if (!onSaveToCluster) return;
    setSaveState('saving');
    try {
      await onSaveToCluster();
      setSaveState('saved');
      setTimeout(() => setSaveState('idle'), 2500);
    } catch {
      setSaveState('error');
      setTimeout(() => setSaveState('idle'), 3000);
    }
  };

  // Load skills
  const loadSkills = useCallback(async () => {
    try {
      const res = await fetch('/api/skills', {
        headers: sessionId ? { 'X-SSH-Session-Id': sessionId } : {},
      });
      const data = await res.json();
      if (data.success) setSkills(data.skills);
    } catch (e) { console.error(e); }
  }, [sessionId]);

  useEffect(() => { loadSkills(); }, [loadSkills]);
  useEffect(() => { onSkillsChange(); }, [skills, onSkillsChange]);

  // Monitoring
  const [isMonitoring, setIsMonitoring] = useState(false);
  const monitoringRef = useRef<{ active: boolean; timer: NodeJS.Timeout | null }>({
    active: false, timer: null
  });

  const stopMonitoring = useCallback(() => {
    setIsMonitoring(false);
    monitoringRef.current.active = false;
    if (monitoringRef.current.timer) clearTimeout(monitoringRef.current.timer);
    if (socket) socket.emit('data', '\x03');
    addMessage({ role: 'system', content: '【已中断】' });
  }, [socket]);

  const handleSaveSkill = async (filename: string, content: string) => {
    try {
      const res = await fetch('/api/skills', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename, content }),
      });
      const data = await res.json();
      if (data.success) {
        setSkills(prev => {
          const filtered = prev.filter(s => s.filename !== filename);
          return [...filtered, { filename, content }];
        });
        return true;
      }
      return false;
    } catch { return false; }
  };

  //  Intelligent Job Monitor 
  async function monitorJob(
    jobId: string,
    contextMsgs: { role: string; content: string }[],
    loopCount: { value: number },
    isTaskDone: { value: boolean },
  ): Promise<string | null> {
    addMessage({ role: 'system', content: `[ ${jobId}10]` });
    let lastStatus = '';
    const maxPolls = 48; // 10min × 48 = 8 hours max

    for (let poll = 0; poll < maxPolls; poll++) {
      // Check for abort
      if (abortRef.current?.signal.aborted) {
        addMessage({ role: 'system', content: `[ ${jobId} ]` });
        return null;
      }

      await new Promise(r => setTimeout(r, 600000)); // 10 min interval

      try {
        const statusOutput = await executeCommand(
          `bjobs -l ${jobId} 2>/dev/null | head -20; echo "---STAT---"; bjobs -noheader ${jobId} 2>/dev/null`,
          true,
        );

        // Parse status from bjobs output
        const statusMatch = statusOutput.match(/Status\s+:\s+(\w+)/i) ||
                           statusOutput.match(/^(\w+)\s+\d+/m);
        const currentStatus = statusMatch?.[1]?.trim() || 'UNKNOWN';

        if (currentStatus !== lastStatus) {
          lastStatus = currentStatus;
          addMessage({ role: 'system', content: `[ ${jobId} : ${currentStatus}]` });

          if (currentStatus === 'DONE') {
            addMessage({ role: 'system', content: `[ ${jobId} ...]` });
            // Get output
            const outLog = await executeCommand(`ls *${jobId}*.log 2>/dev/null && cat *${jobId}*.log 2>/dev/null | tail -30 || cat *.out 2>/dev/null | tail -30`, true);
            contextMsgs.push({ role: 'user', content: `<job_result jobId="${jobId}" status="DONE">\n${outLog}\n</job_result>\n` });
            return outLog;
          }

          if (currentStatus === 'EXIT') {
            const errLog = await executeCommand(`cat *${jobId}*.err 2>/dev/null | tail -20 || echo ""`, true);
            contextMsgs.push({ role: 'user', content: `<job_result jobId="${jobId}" status="EXIT">\n${errLog}\n</job_result>\n` });
            return errLog;
          }
        }
      } catch {
        // best-effort monitoring
      }
    }

    addMessage({ role: 'system', content: `[ ${jobId} 8]` });
    return null;
  }

  //  Agent Mode
  const handleAgentMode = async (userText: string, requestMessages: Message[], runId: number, signal: AbortSignal) => {
    // 必须在聊天传输裁剪前从完整消息恢复正式流程。
    const workflowRunContext = findLatestWorkflowExecutionContext(requestMessages);
    stoppedByUserRef.current = false;
    setIsStreaming(true);
    setStreamingReasoning('');
    setStreamingContent('');
    setAiStatus(workflowRunContext ? '正在恢复流程进度…' : '正在连接 TRACE Agent…');

    // 后台运行（detached）要凭 conversationId 回写对话存档：新对话先落库拿 id 再发请求，
    // 否则用户在任务中途切走时服务端无法归属这次运行
    const ensuredConversationId = activeConversationId
      || (onEnsureConversation ? await onEnsureConversation(requestMessages).catch(() => null) : null)
      || undefined;

    let fullText = '';
    let fullReasoning = '';
    let lastPreviewUpdateAt = 0;
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    let readerCloseReason: SseReaderCloseReason = 'completed';

    let fetchTimedOut = false;
    const FETCH_TIMEOUT_MS = 930_000;
    // 与服务端 Agent 的 15 分钟硬上限对齐，多步骤任务不再被前端提前中止。
    const STREAM_IDLE_MS = 90_000; // 90s 无任何数据判定断流（服务端 15s 心跳，90s 无消息即异常）

    try {
      console.log('[AI] Agent fetch start, runId=%d, msgCount=%d', runId, requestMessages.length);
      // 正式流程上下文单独传输，不依赖最近 18 条窗口；长流程仍可读取 RUN/run.json 续跑。
      // Compress only large multi-turn conversations; small JSON bodies are
      // safer uncompressed through Apache/Baota reverse proxies.
      const reqPayload = {
        profile: { provider: aiProvider, model: aiModel, apiKey: aiApiKey, baseUrl: aiBaseUrl || undefined },
        messages: prepareMessagesForAiTransport(requestMessages).map(m => ({ role: m.role, content: m.content })),
        mode: 'agent' as const,
        showInTerminal: !!aiClusterControl,
        summary: conversationSummary || undefined,
        agentConfig: {
          engine: IS_COMPETITION_EDITION ? 'native' : agentEngine,
          planningPolicy: agentPlanningPolicy,
          confirmationPolicy: agentConfirmationPolicy,
          pathPolicy: agentPathPolicy,
          maxCommands: agentMaxCommands,
          maxSteps: agentMaxSteps,
          planReview: agentPlanReview,
        },
        resumePlan: agentPlanRef.current || undefined,
        workflowRunContext: workflowRunContext || undefined,
        locale,
        workspace: agentWorkspace || undefined,
        workspaces: agentWorkspaces.length > 0 ? agentWorkspaces : undefined,
        conversationId: ensuredConversationId,
        conversationContextId: conversationContextId || undefined,
      };
      const { body: reqBody, headers } = await prepareAiRequestBody(reqPayload);
      // 多集群标签页：显式指定本会话，避免被 cookie 里的其他会话劫持
      const reqHeaders = sessionId ? { ...headers, 'X-SSH-Session-Id': sessionId } : headers;

      // Retryable fetch — handles transient ECONNRESET due to TCP race conditions
      // between the browser's connection pool and the server's socket lifecycle.
      let response: Response | undefined;
      let lastFetchErr: any;
      for (let attempt = 0; attempt < 3; attempt++) {
        if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
        try {
          response = await fetch('/api/ai/stream', {
            method: 'POST',
            headers: reqHeaders,
            body: reqBody,
            signal,
          });
          break; // success
        } catch (err: any) {
          lastFetchErr = err;
          // Only retry on network errors (TypeError), not on AbortError or HTTP errors
          if (attempt < 2 && err.name === 'TypeError' && !signal.aborted) {
            console.log('[AI] Fetch attempt %d failed with %s, retrying…', attempt + 1, err.message || err.name);
            await new Promise(r => setTimeout(r, (attempt + 1) * 400));
            continue;
          }
          throw err;
        }
      }
      if (!response) throw lastFetchErr;

      if (!response.ok) {
        let errMsg = `HTTP ${response.status}`;
        try { const err = await response.json(); errMsg = err.error || errMsg; } catch {}
        throw new Error(errMsg);
      }

      reader = response.body!.getReader();
      agentReaderRef.current = reader;
      const decoder = new TextDecoder();
      let buffer = '';
      const fetchClock = new AgentTurnClock();

      while (true) {
        // Check user-initiated stop (handleStop increments aiRunIdRef)
        if (!isCurrentAiRun(aiRunIdRef.current, runId)) {
          readerCloseReason = 'stale-run';
          break;
        }
        // 总时长上限
        const fetchState = fetchClock.snapshot();
        if ((!fetchState.waitingHuman && fetchState.activeMs > FETCH_TIMEOUT_MS) || fetchState.wallMs > 46 * 60_000) {
          fetchTimedOut = true;
          readerCloseReason = 'timeout';
          break;
        }
        // 流空闲检测：服务端静默时 read() 会永久阻塞，90s 无数据判定断流
        let readResult: ReadableStreamReadResult<Uint8Array>;
        let readTimer: ReturnType<typeof setTimeout> | undefined;
        try {
          readResult = await Promise.race([
            reader.read(),
            new Promise<never>((_, reject) =>
              { readTimer = setTimeout(() => reject(new Error('__stream_idle__')), STREAM_IDLE_MS); }),
          ]);
        } catch (idleErr: any) {
          if (idleErr?.message === '__stream_idle__') {
            fetchTimedOut = true;
            readerCloseReason = 'timeout';
            break;
          }
          throw idleErr;
        } finally { if (readTimer) clearTimeout(readTimer); }
        const { done, value } = readResult;
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data: ')) continue;

          try {
            const event = JSON.parse(trimmed.slice(6));
            fetchClock.observe(event);
            if (typeof event.requestId === 'string' && event.requestId) aiRequestIdRef.current = event.requestId;

            switch (event.type) {
              case 'status':
                if (event.message) setAiStatus(String(event.message));
                break;
              case 'compacted': {
                // 服务端上下文自动压缩：早期消息已被摘要替换。轻提示，不改变布局。
                const compactedCount = Number(event.count) || 0;
                if (compactedCount > 0) {
                  addMessage({
                    role: 'system',
                    content: isEnglish
                      ? `[🗜️ Context compacted] ${compactedCount} earlier messages were compressed into a summary to fit the model context.`
                      : `[🗜️ 上下文压缩] 早期 ${compactedCount} 条消息已压缩为摘要，以适配模型上下文长度。`,
                  });
                }
                break;
              }
              case 'content':
                fullText += event.content;
                if (Date.now() - lastPreviewUpdateAt >= 100) {
                  lastPreviewUpdateAt = Date.now();
                  setStreamingContent(fullText);
                }
                setAiStatus('AI 正在组织结果…');
                break;
              case 'reasoning':
                fullReasoning += event.content || '';
                if (Date.now() - lastPreviewUpdateAt >= 100) {
                  lastPreviewUpdateAt = Date.now();
                  setStreamingReasoning(fullReasoning);
                }
                setAiStatus(workflowRunContext ? '流程执行器正在核对当前步骤…' : 'AI 正在推理和规划…');
                break;
              case 'tool_call':
                setAiStatus(event.name === 'run_command' ? t('AI 正在执行计算资源命令…') : (isEnglish ? `AI is using ${event.name || 'a tool'}…` : `AI 正在使用 ${event.name || '工具'}…`));
                // 保留“显示 AI 正在运行什么代码”的能力：run_command 在聊天中显示命令
                if (event.name === 'run_command') {
                  const args = typeof event.args === 'string' ? event.args : JSON.stringify(event.args);
                  const command = (event.args as { command?: string })?.command || args;
                  addMessage({ role: 'system', content: `[AI 执行命令] ${command}` });
                } else if (event.name !== 'ask_user') {
                  addMessage({
                    role: 'system',
                    content: `[🔧 ${event.name}] ${typeof event.args === 'string' ? event.args : JSON.stringify(event.args)}`,
                  });
                }
                break;
              case 'tool_result':
                // 命令类工具的输出保留在上下文但不在 UI 中直接展示
                if (event.name === 'run_command') {
                  addMessage({
                    role: 'system',
                    content: `[命令输出]\n${event.result || ''}`,
                  });
                } else if (event.name !== 'ask_user') {
                  addMessage({
                    role: 'system',
                    content: `[📋 ${event.name}] ${event.result || ''}`,
                  });
                }
                break;
              case 'step':
                // Step indicator: show for first few steps only
                if (event.step && event.step <= 3) {
                  addMessage({ role: 'system', content: `[Agent step ${event.step}]` });
                }
                break;
              case 'plan': {
                const plan = event.plan;
                persistAgentPlan(plan || null);
                const steps = Array.isArray(plan?.steps)
                  ? plan.steps.map((step: any) => `${step.id}. ${step.title}（验证：${step.verification}）`).join('\n')
                  : '';
                addMessage({ role: 'system', content: `[Agent 计划]\n目标：${plan?.goal || userText}\n${steps}` });
                break;
              }
              case 'plan_update': {
                const previousStep = Array.isArray(agentPlanRef.current?.steps)
                  ? agentPlanRef.current.steps.find((item: any) => String(item.id) === String(event.stepId))
                  : null;
                if (event.plan) persistAgentPlan(event.plan);
                const step = Array.isArray(event.plan?.steps)
                  ? event.plan.steps.find((item: any) => String(item.id) === String(event.stepId))
                  : null;
                if (step && (previousStep?.status !== step.status || step.summary !== previousStep?.summary)) {
                  const detail = step.summary ? `：${step.summary}` : '';
                  addMessage({ role: 'system', content: `[计划进度] ${step.id}. ${step.title} → ${step.status}${detail}` });
                }
                break;
              }
              case 'ask': {
                const question = String(event.question || (isEnglish ? 'Please confirm the next step.' : '请确认下一步。'));
                userQuestions.handleEvent(event);
                setAiStatus(isEnglish ? 'Waiting for your answer…' : '正在等待你回答…');
                addMessage({ role: 'assistant', content: `❓ ${question}` });
                break;
              }
              case 'ask_resolved':
                userQuestions.handleEvent(event);
                break;
              case 'confirm': {
                commandApprovals.handleEvent(event);
                break;
              }
              case 'confirm_resolved':
                commandApprovals.handleEvent(event);
                break;
              case 'plan_review': {
                planReviews.handleEvent(event);
                setAiStatus(isEnglish ? 'Waiting for plan approval…' : '等待你审批计划…');
                break;
              }
              case 'plan_review_resolved': {
                planReviews.handleEvent(event);
                if (event.action === 'approve' || event.action === 'edit') {
                  setAiStatus(isEnglish ? 'Plan approved, continuing…' : '计划已批准，继续执行…');
                }
                break;
              }
              case 'steer_applied':
                setSteerNotice(isEnglish ? 'Steer delivered — the AI is responding to it.' : '插话已注入，AI 正在响应你的最新指示。');
                break;
              case 'steer_unconsumed':
                setSteerNotice(isEnglish ? 'The turn ended before the steer was consumed; it is saved in the conversation.' : '本轮在插话生效前已结束，内容已存入对话，下一轮生效。');
                break;
              case 'ask_done':
                // Agent finished after asking. Clear streaming preview first
                // so the final message doesn't visually duplicate.
                aiRunningRef.current = false;
                if (isCurrentAiRun(aiRunIdRef.current, runId)) setIsAiLoading(false);
                setStreamingContent('');
                setAiStatus(isEnglish ? 'Waiting for your answer…' : '正在等待你回答…');
                if (fullText.trim()) {
                  addMessage({ role: 'assistant', content: fullText.trim() });
                }
                fullText = '';
                break;
              case 'done':
                commandApprovals.clear();
                userQuestions.clear();
                planReviews.clear();
                setSteerNotice('');
                aiRunningRef.current = false;
                if (isCurrentAiRun(aiRunIdRef.current, runId)) setIsAiLoading(false);
                setStreamingContent('');
                setAiStatus(isEnglish ? 'Agent turn ended' : 'Agent 本轮已结束');
                const finalText = resolveAgentDoneText(event.authoritative ? '' : fullText, event.content);
                if (finalText) {
                  addMessage({ role: 'assistant', content: finalText });
                } else if (isAgentDoneCancelled(fullText, event.content)) {
                  addMessage({ role: 'system', content: '[🛑 Agent cancelled]' });
                }
                if (agentPlanRef.current?.status === 'cancelled'
                  || (Array.isArray(agentPlanRef.current?.steps) && agentPlanRef.current.steps.every((step: any) => step.status === 'done' || step.status === 'skipped'))) {
                  persistAgentPlan(null);
                }
                fullText = '';
                break;
              case 'ssh_dead':
                addMessage({ role: 'system', content: '⚠️ SSH 会话已断开，请重新连接（对话已保留）' });
                setErrorMessage(event.error || 'SSH disconnected');
                aiRunningRef.current = false;
                if (isCurrentAiRun(aiRunIdRef.current, runId)) setIsAiLoading(false);
                setIsStreaming(false);
                setAiStatus('SSH 主连接已断开');
                break;
              case 'workflow_run_missing': {
                // 集群上的 RUN 目录/run.json 已被清理或移动：写入解绑标记（隐藏行），
                // 之后 findLatestWorkflowExecutionContext 不再把本对话绑回这个死运行，
                // 用户的新指令直接按普通对话处理，不再每轮重复同一个报错。
                const goneRunDir = String(event.runDir || '');
                const note = isEnglish
                  ? `⚠️ The workflow run state no longer exists on the cluster (run.json under ${goneRunDir} is missing — the directory was probably cleaned up or moved). This conversation has left workflow execution mode; new messages will run as a normal chat.`
                  : `⚠️ 流程运行状态在集群上已不存在（${goneRunDir} 下的 run.json 丢失，目录可能已被清理或移动）。本对话已退出流程执行模式，之后的消息将按普通对话处理。`;
                addMessage({ role: 'system', content: `${formatWorkflowRunDetached(goneRunDir)}\n${note}` });
                aiRunningRef.current = false;
                if (isCurrentAiRun(aiRunIdRef.current, runId)) setIsAiLoading(false);
                setIsStreaming(false);
                setStreamingContent('');
                setAiStatus(isEnglish ? 'Workflow run detached' : '已退出流程执行模式');
                break;
              }
              case 'error':
                commandApprovals.clear();
                userQuestions.clear();
                planReviews.clear();
                setSteerNotice('');
                addMessage({ role: 'system', content: `[❌ Error] ${event.error}` });
                setErrorMessage(String(event.error || 'AI 请求出错'));
                // 错误事件本身就是本轮的终止状态。不等待供应商/服务端
                // 再额外关闭连接，避免界面继续显示“生成中”。
                aiRunningRef.current = false;
                if (isCurrentAiRun(aiRunIdRef.current, runId)) setIsAiLoading(false);
                setIsStreaming(false);
                setStreamingContent('');
                setStreamingReasoning('');
                setAiStatus('AI 本轮已结束');
                break;
            }
          } catch {
            // Skip malformed SSE lines
          }
        }
      }

      // If we got here and haven't added the final text yet
      if (fullText && fullText !== '__ASK__' && fullText !== '__CANCELLED__') {
        // Content was already streamed via setStreamingContent;
        // the final assistant message was added on 'done' event.
      }
      // Release reader lock so the browser can reuse the TCP connection.
      // Do not cancel on normal EOF: that can turn a clean SSE finish into a
      // client-side abort and poison the next POST behind nginx.
      await closeSseReader(reader, readerCloseReason);
      if (fetchTimedOut && !stoppedByUserRef.current) {
        addMessage({ role: 'system', content: '[⏱️ AI request timeout or connection lost, please retry]' });
        setErrorMessage('AI 请求超时或连接中断，可点击重试');
      }
    } catch (err: any) {
      await closeSseReader(reader, 'error');
      if (fetchTimedOut) {
        if (!stoppedByUserRef.current) {
          addMessage({ role: 'system', content: '[⏱️ AI request timeout or connection lost, please retry]' });
          setErrorMessage('AI 请求超时或连接中断，可点击重试');
        }
      } else if (err.name !== 'AbortError') {
        // Only show non-abort errors (AbortError is from user stop, no need to show)
        addMessage({ role: 'system', content: `[✗ Agent error] ${err.message || String(err)}` });
        setErrorMessage(err.message || String(err));
      }
      stoppedByUserRef.current = false;
    } finally {
      if (isCurrentAiRun(aiRunIdRef.current, runId)) {
        agentReaderRef.current = null;
        setIsStreaming(false);
        setStreamingContent('');
        setStreamingReasoning('');
      }
    }
  };

  // ─── 后台运行接续 ────────────────────────────────────────────────
  // 回到一个仍在后台运行的对话时，attach 到服务端缓冲流：先重放脱连期间
  // 的事件，再实时接收后续；终态后服务端关闭连接。
  const attachToRun = async (requestId: string, runId: number) => {
    stoppedByUserRef.current = false;
    aiRunningRef.current = true;
    setIsAiLoading(true);
    setIsStreaming(true);
    setAiStatus('正在恢复后台任务…');
    let fullText = '';
    let lastPreviewUpdateAt = 0;
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    try {
      const response = await fetch(`/api/ai/stream/attach?requestId=${encodeURIComponent(requestId)}`, {
        headers: sessionId ? { 'X-SSH-Session-Id': sessionId } : {},
      });
      if (!response.ok || !response.body) return;
      reader = response.body.getReader();
      agentReaderRef.current = reader;
      aiRequestIdRef.current = requestId;
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        if (!isCurrentAiRun(aiRunIdRef.current, runId)) break;
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          const trimmedLine = line.trim();
          if (!trimmedLine.startsWith('data: ')) continue;
          try {
            const event = JSON.parse(trimmedLine.slice(6));
            switch (event.type) {
              case 'confirm':
              case 'confirm_resolved':
                commandApprovals.handleEvent(event);
                break;
              case 'plan_review':
                planReviews.handleEvent(event);
                setAiStatus(isEnglish ? 'Waiting for plan approval…' : '等待你审批计划…');
                break;
              case 'plan_review_resolved':
                planReviews.handleEvent(event);
                break;
              case 'steer_applied':
                setSteerNotice(isEnglish ? 'Steer delivered — the AI is responding to it.' : '插话已注入，AI 正在响应你的最新指示。');
                break;
              case 'steer_unconsumed':
                setSteerNotice(isEnglish ? 'The turn ended before the steer was consumed; it is saved in the conversation.' : '本轮在插话生效前已结束，内容已存入对话，下一轮生效。');
                break;
              case 'ask':
                userQuestions.handleEvent(event);
                setAiStatus(isEnglish ? 'Waiting for your answer…' : '正在等待你回答…');
                break;
              case 'ask_resolved':
                userQuestions.handleEvent(event);
                break;
              case 'status':
                if (event.message) setAiStatus(String(event.message));
                break;
              case 'content':
                fullText += event.content;
                if (Date.now() - lastPreviewUpdateAt >= 100) {
                  lastPreviewUpdateAt = Date.now();
                  setStreamingContent(fullText);
                }
                setAiStatus('AI 正在组织结果…');
                break;
              case 'tool_call':
                setAiStatus(`AI 正在使用 ${event.name || '工具'}…`);
                break;
              case 'done': {
                commandApprovals.clear();
                userQuestions.clear();
                planReviews.clear();
                setSteerNotice('');
                aiRunningRef.current = false;
                aiRequestIdRef.current = '';
                if (isCurrentAiRun(aiRunIdRef.current, runId)) setIsAiLoading(false);
                setIsStreaming(false);
                setStreamingContent('');
                // detached 运行的终态由服务端追加进对话存档：这里重新拉取，
                // 避免与服务端回写重复；拉取失败才退回本地追加
                const fallbackText = resolveAgentDoneText(event.authoritative ? '' : fullText, event.content);
                const convId = activeConversationId;
                void (async () => {
                  await new Promise(r => setTimeout(r, 400));
                  if (!isCurrentAiRun(aiRunIdRef.current, runId)) return;
                  try {
                    const res = await fetch(`/api/conversations/${convId}`, {
                      credentials: 'include' as RequestCredentials,
                      headers: sessionId ? { 'X-SSH-Session-Id': sessionId } : {},
                    });
                    const data = await res.json();
                    if (!isCurrentAiRun(aiRunIdRef.current, runId)) return;
                    if (data?.success && Array.isArray(data.conversation?.messages)) {
                      onMessagesChange(data.conversation.messages.filter(
                        (m: any) => m && ['system', 'user', 'assistant'].includes(m.role) && typeof m.content === 'string',
                      ));
                      return;
                    }
                  } catch { /* fall through to local append */ }
                  if (!isCurrentAiRun(aiRunIdRef.current, runId)) return;
                  if (fallbackText) addMessage({ role: 'assistant', content: fallbackText });
                })();
                setAiStatus(isEnglish ? 'Agent turn ended' : 'Agent 本轮已结束');
                break;
              }
              case 'error':
                commandApprovals.clear();
                userQuestions.clear();
                planReviews.clear();
                setSteerNotice('');
                aiRunningRef.current = false;
                aiRequestIdRef.current = '';
                if (isCurrentAiRun(aiRunIdRef.current, runId)) setIsAiLoading(false);
                setIsStreaming(false);
                setStreamingContent('');
                addMessage({ role: 'system', content: `[❌ Error] ${event.error}` });
                break;
              case 'workflow_run_missing': {
                const goneRunDir = String(event.runDir || '');
                const note = isEnglish
                  ? `⚠️ The workflow run state no longer exists on the cluster (run.json under ${goneRunDir} is missing). This conversation has left workflow execution mode.`
                  : `⚠️ 流程运行状态在集群上已不存在（${goneRunDir} 下的 run.json 丢失）。本对话已退出流程执行模式，之后的消息将按普通对话处理。`;
                addMessage({ role: 'system', content: `${formatWorkflowRunDetached(goneRunDir)}\n${note}` });
                aiRunningRef.current = false;
                if (isCurrentAiRun(aiRunIdRef.current, runId)) setIsAiLoading(false);
                setIsStreaming(false);
                break;
              }
              default:
                break;
            }
          } catch { /* skip malformed SSE lines */ }
        }
      }
    } catch { /* attach 失败静默：对话存档里已有/将有结果 */ }
    if (reader) {
      if (agentReaderRef.current === reader) agentReaderRef.current = null;
      await closeSseReader(reader, 'completed');
    }
    if (isCurrentAiRun(aiRunIdRef.current, runId)) {
      setIsStreaming(false);
      setStreamingContent('');
    }
  };

  // 回到某对话时若它有后台运行，自动 attach 接续显示
  useEffect(() => {
    if (!activeConversationId || aiRunningRef.current) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`/api/ai/active?conversationId=${encodeURIComponent(activeConversationId)}`, {
          credentials: 'include' as RequestCredentials,
          headers: sessionId ? { 'X-SSH-Session-Id': sessionId } : {},
        });
        const data = await res.json();
        if (cancelled || !data?.success || !data.running || !data.requestId) return;
        const runId = ++aiRunIdRef.current;
        await attachToRun(String(data.requestId), runId);
      } catch { /* 查询失败不影响对话 */ }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeConversationId]);

  // Clear stream on new submit

  const submitToAI = async (
    userText: string,
    options: { appendUserMessage: boolean } = { appendUserMessage: true },
  ) => {
    const trimmed = userText.trim();
    if (!trimmed) return;
    lastUserTextRef.current = trimmed; // 供断流后的"重试"使用
    userQuestions.clear(); // Only a new task (not a reply to a live question) clears the question.
    if (aiRunningRef.current) {
      // Cleanly tear down the in-flight request BEFORE starting a new one.
      // Must await reader.cancel() so the TCP RST is fully processed by the
      // browser before the next fetch opens a new connection; otherwise the
      // browser's connection pool can get confused and ECONNRESET the new POST.
      aiRunningRef.current = false;
      aiRunIdRef.current += 1;
      // 同一对话里以新指令取代旧运行：显式中止服务端旧任务（单纯断连现在会转后台）
      if (aiRequestIdRef.current) {
        void fetch('/api/ai/abort', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ requestId: aiRequestIdRef.current }),
        }).catch(() => {});
        aiRequestIdRef.current = '';
      }
      const prevReader = agentReaderRef.current;
      agentReaderRef.current = null;
      if (prevReader) {
        await closeSseReader(prevReader, 'stale-run');
      }
      abortRef.current?.abort();
      setErrorMessage('');
      // Let the browser's TCP stack process the connection teardown.
      await new Promise(r => setTimeout(r, 80));
    }

    aiRunningRef.current = true;
    const runId = ++aiRunIdRef.current;
    setIsAiLoading(true);
    setAiStatus('AI 正在准备…');
    setErrorMessage('');
    setSteerNotice('');
    // Fresh AbortController per request — never reuse a stale one.
    const controller = new AbortController();
    abortRef.current = controller;

    const requestMessages = buildOutgoingMessages(
      messagesRef.current,
      trimmed,
      options.appendUserMessage,
    );

    if (options.appendUserMessage) {
      addMessage({ role: 'user', content: trimmed });
    }

    try {
      await handleAgentMode(trimmed, requestMessages, runId, controller.signal);
    } catch (err: any) {
      console.error('[AIChat] Submit error:', err);
      const msg = err.message || String(err);
      setErrorMessage(msg);
      addMessage({ role: 'system', content: `Error: ${msg}` });
    } finally {
      if (isCurrentAiRun(aiRunIdRef.current, runId)) {
        aiRunningRef.current = false;
        setIsAiLoading(false);
        setIsStreaming(false);
      }
    }
  };

  const chatInputRef = useRef<HTMLTextAreaElement>(null);

  /**
   * dsh 的 ask_user_question 不是新一轮对话：必须保持当前 SSE，只把答案
   * 回给服务端挂起项。否则会取消原流，并把答案错送成新 prompt。
   */
  const answerLiveQuestion = async (answer: string): Promise<boolean> => {
    const pending = userQuestions.pending;
    if (!pending?.id) return false;
    const trimmed = answer.trim();
    if (!trimmed) return true;
    await userQuestions.reply({ selected: [], custom: trimmed });
    return true;
  };

  const resetChatInputHeight = () => {
    const el = chatInputRef.current;
    if (el) el.style.height = 'auto';
  };

  // 自动增高：上限 192px（约 8 行），超出后内部滚动
  const autoResizeChatInput = () => {
    const el = chatInputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 192)}px`;
  };

  /**
   * 中途插话：AI 运行中向 /api/ai/steer 投递，不打断当前 SSE。
   * 服务端会把插话在下一个模型步注入；若该请求正挂着反问，插话直接作为回答送达。
   * 返回 false 表示运行已结束/不可达，调用方回退为新一轮对话。
   */
  const steerActiveRun = async (text: string): Promise<boolean> => {
    const requestId = aiRequestIdRef.current;
    if (!requestId) return false;
    try {
      const response = await fetch('/api/ai/steer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestId, text }),
        signal: AbortSignal.timeout(10_000),
      });
      const receipt = await response.json().catch(() => null);
      if (!response.ok || !receipt?.success) return false;
      addMessage({ role: 'user', content: text });
      setSteerNotice(receipt.delivered === 'question'
        ? (isEnglish ? 'Your message was delivered as the answer to the pending question.' : '插话已作为当前问题的回答送达。')
        : (isEnglish ? 'Noted — the AI will respond after its current step.' : '已插话，AI 将在当前步骤后响应。'));
      return true;
    } catch {
      return false;
    }
  };

  const submitChatInput = async () => {
    const baseText = inputValue.trim();
    if ((!baseText && attachments.length === 0) || isChatInputDisabled) return;
    // 附件路径随消息文本一起发给 AI（只发路径引用，不发文件内容）
    const userText = appendAttachmentRefs(baseText, attachments, isEnglish);
    resetChatInputHeight();
    setInputValue('');
    if (attachments.length > 0) setAttachments([]);
    if (await answerLiveQuestion(userText)) return;
    // AI 运行中：插话改向而不是中止当前任务；运行已结束时回退为新一轮对话。
    if (aiRunningRef.current && aiRequestIdRef.current && await steerActiveRun(userText)) return;
    await submitToAI(userText, { appendUserMessage: true });
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    await submitChatInput();
  };

  // 使用流程：组合执行指令并直接发送给 AI（用户可在聊天里看到完整指令）；
  // 启动/恢复正式运行（dedicatedConversation）则交给 App 开专属对话，避免串进当前聊天
  const handleUseWorkflow = useCallback((message: string, options?: { dedicatedConversation?: boolean }) => {
    if (options?.dedicatedConversation && onStartWorkflowRun) {
      onStartWorkflowRun(message);
      return;
    }
    setActiveTab('chat');
    setWfMatches([]);
    void submitToAI(message, { appendUserMessage: true });
  }, [submitToAI, onStartWorkflowRun]);

  // 输入关键词自动匹配流程（400ms 防抖）
  useEffect(() => {
    const text = inputValue.trim();
    if (text.length < 2 || activeTab !== 'chat') {
      setWfMatches([]);
      return;
    }
    const timer = setTimeout(async () => {
      try {
        const matches = await matchWorkflowsApi(text);
        setWfMatches(matches.filter(m => m.score >= 8).slice(0, 2));
      } catch { /* ignore */ }
    }, 400);
    return () => clearTimeout(timer);
  }, [inputValue, activeTab]);

  useEffect(() => {
    // 只有属于本标签（本集群）的触发才响应；切换标签时其他标签的触发互不干扰
    if (!triggerAI || triggerAI.tabId !== sessionId) return;
    if (triggerAI.count !== lastTriggerRef.current.agent) {
      lastTriggerRef.current.agent = triggerAI.count;
      const msg = latestUserMessage(messagesRef.current);
      if (msg) void submitToAI(msg.content, { appendUserMessage: false });
    }
  }, [triggerAI]);

  // 作业完成唤醒：服务端向对话追加 user/assistant 两条消息后广播 ai:resumed。
  // 事件指向当前激活对话时，重新拉取该对话并回写消息；不匹配则交给系统通知通道提示。
  const lastAiResumedKeyRef = useRef(''); // 防重复：同一 jobId+conversationId 只处理一次
  useEffect(() => {
    if (!socket) return;
    const handler = async (payload: { type?: string; conversationId?: string; jobId?: string; preview?: string }) => {
      const convId = payload?.conversationId;
      if (!convId || !activeConversationId || convId !== activeConversationId) return;
      const dedupKey = `${payload.jobId || ''}:${convId}`;
      if (lastAiResumedKeyRef.current === dedupKey) return;
      lastAiResumedKeyRef.current = dedupKey;
      try {
        const res = await fetch(`/api/conversations/${convId}`, {
          credentials: 'include' as RequestCredentials,
          headers: sessionId ? { 'X-SSH-Session-Id': sessionId } : {},
        });
        const data = await res.json();
        if (!data?.success || !Array.isArray(data.conversation?.messages)) return;
        // 服务端存档就是客户端保存时的 {role, content, thoughtSteps?} 形状（同 App.tsx 加载对话），
        // 这里只做防御性过滤，保证不破坏当前渲染
        const loaded: Message[] = data.conversation.messages.filter(
          (m: any) => m && (m.role === 'system' || m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string',
        );
        stickToBottomRef.current = true; // 新消息落地后滚动到底
        onMessagesChange(loaded);
      } catch (e) {
        console.error('[ai:resumed] 刷新对话失败', e);
      }
    };
    socket.on('ai:resumed', handler);
    return () => { socket.off('ai:resumed', handler); };
  }, [socket, activeConversationId, sessionId, onMessagesChange]);

  const handleStop = () => {
    aiRunningRef.current = false;
    aiRunIdRef.current += 1;
    abortRef.current?.abort();
    void closeSseReader(agentReaderRef.current, 'stale-run');
    agentReaderRef.current = null;
    // 显式停止：中止服务端任务（仅断开连接现在会转后台，所以停止必须显式发出）
    if (aiRequestIdRef.current) {
      void fetch('/api/ai/abort', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestId: aiRequestIdRef.current }),
      }).catch(() => {});
      aiRequestIdRef.current = '';
    }
    stoppedByUserRef.current = true;
    commandApprovals.clear();
    userQuestions.clear();
    planReviews.clear();
    setSteerNotice('');
    setIsAiLoading(false);
    setIsStreaming(false);
    setAiStatus('AI 已停止');
    stopMonitoring();
    addMessage({ role: 'system', content: '[Agent stopped]' });
  };

  const handleInputChange = (val: string) => {
    setInputValue(val);
    autoResizeChatInput();
  };

  // 回答送达中（userQuestions.busy）不再禁用输入框：送达有 10s 超时兜底，
  // 期间用户应能继续输入；busy 仍驱动问答卡/对话框的 loading 展示。
  const isChatInputDisabled = shouldDisableChatInput(isAiLoading, loadingConversationId);
  // 流程卡片用的真实集群会话：本地工作台（App 传入 'local-workbench'）视为未连接集群
  const clusterSessionId = sessionId && sessionId !== 'local-workbench' ? sessionId : null;
  // 稳定引用：MessageBubble/memo 子树共享，避免每次渲染击穿 memo
  const handleOpenWebPanel = useCallback((request: WebPanelRequest) => {
    onOpenWebPanel?.(request);
  }, [onOpenWebPanel]);
  // 流程配置卡"确认运行"（dedicatedConversation → App 开专属对话）与运行卡"续跑/补齐"
  // （留在当前对话）共用的提交通路：追加用户消息并触发 AI
  const sendWorkflowMessage = (text: string, options?: { dedicatedConversation?: boolean }) => {
    if (options?.dedicatedConversation && onStartWorkflowRun) {
      onStartWorkflowRun(text);
      return;
    }
    void submitToAI(text, { appendUserMessage: true });
  };
  const [expandExecutionDetails, setExpandExecutionDetails] = useState(false);
  // MessageBubble 的 React.memo 依赖 msg 引用稳定：strip 派生对象按 message 引用缓存
  // （WeakMap），同一 message 引用复用同一 msg 对象，避免每次渲染新建击穿 memo。
  const strippedMessagesRef = useRef(new WeakMap<Message, Message | null>());
  const getStrippedMessage = (message: Message, strip: (content: string) => string): Message | null => {
    if (strippedMessagesRef.current.has(message)) return strippedMessagesRef.current.get(message) ?? null;
    const remainder = strip(message.content);
    const derived = remainder ? { ...message, content: remainder } : null;
    strippedMessagesRef.current.set(message, derived);
    return derived;
  };
  // reportBasePaths 每次返回新数组会击穿含 .html 气泡的 memo：缓存上次的 Map 与 messages，
  // 与上次渲染引用相等的前缀条目直接复用旧数组，只有真正变化的 index 才新建。
  const reportContextsCacheRef = useRef<{ messages: Message[]; map: Map<number, string[]> } | null>(null);
  const reportContexts = useMemo(() => {
    const prev = reportContextsCacheRef.current;
    let sharedPrefix = 0;
    if (prev) {
      const limit = Math.min(prev.messages.length, messages.length);
      while (sharedPrefix < limit && prev.messages[sharedPrefix] === messages[sharedPrefix]) sharedPrefix += 1;
    }
    const next = new Map<number, string[]>();
    messages.forEach((message, i) => {
      if (!/\.x?html?\b/i.test(message.content)) return;
      const cached = prev && i < sharedPrefix ? prev.map.get(i) : undefined;
      next.set(i, cached ?? reportBasePaths(messages.slice(0, i + 1)));
    });
    reportContextsCacheRef.current = { messages, map: next };
    return next;
  }, [messages]);
  // Rendering and model context budgets are independent: never discard older chat rows.
  const conversationTimeline = useMemo(() => buildConversationTimeline(messages, 0), [messages]);
  // contentVisibility 虚拟化只对长对话启用：短对话下估算高/真实高切换会引起布局抖动
  const virtualizeMessages = messages.length > 100;
  const runCardIndices = useMemo(() => {
    const indices = new Map<string, number>();
    messages.forEach((message, index) => {
      const context = message.role === 'user' ? parseWorkflowExecutionContext(message.content) : null;
      if (context && !indices.has(workflowRunIdentity(context))) indices.set(workflowRunIdentity(context), index);
    });
    return indices;
  }, [messages]);
  // 流程上下文：裸相对路径(results/x.png)的解析基准 + 建议选项的状态感知来源
  const workflowRunDir = findLatestWorkflowExecutionContext(messages)?.runDir ?? null;
  const lastConversationalMessage = [...messages].reverse().find(message => message.role !== 'system' && message.content.trim());
  const suggestionContextText = messages.slice(-8).map(m => m.content).join('\n');
  const followUpSuggestions = !isAiLoading && !isStreaming && !pendingAsk && lastConversationalMessage?.role === 'assistant'
    ? buildFollowUpSuggestions(lastConversationalMessage.content, isEnglish, suggestionContextText)
    : [];

  //  Render 
  if (!isOpen) return null;

  return (
    <div className={`relative h-full flex flex-col bg-scholar-900 ${workspaceLayout ? 'trace-chat-workspace' : 'border-r border-scholar-700'}`}>
      {/* 主工作台使用轻量标题栏；旧侧栏模式仍保留原标签导航。 */}
      <div className={`border-b border-scholar-700 bg-scholar-900 flex items-center justify-between gap-2 shrink-0 ${workspaceLayout ? 'h-14 px-5' : 'px-2 py-2'}`}>
        {workspaceLayout ? (
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              {activeTab !== 'chat' && (
                <button type="button" onClick={() => setActiveTab('chat')} className="text-xs text-accent hover:underline">返回对话</button>
              )}
              <h1 className="truncate text-sm font-semibold text-scholar-50">{activeTab === 'skills' ? '技能库' : 'AI 工作台'}</h1>
            </div>
            {activeTab === 'chat' && <p className="mt-0.5 text-[10px] text-scholar-500">对话、文件与流程保持在同一个任务上下文中</p>}
          </div>
        ) : (
        <div className="flex bg-scholar-800 rounded-lg p-0.5 gap-0.5 min-w-0 overflow-x-auto shrink">
          <button
            onClick={() => setActiveTab('chat')}
            className={`px-2 py-1.5 rounded-md text-xs font-medium flex items-center gap-1.5 whitespace-nowrap transition-colors ${
              activeTab === 'chat' ? 'bg-scholar-900 text-scholar-50 shadow-sm' : 'text-scholar-400 hover:text-scholar-200'
            }`}
          >
            <Bot className="w-3.5 h-3.5 shrink-0" /> AI 助理
          </button>
          <button
            onClick={() => { setActiveTab('skills'); loadSkills(); }}
            className={`px-2 py-1.5 rounded-md text-xs font-medium flex items-center gap-1.5 whitespace-nowrap transition-colors ${
              activeTab === 'skills' ? 'bg-scholar-900 text-scholar-50 shadow-sm' : 'text-scholar-400 hover:text-scholar-200'
            }`}
          >
            <Brain className="w-3.5 h-3.5 shrink-0" /> 技能库 ({skills.length})
          </button>
          {!workspaceLayout && (
            <button
              onClick={() => setActiveTab('workflows')}
              className={`px-2 py-1.5 rounded-md text-xs font-medium flex items-center gap-1.5 whitespace-nowrap transition-colors ${
                activeTab === 'workflows' ? 'bg-scholar-900 text-scholar-50 shadow-sm' : 'text-scholar-400 hover:text-scholar-200'
              }`}
            >
              <GitBranch className="w-3.5 h-3.5 shrink-0" /> 流程
            </button>
          )}
        </div>
        )}
        <div className="flex items-center gap-0.5 shrink-0">
          <LanguageToggle />
          {workspaceLayout && onOpenComputeBackend && (
            <button
              type="button"
              onClick={onOpenComputeBackend}
              className="mr-2 flex max-w-[250px] items-center gap-2 rounded-full border border-scholar-700 bg-scholar-950/55 px-3 py-1.5 text-[11px] text-scholar-300 transition-colors hover:border-accent/35 hover:text-scholar-100"
              title="打开计算资源"
            >
              <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${workspaceTargetConnected ? 'bg-emerald-500' : 'bg-scholar-500'}`} />
              <Cpu className="h-3.5 w-3.5 shrink-0 text-accent" />
              <span className="truncate">{workspaceTargetLabel || '本地 AI'}</span>
            </button>
          )}
          {workspaceLayout && activeTab === 'chat' && (
            <button onClick={() => { setActiveTab('skills'); loadSkills(); }} className="btn-ghost !px-2 !py-1.5 text-xs" aria-label="技能库" title="技能库">
              <Brain className="w-4 h-4" /> <span className="max-md:hidden">技能库 ({skills.length})</span>
            </button>
          )}
          {isAiSetup && activeTab === 'chat' && (
            <>
              {onNewChat && (
                <button onClick={() => { agentPlanRef.current = null; setAgentPlan(null); onNewChat(); }} className="btn-ghost !px-2 !py-1.5 text-xs" aria-label="新对话" title="新对话">
                  <MessageSquarePlus className="w-4 h-4" /> <span className="max-md:hidden">新对话</span>
                </button>
              )}
              {onSaveToCluster && (
                <button
                  onClick={handleSaveToClusterClick}
                  disabled={saveState === 'saving'}
                  className={`btn-ghost !px-2 !py-1.5 text-xs ${
                    saveState === 'saved' ? '!text-emerald-600' :
                    saveState === 'error' ? '!text-red-600' :
                    saveState === 'saving' ? '!text-accent animate-pulse' : ''
                  }`}
                  aria-label="保存对话到计算资源"
                  title={saveState === 'saved' ? '已保存' : saveState === 'error' ? '保存失败，点击重试' : '保存对话到计算资源'}
                >
                  {saveState === 'saved' ? <Check className="w-4 h-4" /> :
                   saveState === 'saving' ? <Loader2 className="w-4 h-4 animate-spin" /> :
                   <Save className="w-4 h-4" />}
                  <span className="max-md:hidden">保存</span>
                </button>
              )}
              <button onClick={() => setShowSettings(!showSettings)} className="btn-ghost !px-2 !py-1.5 text-xs" data-active={showSettings} aria-label="AI 设置" title="AI 设置">
                <Settings className="w-4 h-4" /> <span className="max-md:hidden">设置</span>
              </button>
            </>
          )}
        </div>
      </div>

      {workspaceLayout && activeTab === 'chat' && jobStatusBar}

      {/* AI 设置作为独立浮层，不再挤压主对话。 */}
      <AnimatePresence>
        {showSettings && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="absolute inset-0 z-30 flex justify-end bg-black/20 backdrop-blur-[1px]"
            onClick={() => setShowSettings(false)}
          >
            <motion.div
              initial={{ x: 28, opacity: 0 }}
              animate={{ x: 0, opacity: 1 }}
              exit={{ x: 28, opacity: 0 }}
              transition={{ duration: 0.18 }}
              className="flex h-full w-[min(440px,92vw)] flex-col border-l border-scholar-700 bg-scholar-900 shadow-lg"
              onClick={event => event.stopPropagation()}
            >
              <div className="flex h-14 shrink-0 items-center justify-between border-b border-scholar-700 px-4">
                <div>
                  <p className="text-sm font-semibold text-scholar-50">AI 与执行设置</p>
                  <p className="mt-0.5 text-[10px] text-scholar-500">模型、规划和命令确认策略</p>
                </div>
                <button type="button" onClick={() => setShowSettings(false)} className="btn-icon" aria-label="关闭 AI 设置">
                  <X className="h-4 w-4" />
                </button>
              </div>
              <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
                <AIProfileFields
                  datalistId="ai-model-options-settings"
                  aiProvider={aiProvider}
                  aiApiKey={aiApiKey}
                  aiModel={aiModel}
                  aiBaseUrl={aiBaseUrl}
                  onProviderChange={p => { setAiProvider(p); setAiModel(PROVIDERS[p]?.[0] || ''); }}
                  onApiKeyChange={setAiApiKey}
                  onModelChange={setAiModel}
                  onBaseUrlChange={setAiBaseUrl}
                />
                <AgentSettingsFields
                  engine={agentEngine}
                  onEngineChange={setAgentEngine}
                  planningPolicy={agentPlanningPolicy}
                  confirmationPolicy={agentConfirmationPolicy}
                  pathPolicy={agentPathPolicy}
                  maxCommands={agentMaxCommands}
                  maxSteps={agentMaxSteps}
                  planReview={agentPlanReview}
                  onPlanningPolicyChange={setAgentPlanningPolicy}
                  onConfirmationPolicyChange={setAgentConfirmationPolicy}
                  onPathPolicyChange={setAgentPathPolicy}
                  onMaxCommandsChange={setAgentMaxCommands}
                  onMaxStepsChange={setAgentMaxSteps}
                  onPlanReviewChange={setAgentPlanReview}
                />
              </div>
              <div className="shrink-0 border-t border-scholar-700 p-4">
                <button
                  onClick={() => {
                    persistAiProfile();
                    setShowSettings(false);
                  }}
                  className="btn-primary w-full justify-center"
                >
                  保存设置
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Skills panel */}
      {activeTab === 'skills' ? (
        <SkillsPanelInline
          skills={skills}
          onSkillsChange={loadSkills}
          onSaveSkill={handleSaveSkill}
          sessionId={sessionId}
        />
      ) : activeTab === 'workflows' ? (
        /* Workflow panel */
        <WorkflowPanel
          onUseWorkflow={handleUseWorkflow}
          onOpenRunner={setRunnerWorkflow}
          aiProfile={{ provider: aiProvider, model: aiModel, apiKey: aiApiKey }}
          sessionId={sessionId}
          socket={socket}
        />
      ) : !isAiSetup ? (
        /* AI Setup */
        <div className="flex-1 overflow-y-auto px-6 py-10">
          <div className="mx-auto max-w-2xl">
          <div className="mb-6 text-center">
            <span className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-lg bg-accent/10 text-accent">
              <Bot className="h-6 w-6" />
            </span>
            <h2 className="text-xl font-semibold text-scholar-50">配置你的 AI 工作台</h2>
            <p className="mt-2 text-sm text-scholar-400">完成一次配置后，就可以直接从对话开始科研计算任务。</p>
          </div>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              persistAiProfile();
            }}
            className="space-y-4 rounded-lg border border-scholar-700 bg-scholar-950/45 p-5 shadow-sm"
          >
            <AIProfileFields
              datalistId="ai-model-options-setup"
              aiProvider={aiProvider}
              aiApiKey={aiApiKey}
              aiModel={aiModel}
              aiBaseUrl={aiBaseUrl}
              onProviderChange={p => { setAiProvider(p); setAiModel(PROVIDERS[p]?.[0] || ''); }}
              onApiKeyChange={setAiApiKey}
              onModelChange={setAiModel}
              onBaseUrlChange={setAiBaseUrl}
              apiKeyRequired
            />
            <AgentSettingsFields
              engine={agentEngine}
              onEngineChange={setAgentEngine}
              planningPolicy={agentPlanningPolicy}
              confirmationPolicy={agentConfirmationPolicy}
              pathPolicy={agentPathPolicy}
              maxCommands={agentMaxCommands}
              maxSteps={agentMaxSteps}
              planReview={agentPlanReview}
              onPlanningPolicyChange={setAgentPlanningPolicy}
              onConfirmationPolicyChange={setAgentConfirmationPolicy}
              onPathPolicyChange={setAgentPathPolicy}
              onMaxCommandsChange={setAgentMaxCommands}
              onMaxStepsChange={setAgentMaxSteps}
              onPlanReviewChange={setAgentPlanReview}
            />
            <button type="submit" className="btn-primary w-full">保存设置</button>
          </form>
          </div>
        </div>
      ) : (
        /* Chat area */
        <div className="flex-1 flex flex-col min-h-0">
          {/* 任务清单面板：有计划时显示进度与当前步骤，无计划整条隐藏 */}
          <AgentPlanPanel plan={agentPlan} english={isEnglish} />
          {/* Error banner */}
          {errorMessage && (
            <div className="mx-3 mt-2 p-2 bg-[rgb(var(--danger-rgb)/0.08)] border border-[rgb(var(--danger-rgb)/0.3)] rounded-lg flex items-start gap-2 text-[var(--color-danger)] text-xs shrink-0">
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
              <div className="flex-1">{errorMessage}</div>
              {lastUserTextRef.current && !isAiLoading && (
                <button
                  onClick={() => {
                    setErrorMessage('');
                    void submitToAI(lastUserTextRef.current, { appendUserMessage: false });
                  }}
                  className="text-xs text-accent hover:underline shrink-0 font-medium"
                  title="从已保存的流程或 Agent 进度继续"
                >
                  继续
                </button>
              )}
              <button onClick={() => setErrorMessage('')} className="text-red-500 hover:text-red-700 shrink-0" aria-label="关闭"><X className="w-3.5 h-3.5" /></button>
            </div>
          )}
          {/* Messages */}
          <div className="relative flex-1 min-h-0 flex flex-col">
          <div ref={messagesContainerRef} onScroll={handleMessagesScroll} onLoadCapture={handleContentLoad} data-chat-messages className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden p-3 space-y-1 [overflow-anchor:none]">
            {loadingConversationId && (
              <div className="flex flex-col items-center justify-center h-full text-scholar-400 text-xs gap-3 px-4">
                <Loader2 className="w-8 h-8 animate-spin text-accent" />
                <p className="text-scholar-300 font-medium">加载对话中...</p>
              </div>
            )}
            {!loadingConversationId && messages.length === 0 && !isAiLoading && (
              <div className="flex flex-col items-center justify-center h-full text-scholar-400 text-xs gap-3 px-4 pb-10">
                <span className="mb-1 flex h-12 w-12 items-center justify-center rounded-lg bg-accent/10 text-accent"><Bot className="w-6 h-6" /></span>
                <p className="text-lg text-scholar-100 font-semibold">今天想完成什么任务？</p>
                <p className="text-center max-w-lg text-sm leading-6">可以先讨论方案，也可以选择左侧文件或流程；需要计算时，TRACE 会调用后台计算资源。</p>
                <div className="grid grid-cols-2 gap-2 w-full max-w-2xl mt-3">
                  {['对当前目录的 FASTQ 文件做质控分析',
                    '查看计算资源作业状态并分析资源使用',
                    '用 BLAST 搜索同源序列',
                    'GO/KEGG 通路富集分析',
                    '查看队列和节点资源'].map((s, i) => (
                    <button
                      key={i}
                      onClick={() => {
                            setInputValue(t(s));
                            requestAnimationFrame(() => autoResizeChatInput());
                          }}
                      className="text-left px-3.5 py-3 bg-scholar-950/45 hover:bg-scholar-800 border border-scholar-700 rounded-lg text-scholar-300 hover:text-scholar-100 transition-colors"
                    >{t(s)}</button>
                  ))}
                </div>
              </div>
            )}
            {messages.length > 0 && (
              <div className="sticky top-0 z-10 flex items-center justify-between rounded-lg border border-scholar-700 bg-scholar-900/95 px-3 py-2 text-xs text-scholar-300">
                <span>{isEnglish ? `${messages.length} records · complete history` : `${messages.length} 条记录 · 完整对话`}</span>
                <button type="button" aria-pressed={expandExecutionDetails} onClick={() => setExpandExecutionDetails(value => !value)} className="text-accent hover:underline">
                  {isEnglish ? (expandExecutionDetails ? 'Collapse execution details' : 'Expand execution details') : (expandExecutionDetails ? '收起执行记录' : '展开执行记录')}
                </button>
              </div>
            )}
            {conversationTimeline.map(item => {
              if (item.type === 'execution') return <ExecutionTrace key={item.key} items={item.items} sessionId={sessionId} workspace={agentWorkspace || undefined} expandDetails={expandExecutionDetails} />;
              const { message, absoluteIndex } = item;
              // 正式流程运行标记：不显示原始协议文本，渲染对话内嵌运行卡
              if (message.role === 'user') {
                const runContext = parseWorkflowExecutionContext(message.content);
                if (runContext) {
                  const stripped = getStrippedMessage(message, stripWorkflowExecutionMarkers);
                  const showCard = runCardIndices.get(workflowRunIdentity(runContext)) === absoluteIndex;
                  return (
                    <div key={absoluteIndex} className="mx-1 mb-3 max-w-[95%]">
                      {stripped && <MessageBubble msg={stripped} index={absoluteIndex} sessionId={sessionId} workspace={agentWorkspace || undefined} workflowRunDir={workflowRunDir} remoteBasePaths={reportContexts.get(absoluteIndex)} onOpenWebPanel={handleOpenWebPanel} expandDetails={expandExecutionDetails} />}
                      {showCard && <WorkflowRunCard
                        context={runContext}
                        sessionId={clusterSessionId}
                        socket={socket}
                        onOpenRemoteFolder={path => onOpenRemoteFolder?.(path, clusterSessionId)}
                        onSendMessage={sendWorkflowMessage}
                        onOpenReport={clusterSessionId && onOpenWebPanel
                          ? path => handleOpenWebPanel({ remotePath: path, sessionId: clusterSessionId, title: '分析报告' })
                          : undefined}
                      />}
                    </div>
                  );
                }
              }
              // 流程配置标记：AI 或匹配 chips 插入，渲染点点点配置卡
              if (message.role !== 'system') {
                const directive = parseWorkflowConfigureDirective(message.content);
                if (directive) {
                  const stripped = getStrippedMessage(message, stripWorkflowConfigureDirectives);
                  return (
                    <div key={absoluteIndex} className="mx-1 mb-3 max-w-[95%] space-y-1.5">
                      {stripped && <MessageBubble msg={stripped} index={absoluteIndex} sessionId={sessionId} workspace={agentWorkspace || undefined} workflowRunDir={workflowRunDir} remoteBasePaths={reportContexts.get(absoluteIndex)} onOpenWebPanel={handleOpenWebPanel} expandDetails={expandExecutionDetails} />}
                      <WorkflowConfigCard
                        workflowId={directive.workflowId}
                        sessionId={clusterSessionId}
                        onPickRemoteFolder={onPickRemoteFolder}
                        onSendMessage={sendWorkflowMessage}
                        onOpenRunner={setRunnerWorkflow}
                      />
                    </div>
                  );
                }
              }
              return <div key={absoluteIndex} style={virtualizeMessages ? { contentVisibility: 'auto', containIntrinsicSize: 'auto 80px' } : undefined}><MessageBubble msg={message} index={absoluteIndex} sessionId={sessionId} workspace={agentWorkspace || undefined} workflowRunDir={workflowRunDir} remoteBasePaths={reportContexts.get(absoluteIndex)} onOpenWebPanel={handleOpenWebPanel} expandDetails={expandExecutionDetails} /></div>;
            })}

            {/* Streaming preview */}
            {(isStreaming) && (
              <div className="flex flex-col items-start mb-3">
                <div className="p-2.5 rounded-lg max-w-[95%] bg-scholar-800 text-scholar-100 border border-scholar-700/60">
                  {streamingReasoning && (
                    <details className="mb-2">
                      <summary className="flex items-center gap-1.5 text-[11px] text-accent mb-1 cursor-pointer select-none">
                        <Brain className="w-3 h-3" /> 思考过程（点击展开）
                      </summary>
                      <div data-user-content="true" className="bg-scholar-900/60 border border-scholar-600/50 rounded p-2 text-[11px] text-scholar-300 max-h-60 overflow-y-auto whitespace-pre-wrap break-words">
                        {streamingReasoning}
                      </div>
                    </details>
                  )}
                  {streamingContent && (
                    <div data-user-content="true"><MarkdownMessage content={streamingContent} onOpenWebPanel={handleOpenWebPanel} sessionId={sessionId} workspace={agentWorkspace || undefined} /></div>
                  )}
                  <div className="flex items-center gap-2 mt-2 text-scholar-400">
                    <Loader2 className="w-3 h-3 animate-spin" />
                    <span className="text-xs">{t(aiStatus)}</span>
                  </div>
                </div>
              </div>
            )}

            {/* Loading indicator (non-streaming) */}
            {isAiLoading && !isStreaming && (
              <div className="flex items-start mb-3">
                <div className="p-2.5 rounded-lg bg-scholar-800 border border-scholar-700/60 text-scholar-300 flex items-center gap-2">
                <Loader2 className="w-4 h-4 animate-spin" /> {t(aiStatus)}
                </div>
              </div>
            )}

            {followUpSuggestions.length > 0 && (
              <div className="ml-1 mb-3 max-w-[95%]">
                <p className="text-xs text-scholar-400 mb-1.5">
                  {isEnglish ? 'You can choose a next step:' : '你可以选择下一步：'}
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {followUpSuggestions.map(option => (
                    <button
                      key={option}
                      type="button"
                      onClick={() => void submitToAI(option, { appendUserMessage: true })}
                      className="px-2.5 py-1.5 text-xs rounded-full border border-accent/25 bg-accent/5 text-accent hover:bg-accent/15 transition-colors"
                    >
                      {option}
                    </button>
                  ))}
                </div>
              </div>
            )}

            <div ref={messagesEndRef} />
          </div>
          {/* 上翻阅读时的"回到底部"直达按钮:新消息落地自动贴底后消失 */}
          {!atBottom && (
            <button type="button" onClick={jumpToBottom}
              className="absolute bottom-4 right-4 z-10 flex items-center gap-1.5 rounded-full border border-accent/50 bg-scholar-900/95 px-3 py-1.5 text-xs text-accent shadow-lg shadow-black/40 hover:bg-scholar-800">
              <ArrowDown className="w-3.5 h-3.5" />{isEnglish ? 'Back to bottom' : '回到底部'}
            </button>
          )}
          </div>

          {/* 信任全部激活时的常驻提示（无待确认命令时也可一键取消） */}
          {confirmMode === 'trust_all' && !pendingCommand && (
            <div className="mx-3 mb-1 flex items-center gap-1.5 text-[10px] text-scholar-400 shrink-0">
              <ShieldCheck className="w-3 h-3 text-accent" />
              <span>{isEnglish ? 'Routine commands are trusted; high-risk operations still require one-shot confirmation.' : '已信任常规命令，高风险操作仍需单次确认。'}</span>
              <button type="button" onClick={() => applyConfirmMode('ask')} className="text-accent hover:underline">取消信任</button>
            </div>
          )}

          {/*  Confirmation Dialog  */}
          {commandApprovals.notice && !pendingCommand && (
            <div role="status" className="mx-3 mb-2 text-xs text-scholar-300">{commandApprovals.notice}</div>
          )}
          {pendingCommand && (
            <div role="dialog" aria-label={isEnglish ? 'Command approval' : '命令确认'} data-testid="command-approval"
              className="mx-3 mb-2 p-3 bg-accent/5 border border-accent/30 rounded-lg shrink-0 overflow-hidden">
              <div className="flex items-start gap-2 mb-2">
                <AlertCircle className="w-4 h-4 text-accent shrink-0 mt-0.5" />
                <div className="flex-1 min-w-0 overflow-hidden">
                  <p className="text-sm text-accent font-medium">{isEnglish ? 'Command approval' : '命令确认'}
                    {commandApprovals.count > 1 ? ` (${commandApprovals.count})` : ''}</p>
                  <p className="text-xs text-scholar-300 mt-1">{commandApprovals.pending?.risk === 'destructive'
                    ? isEnglish ? 'High-risk operation. Review the exact target; permission applies to this command only.' : '高风险操作，请核对准确目标；允许仅对本条命令生效。'
                    : isEnglish ? 'Awaiting your decision. No permission has been granted.' : '正在等待你的确认，尚未授予执行许可。'}</p>
                  {pendingCommandDirWarning && (
                    <p className="text-[10px] text-red-600 mt-1">⚠ 命令可能访问工作目录以外的路径</p>
                  )}
                  <pre data-user-content="true" className="mt-1.5 p-2 bg-scholar-950 border border-scholar-700 rounded-md text-xs font-mono text-scholar-200 overflow-x-auto max-h-28 overflow-y-auto whitespace-pre-wrap break-all">
                    {pendingCommand}
                  </pre>
                </div>
              </div>
              {commandApprovals.error && <p role="alert" className="text-xs text-red-400 mb-2">{commandApprovals.error}</p>}
              <div className="flex gap-2 justify-end">
                <button disabled={commandApprovals.busy} onClick={() => void commandApprovals.decide(commandApprovals.pending!.id, 'reject')}
                  className="px-3 py-1.5 text-xs bg-[rgb(var(--danger-rgb)/0.15)] text-[var(--color-danger)] border border-[rgb(var(--danger-rgb)/0.3)] rounded-lg hover:bg-[rgb(var(--danger-rgb)/0.25)] transition-colors">
                  {isEnglish ? 'Reject' : '拒绝'}
                </button>
                {commandApprovals.pending?.risk !== 'destructive' && commandApprovals.pending?.risk !== 'unknown' && <button disabled={commandApprovals.busy} onClick={() => void commandApprovals.decide(commandApprovals.pending!.id, 'trust')}
                  title={isEnglish ? 'Allow this command and trust future routine commands; high-risk operations still need confirmation.' : '允许本条并信任后续常规命令；高风险操作仍需单次确认。'}
                  className="px-3 py-1.5 text-xs bg-scholar-900 text-scholar-200 border border-scholar-600 rounded-lg hover:bg-scholar-800 transition-colors">
                  {isEnglish ? 'Trust routine commands' : '信任常规命令'}
                </button>}
                <button disabled={commandApprovals.busy} onClick={() => void commandApprovals.decide(commandApprovals.pending!.id, 'execute')}
                  className="px-3 py-1.5 text-xs bg-accent/15 text-accent border border-accent/30 rounded-lg hover:bg-accent/25 font-medium transition-colors">
                  {commandApprovals.busy ? isEnglish ? 'Sending…' : '正在送达…' : isEnglish ? 'Allow once' : '允许本次'}
                </button>
              </div>
            </div>
          )}


          {userQuestions.notice && !pendingAsk && <p role="status" className="mx-3 mb-2 text-xs text-scholar-300">{userQuestions.notice}</p>}
          {planReviews.notice && !pendingPlanReview && <p role="status" className="mx-3 mb-2 text-xs text-scholar-300">{planReviews.notice}</p>}
          {pendingPlanReview && (
            <PlanReviewCard
              key={pendingPlanReview.id}
              review={pendingPlanReview}
              english={isEnglish}
              busy={planReviews.busy}
              error={planReviews.error}
              onDecide={planReviews.decide}
            />
          )}
          {pendingAsk && pendingAsk.key === deferredQuestionKey && <div className="mx-3 mb-2 flex items-center justify-between gap-2 rounded-lg border border-accent/30 bg-accent/5 p-3">
            <div className="min-w-0">
              <p className="text-sm text-scholar-200">{userQuestions.busy
                ? isEnglish ? 'Sending your answer…' : '正在送达你的回答…'
                : isEnglish ? 'The agent is waiting for your answer.' : 'Agent 正在等待你的回答。'}</p>
              {userQuestions.error && <p role="alert" className="mt-1 text-sm text-red-400">{userQuestions.error}</p>}
            </div>
            <button type="button" onClick={() => setDeferredQuestionKey('')} className="px-3 py-1.5 text-sm text-accent">{isEnglish ? 'Answer question' : '回答问题'}</button>
          </div>}
          {pendingAsk && <AIQuestionDialog key={pendingAsk.key} question={pendingAsk} english={isEnglish} open={pendingAsk.key !== deferredQuestionKey}
            busy={userQuestions.busy} error={userQuestions.error} count={userQuestions.count}
            onReply={userQuestions.reply} onPickPath={onPickRemoteFolder} onDefer={() => setDeferredQuestionKey(pendingAsk.key)} />}

          {/* Input */}
          <div data-chat-composer className="px-3 pt-2 pb-4 shrink-0 bg-gradient-to-t from-scholar-900 via-scholar-900 to-scholar-900/80">
            {/* 关键词匹配到的流程 */}
            {wfMatches.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5 mb-2">
                <span className="text-[10px] text-scholar-400">匹配流程:</span>
                {wfMatches.map(w => (
                  <button
                    key={w.id}
                    type="button"
                    onClick={() => {
                      // 点击不再发送文本协议，改为向对话插入一张流程配置卡（与 AI 输出标记同一条渲染通路）
                      setWfMatches([]);
                      const directive = formatWorkflowConfigureDirective({ workflowId: w.id });
                      addMessage({
                        role: 'assistant',
                        content: isEnglish
                          ? `Matched workflow "${w.name}"${w.description ? `: ${w.description}` : ''}. Confirm parameters and inputs in the card below, then click "Confirm and run".\n${directive}`
                          : `匹配到流程「${w.name}」${w.description ? `：${w.description}` : ''}。请在下方卡片中确认参数与输入，点"确认运行"即可开始。\n${directive}`,
                      });
                    }}
                    className="inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded-full bg-accent/10 text-accent border border-accent/25 hover:bg-accent/20 transition-colors"
                    title={w.description}
                  >
                    <GitBranch className="w-3 h-3" /> {w.name}
                  </button>
                ))}
              </div>
            )}
            {/* Agent 本地工作区：dsh 引擎本地工具的落点目录 */}
            {!IS_COMPETITION_EDITION && !isPublicWeb() && (
              <div className="mb-2">
                {needsAgentWorkspaceHint(sessionId, agentWorkspace) && (
                  <div className="mb-1 text-[10px] text-amber-400">
                    {t('本地文件分析需要指定工作区目录')}
                  </div>
                )}
                <div className="flex items-center gap-1.5">
                {window.traceDesktop?.dialog ? (
                  <>
                    <button
                      type="button"
                      onClick={() => void handlePickAgentWorkspace()}
                      className="inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded-md bg-scholar-800 text-scholar-300 border border-scholar-700 hover:text-scholar-100 hover:border-scholar-500 transition-colors shrink-0"
                      title={t('工作区（dsh 引擎本地工具的落点目录）')}
                    >
                      <FolderOpen className="w-3 h-3" /> {t('添加工作文件夹')}
                    </button>
                    <div className="flex min-w-0 flex-1 flex-wrap gap-1">
                      {agentWorkspaces.length > 0 ? agentWorkspaces.map(workspace => (
                        <span key={workspace} className="inline-flex max-w-[240px] items-center gap-1 rounded bg-scholar-800 px-1.5 py-0.5 text-[10px] text-scholar-300" title={workspace}>
                          <span className="truncate">{workspace.length > 34 ? `…${workspace.slice(-33)}` : workspace}</span>
                          <button type="button" onClick={() => handleRemoveAgentWorkspace(workspace)} className="text-scholar-500 hover:text-scholar-100" aria-label={t('清除')}>
                            <X className="h-2.5 w-2.5" />
                          </button>
                        </span>
                      )) : (
                        <span className="text-[10px] text-scholar-400">{t('未设置工作区（默认数据目录）')}</span>
                      )}
                    </div>
                    {agentWorkspaces.length > 0 && (
                      <button
                        type="button"
                        onClick={handleClearAgentWorkspace}
                        className="text-scholar-500 hover:text-scholar-300 shrink-0"
                        title={t('清除')}
                        aria-label={t('清除')}
                      >
                        <X className="w-3 h-3" />
                      </button>
                    )}
                  </>
                ) : (
                  <input
                    key={agentWorkspaces.join('|')}
                    type="text"
                    defaultValue=""
                    onBlur={e => handleWorkspaceInputBlur(e.target.value)}
                    placeholder={t('添加本地工作区路径；多个路径用分号分隔')}
                    title={t('工作区（dsh 引擎本地工具的落点目录）')}
                    className="flex-1 min-w-0 bg-scholar-950 border border-scholar-700 rounded-md px-2 py-1 text-[11px] text-scholar-300 placeholder-scholar-500 focus:outline-none focus:ring-1 focus:ring-accent/50 focus:border-accent"
                  />
                )}
                {workspaceError && (
                  <span className="text-[10px] text-red-500 shrink-0">{workspaceError}</span>
                )}
                </div>
              </div>
            )}
            {/* 附件 chips：quiet pill（细发丝边框 + 低饱和底、× 悬停才显现）——参照 OpenMAIC composer-pill 的登记法 */}
            {attachments.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5 mb-2" data-testid="chat-attachments">
                {attachments.map(item => (
                  <span
                    key={item.id}
                    className="group inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded-full border border-scholar-700/60 bg-scholar-800/45 text-scholar-300"
                    title={item.refPath}
                  >
                    <Paperclip className="w-3 h-3 text-accent shrink-0" />
                    <span className="max-w-[180px] truncate">{item.name}</span>
                    <button
                      type="button"
                      onClick={() => removeAttachment(item.id)}
                      aria-label={`${t('移除附件')}: ${item.name}`}
                      className="opacity-0 group-hover:opacity-100 text-scholar-500 hover:text-scholar-100 shrink-0 transition-opacity"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </span>
                ))}
              </div>
            )}
            {attachmentError && (
              <div className="mb-1 text-[10px] text-amber-400" data-testid="chat-attachment-error">{attachmentError}</div>
            )}
            {/* 输入区：参照 OpenMAIC composer 的处理——聚焦时给一条 accent 描边 + 轻微上浮 + 分层投影，
                让"当前唯一该被注意的控件"有明确的 focused state */}
            <form onSubmit={handleSubmit} className="flex items-end gap-2 rounded-xl border border-scholar-600/70 bg-scholar-950/70 p-2 shadow-[0_1px_2px_rgb(var(--scrim-rgb)/0.18)] transition-all duration-150 focus-within:-translate-y-px focus-within:border-accent/70 focus-within:shadow-[0_0_0_1px_rgb(var(--accent-rgb)/0.45),0_1px_2px_rgb(var(--scrim-rgb)/0.18),0_10px_30px_-12px_rgb(var(--accent-rgb)/0.30)]">
              <input
                ref={attachmentInputRef}
                type="file"
                multiple
                className="hidden"
                data-testid="chat-attachment-input"
                onChange={e => {
                  void handleAttachmentFiles(e.target.files);
                  e.target.value = '';
                }}
              />
              <button
                type="button"
                onClick={handleAttachClick}
                disabled={isChatInputDisabled || attachmentBusy}
                className="p-2 rounded-lg text-scholar-400 hover:text-scholar-100 hover:bg-scholar-800 transition-colors disabled:opacity-40"
                title={t('添加附件')}
                aria-label={t('添加附件')}
              >
                {attachmentBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Paperclip className="w-4 h-4" />}
              </button>
              <textarea
                ref={chatInputRef}
                rows={1}
                value={inputValue}
                onChange={e => handleInputChange(e.target.value)}
                onKeyDown={e => {
                  if (shouldSubmitOnKey({ key: e.key, shiftKey: e.shiftKey, isComposing: e.nativeEvent.isComposing })) {
                    e.preventDefault();
                    void submitChatInput();
                  }
                }}
                placeholder="输入任务描述..."
                className="flex-1 bg-transparent border-0 rounded-md px-2 py-2 text-sm leading-5 resize-none overflow-y-auto max-h-48 focus:outline-none"
                disabled={isChatInputDisabled}
              />
              {isAiLoading ? (
                <button type="button" onClick={handleStop} className="bg-red-600 hover:bg-red-700 text-white p-2 rounded-lg transition-colors" title="停止">
                  <AlertCircle className="w-4 h-4" />
                </button>
              ) : null}
              <button
                type="submit"
                disabled={(!inputValue.trim() && attachments.length === 0) || isChatInputDisabled}
                className="bg-accent text-white p-2.5 rounded-md disabled:opacity-40 hover:bg-accent-dark transition-colors"
                title="发送"
              >
                <Send className="w-4 h-4" />
              </button>
            </form>
            {isAiLoading && (
              <p className="text-xs text-scholar-400 mt-1 text-center">
                {t(aiStatus)}{isEnglish
                  ? ' — You can stop at any time; an AI timeout will not disconnect the compute resource.'
                  : '，可随时停止；AI 超时不会断开计算资源'}
              </p>
            )}
            {steerNotice && (
              <p role="status" className="text-xs text-accent mt-1 text-center">{steerNotice}</p>
            )}
          </div>
        </div>
      )}

      {/* 流程可视化运行面板（抽屉）：从流程页签打开，运行后保持监控 */}
      {runnerWorkflow && (
        <FlowRunnerDrawer
          workflow={runnerWorkflow}
          sessionId={clusterSessionId}
          socket={socket}
          onClose={() => setRunnerWorkflow(null)}
          onConnectCompute={onOpenComputeBackend}
          onRun={handleUseWorkflow}
          onPickFolder={onPickRemoteFolder}
          onOpenRunFolder={path => onOpenRemoteFolder?.(path, sessionId)}
        />
      )}
    </div>
  );
}

//  Inline Skills Panel 
function SkillsPanelInline({
  skills, onSkillsChange, onSaveSkill, sessionId
}: {
  skills: Skill[];
  onSkillsChange: () => void;
  onSaveSkill: (filename: string, content: string) => Promise<boolean>;
  sessionId?: string | null;
}) {
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<string[]>([]);
  const [isAddingSkill, setIsAddingSkill] = useState(false);
  const [newSkillName, setNewSkillName] = useState('');
  const [newSkillContent, setNewSkillContent] = useState('');
  const [expandedSkill, setExpandedSkill] = useState<string | null>(null);
  const [skillContents, setSkillContents] = useState<Record<string, string>>({});
  const [loadingSkill, setLoadingSkill] = useState<string | null>(null);
  const [expandedCats, setExpandedCats] = useState<Set<string>>(new Set());
  const [expandedSubs, setExpandedSubs] = useState<Set<string>>(new Set());

  const handleSearch = async () => {
    if (!searchQuery.trim()) return;
    try {
      const res = await fetch('/api/skills/search?q=' + encodeURIComponent(searchQuery), {
        headers: sessionId ? { 'X-SSH-Session-Id': sessionId } : {},
      });
      const data = await res.json();
      setSearchResults(data.success ? data.results : []);
    } catch { /* ignore */ }
  };

  // Group: category -> sub-category -> skills
  const grouped = React.useMemo(() => {
    const map = new Map<string, Map<string, Skill[]>>();
    for (const s of skills) {
      const cat = (s as any).category || 'other';
      const parts = s.filename.split('/').filter(Boolean);
      const sub = parts.length >= 2 && parts[0] === cat ? parts[1] : (parts[0] || '__root__');
      if (!map.has(cat)) map.set(cat, new Map());
      const subs = map.get(cat)!;
      if (!subs.has(sub)) subs.set(sub, []);
      subs.get(sub)!.push(s);
    }
    const order = ['system', 'lsf', 'cluster', 'hpc', 'bio', 'ai', 'nature', 'imported', 'user'];
    return [...map.entries()].sort((a, b) => {
      const ai = order.indexOf(a[0]), bi = order.indexOf(b[0]);
      if (ai >= 0 && bi >= 0) return ai - bi;
      if (ai >= 0) return -1; if (bi >= 0) return 1;
      return a[0].localeCompare(b[0]);
    });
  }, [skills]);

  // Auto-expand first category
  React.useEffect(() => {
    if (grouped.length > 0 && expandedCats.size === 0) {
      setExpandedCats(new Set([grouped[0][0]]));
    }
  }, [grouped]);

  const toggleCat = (cat: string) => {
    setExpandedCats(prev => { const n = new Set(prev); if (n.has(cat)) n.delete(cat); else n.add(cat); return n; });
  };
  const toggleSub = (key: string) => {
    setExpandedSubs(prev => { const n = new Set(prev); if (n.has(key)) n.delete(key); else n.add(key); return n; });
  };

  const toggleSkill = async (skill: Skill) => {
    if (expandedSkill === skill.filename) {
      setExpandedSkill(null);
      return;
    }
    setExpandedSkill(skill.filename);
    if (skill.content || skillContents[skill.filename] !== undefined) return;
    setLoadingSkill(skill.filename);
    try {
      const res = await fetch('/api/skills/content?filename=' + encodeURIComponent(skill.filename), {
        headers: sessionId ? { 'X-SSH-Session-Id': sessionId } : {},
      });
      const data = await res.json();
      setSkillContents(prev => ({
        ...prev,
        [skill.filename]: data.success ? String(data.content || '') : `读取失败：${data.error || `HTTP ${res.status}`}`,
      }));
    } catch (error: any) {
      setSkillContents(prev => ({ ...prev, [skill.filename]: `读取失败：${error?.message || String(error)}` }));
    } finally {
      setLoadingSkill(current => current === skill.filename ? null : current);
    }
  };

  const CAT_LABELS: Record<string, string> = {
    system: 'System', user: 'User', imported: 'Imported',
    bio: 'Bio', nature: 'Nature', lsf: 'LSF', cluster: 'Cluster',
    hpc: 'HPC', ai: 'AI',
  };


  return (
    <div className="flex-1 overflow-y-auto flex flex-col">
      {/* Search */}
      <div className="shrink-0 p-3 pb-1 flex gap-1">
        <input type="text" value={searchQuery} onChange={e => setSearchQuery(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && handleSearch()} placeholder="Search skills..."
          className="flex-1 bg-scholar-950 border border-scholar-700 rounded-lg px-3 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-accent/50 focus:border-accent" />
        <button onClick={handleSearch} className="p-1.5 bg-scholar-700 text-scholar-200 hover:bg-scholar-600 rounded-lg">
          <Search className="w-3.5 h-3.5" />
        </button>
      </div>
      {searchResults.length > 0 && (
        <div className="mx-3 p-2 bg-scholar-950 border border-scholar-700 rounded-lg max-h-40 overflow-y-auto">
          {searchResults.map((r, i) => (<pre key={i} className="text-xs text-scholar-300 whitespace-pre-wrap mb-2 last:mb-0">{r}</pre>))}
        </div>
      )}

      {/* Toolbar */}
      <div className="flex justify-between items-center shrink-0 px-3 py-2">
        <span className="text-[10px] text-scholar-500">{skills.length} skills</span>
        <button onClick={() => setIsAddingSkill(!isAddingSkill)}
          className="p-1 bg-scholar-700 text-scholar-200 hover:bg-scholar-600 rounded text-[10px] flex items-center gap-1">
          + New
        </button>
      </div>

      {isAddingSkill && (
        <form onSubmit={async (e) => { e.preventDefault(); await onSaveSkill(newSkillName, newSkillContent); setIsAddingSkill(false); setNewSkillName(''); setNewSkillContent(''); onSkillsChange(); }}
          className="mx-3 bg-scholar-950 p-3 rounded-lg border border-scholar-700 space-y-2 shrink-0 mb-2">
          <input type="text" required value={newSkillName} onChange={e => setNewSkillName(e.target.value)}
            placeholder="Skill name" className="w-full bg-scholar-900 border border-scholar-600 rounded p-2 text-xs focus:outline-none" />
          <textarea required value={newSkillContent} onChange={e => setNewSkillContent(e.target.value)}
            placeholder="Content (Markdown)" className="w-full bg-scholar-900 border border-scholar-600 rounded p-2 text-xs h-24 focus:outline-none" />
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setIsAddingSkill(false)} className="px-3 py-1 text-xs text-scholar-300">Cancel</button>
            <button type="submit" className="px-3 py-1.5 text-xs bg-accent text-white rounded hover:bg-accent-dark transition-colors">Add</button>
          </div>
        </form>
      )}

      {/* Category tree */}
      <div className="flex-1 px-1 space-y-0.5 overflow-y-auto">
        {grouped.map(([cat, subMap]) => {
          const isOpen = expandedCats.has(cat);
          
          const label = CAT_LABELS[cat] || cat;
          const subEntries = [...subMap.entries()].sort(([a], [b]) => a === '__root__' ? 1 : b === '__root__' ? -1 : a.localeCompare(b));
          const totalCount = subEntries.reduce((sum, [, ss]) => sum + ss.length, 0);
          return (
            <div key={cat}>
              <button onClick={() => toggleCat(cat)}
                className="w-full flex items-center gap-2 px-2.5 py-2 hover:bg-scholar-800/40 transition-colors text-left rounded-lg group">
                {isOpen ? <ChevronDown className="w-3.5 h-3.5 text-accent shrink-0" /> : <ChevronRight className="w-3.5 h-3.5 text-scholar-500 shrink-0" />}
                
                {isOpen ? <FolderOpen className="w-3.5 h-3.5 text-accent/70 shrink-0" /> : <Folder className="w-3.5 h-3.5 text-scholar-500 shrink-0" />}
                <span className="text-xs font-medium text-scholar-200 truncate">{label}</span>
                <span className="text-[10px] text-scholar-400 ml-auto shrink-0 bg-scholar-800/50 px-1.5 py-0.5 rounded-full">{totalCount}</span>
              </button>
              {isOpen && (
                <div className="ml-5 border-l border-scholar-700/40 pl-2">
                  {subEntries.map(([sub, subSkills]) => {
                    const subKey = cat + '/' + sub;
                    const hasSubs = sub !== '__root__' && subMap.size > 1;
                    const subOpen = !hasSubs || expandedSubs.has(subKey);
                    return (
                      <div key={sub}>
                        {hasSubs && (
                          <button onClick={() => toggleSub(subKey)}
                            className="w-full flex items-center gap-1.5 px-2 py-1.5 hover:bg-scholar-800/30 transition-colors text-left rounded">
                            {subOpen ? <ChevronDown className="w-3 h-3 text-scholar-400 shrink-0" /> : <ChevronRight className="w-3 h-3 text-scholar-500 shrink-0" />}
                            <FolderTree className="w-3 h-3 text-scholar-500 shrink-0" />
                            <span className="text-[11px] text-scholar-300 truncate">{sub}</span>
                            <span className="text-[9px] text-scholar-400 ml-auto">{subSkills.length}</span>
                          </button>
                        )}
                        {subOpen && subSkills.map(s => {
                          const name = (s as any).name || s.filename.replace(/^.*[\\/]/, '').replace(/\.(md|txt)$/i, '');
                          const isExpanded = expandedSkill === s.filename;
                          return (
                            <div key={s.filename} className={hasSubs ? 'ml-4' : ''}>
                               <button onClick={() => { void toggleSkill(s); }}
                                className="w-full flex items-start gap-1.5 px-2 py-1.5 hover:bg-scholar-800/30 transition-colors text-left group rounded">
                                <FileText className="w-3 h-3 text-scholar-400 shrink-0 mt-0.5" />
                                <div className="flex-1 min-w-0">
                                  <div className="flex items-center gap-1.5">
                                    <span className="text-[11px] text-scholar-300 truncate group-hover:text-scholar-100">{name}</span>
                                    {(s as any).source === 'cluster' && <span className="text-[8px] px-1 rounded bg-accent/10 text-accent shrink-0">remote</span>}
                                  </div>
                                  {(s as any).description && <p className="text-[10px] text-scholar-500 truncate mt-0.5">{(s as any).description}</p>}
                                </div>
                              </button>
                               {isExpanded && (
                                 <pre className="mx-2 mb-1 mt-0.5 text-[10px] text-scholar-300 whitespace-pre-wrap max-h-60 overflow-y-auto bg-scholar-950/80 p-2.5 rounded border border-scholar-800/50 leading-relaxed">
                                   {loadingSkill === s.filename
                                     ? '正在读取技能正文…'
                                     : (skillContents[s.filename] ?? s.content ?? s.filename).slice(0, 3000)}
                                   {(skillContents[s.filename] ?? s.content ?? '').length > 3000 && '\n\n... (truncated)'}
                                 </pre>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
        {skills.length === 0 && <p className="text-center text-scholar-400 text-xs mt-8">No skills loaded</p>}
      </div>
    </div>
  );
}
