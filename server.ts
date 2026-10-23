import './server/legacyBrandEnvironment';
import express, { type Request, type Response } from 'express';
import session from 'express-session';
import { createServer } from 'node:http';
import { Server as SocketIOServer, type Socket } from 'socket.io';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { assertSafeRemoteMutation } from './server/files/pathSafety';

import {
  ClusterSession,
  type ClusterCredentials,
  HostFingerprintRequiredError,
  HostFingerprintMismatchError,
} from './server/cluster/clusterSession';
import { resolveSocketSessionId } from './server/socketSession';
import { registerFileRoutes } from './server/files/registerFileRoutes';
import { registerLocalFileRoutes } from './server/files/registerLocalFileRoutes';
import { hasActiveTransfersForSession, registerTransferRoutes } from './server/transfers/registerTransferRoutes';
import { pickSessionToEvict } from './server/cluster/sessionEviction';
import { registerNotificationRoutes } from './server/notifications/registerNotificationRoutes';
import { jobWatcher } from './server/notifications/jobWatcher';
import { registerWorkflowRoutes } from './server/workflows/registerWorkflowRoutes';
import { enableRequestedCatalogueCleanup } from './server/workflows/workflowStore';
import { registerPreflightRoutes } from './server/workflows/registerPreflightRoutes';
import { registerWorkflowRunRoutes } from './server/workflows/registerWorkflowRunRoutes';
import { configureHttpServerForSse } from './server/httpServerConfig';
import { appPath, staticPath, dataPath, ensureDir, DATA_ROOT } from './server/paths';
import { formatLoginFailure } from './server/loginDiagnostics';
import { verifySSHCredentials } from './server/sshAuthenticator';
import { runAgent, type AgentCtx } from './server/ai/agentRunner';
import { CommandApprovals } from './server/ai/commandApprovals';
import { UserQuestions } from './server/ai/userQuestions';
import { PlanReviews, createPlanReviewId } from './server/ai/planReviews';
import { SteerQueue } from './server/ai/steerQueue';
import {
  resolveAccountScheduler,
  clearSchedulerTag,
  schedulerTagKey,
  SCHEDULER_LABELS,
  type SchedulerKind,
} from './server/cluster/schedulerProfile';
import {
  abortActiveRun,
  attachRunListener,
  findActiveRunByConversation,
  finishActiveRun,
  getActiveRun,
  markRunDetached,
  pushRunEvent,
  registerActiveRun,
  replayRunEvents,
} from './server/ai/activeRuns';
import { classifyWorkflowTurn } from './server/ai/workflowTurnIntent';
import { AgentTurnClock } from './shared/agentTurnClock';
import { createRequestWatchdog } from './server/ai/requestWatchdog';
import {
  buildSmartContext,
  profileFromBody,
  messagesFromBody,
} from './server/ai/contextBuilder';
import { createAiCompactionSummarizer } from './server/ai/compactionSummarizer';
import { registerGatewayRoutes } from './server/ai/gatewayRoutes';
import { saveServerAiProfile, loadServerAiProfile } from './server/ai/serverAiProfile';
import {
  loadOrRefreshSkillIndex,
  searchSkillIndex,
} from './server/ai/skillIndex';
import {
  getCachedClusterSkills,
  refreshClusterSkillsInBackground,
} from './server/ai/clusterSkills';
import { installSkillFromSource } from './server/ai/skillInstaller';
import { mergeConversationMemory, type ConversationWithMemory } from './server/ai/conversationMemory';
import { clusterContext } from './server/ai/clusterContext';
import { resolveRequestSessionId } from './server/cluster/sessionRequest';
import { annotateRuns, collectActiveJobIds, needsAutomaticOutputReview, needsSchedulerStateQuery, parseBjobsStates, reconcileRunsWithScheduler, seedPersistedTerminalStates } from './server/workflows/runAnnotate';
import { readWorkflowRun, reconcileWorkflowRunWithScheduler, updateWorkflowRun } from './server/workflows/workflowRunService';
import type { WorkflowRun } from './shared/workflowRun';
import { JobWakeQueue } from './server/ai/jobWakeQueue';
import { unresolvedQcFailures } from './shared/workflowQc';
import { importLegacyWorkflowRunIndex, readIndexedWorkflowRuns } from './server/workflows/workflowRunIndex';
import {
  addFormalWorkflowContinuations,
  handleFormalReconcileFailure,
  initFormalWorkflowContinuations,
  isFormalWorkflowReconcileDue,
  listPendingFormalWorkflowContinuations,
  markFormalWorkflowJobFinished,
  markFormalWorkflowResuming,
  markFormalWorkflowWaitingUser,
  removeFormalWorkflowContinuation,
  resetFormalWorkflowReconcileAttempts,
} from './server/workflows/formalWorkflowContinuations';
import {
  extractRunDirFromText,
  findLatestWorkflowExecutionContext,
  normalizeWorkflowExecutionContext,
  parseWorkflowExecutionContext,
} from './shared/workflowExecution';
import { ClusterConversationStore } from './server/conversations/clusterConversations';
import { LocalConversationStore, filterConversationsByScope } from './server/conversations/localConversations';
import { registerClusterConversationRoutes } from './server/conversations/registerClusterConversationRoutes';
import { aggregateConversationLists, type AggregatedConversationSource } from './server/conversations/aggregateConversations';
import { ensureDemoConversationSeed } from './server/conversations/demoConversationSeed';
import type { AIMessage, AIProfile, SkillIndex, StructuredMemory } from './server/ai/types';
import { SftpFileService } from './server/files/sftpFileService';
import { QQBot, type QQBotConfig } from './server/bots/qqBot';
import { getTransferCredentials, setTransferCredentials, totpNow } from './server/transfers/transferCredentials';
import { decryptSecret, encryptSecret } from './server/secretBox';
import { selectDshEngine } from './server/dsh/engineRouter';
import { runDshAgent } from './server/dsh/dshAgentRunner';
import { registerBridgeRoutes } from './server/dsh/bridgeRoutes';
import { registerWebApiRoutes } from './server/webapis/registerWebApiRoutes';
import {
  initBridgeState,
  getBridgeToken,
  getDshSessionBinding,
} from './server/dsh/bridgeState';
import { stopSidecar } from './server/dsh/dshSidecar';
import { normalizeWorkspace } from './server/dsh/workspace';
import { maybeResumeAgent } from './server/dsh/dshJobResumer';
import { addBindings, getBinding, initJobAgentBindings, markResumed, rebindClusterJobs } from './server/dsh/jobAgentBindings';
import { maybeResumeLegacyAgent } from './server/ai/legacyJobResumer';
import { registerLegacyJobBindings } from './server/ai/legacyJobBindings';
import { createJobEventHandler } from './server/notifications/jobEventHandler';
import { restoreJobAgentBindings } from './server/notifications/jobBindingRestore';
import { sendNotification, loadNotifyConfig } from './server/notifications/notifyService';
import { BoundedSessionStore } from './server/boundedSessionStore';
import { buildDshConversationKey, normalizeConversationContextKey } from './server/dsh/conversationScope';
import { isCompetitionRestrictedApiPath, normalizeTraceEdition } from './shared/edition';
import { buildReconnectCredentials } from './server/cluster/reconnectCredentials';
import { createWebAccess, readWebAccessConfig } from './server/webAccess';
import { JobSubmissionGuard } from './server/ai/jobSubmissionGuard';
import { PUBLIC_WORKER, workerAuthentication } from './server/publicWeb/policy';
import { ClusterWebState } from './server/publicWeb/clusterState';
import { installPublicFetch } from './server/publicWeb/egress';

// ── Environment & constants ─────────────────────────────────────────

const PORT = Number(process.env.PORT || 3003);
const NODE_ENV = process.env.NODE_ENV || 'development';
const DESKTOP_TOKEN = process.env.TRACE_DESKTOP_TOKEN;
const SESSION_SECRET = process.env.SESSION_SECRET || 'trace-dev-secret-change-in-production';
const webAccessConfig = readWebAccessConfig();
const webAccess = createWebAccess(webAccessConfig, getBridgeToken);
const APP_EDITION = normalizeTraceEdition(process.env.TRACE_EDITION);
const IS_COMPETITION_EDITION = APP_EDITION === 'competition';
const publicState = PUBLIC_WORKER ? new ClusterWebState(DATA_ROOT) : undefined;
if (PUBLIC_WORKER) installPublicFetch();

const USER_SKILLS_DIR = ensureDir(dataPath('skills'));
// 单例是刻意的：前台 Agent、正式流程续跑、legacy 续跑与 dsh 桥必须共享同一提交账本。
const jobSubmissionGuard = new JobSubmissionGuard(DATA_ROOT);
// asarUnpack 后，Electron 的 asar 补丁对 unpacked 条目的 readdirSync 会失效
//（本机实测：packed 的 lsf_skills 能扫、unpacked 的 skills 扫不出导致技能库空），
// 有 app.asar.unpacked 实路径时优先走实路径。
function preferUnpackedDir(p: string): string {
  const unpacked = p.replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`);
  if (unpacked !== p) {
    try {
      if (fs.existsSync(unpacked) && fs.statSync(unpacked).isDirectory()) return unpacked;
    } catch { /* ignore */ }
  }
  return p;
}
const APP_SKILLS_DIR = preferUnpackedDir(appPath('skills'));
const LSF_SKILLS_DIR = appPath('lsf_skills');
const DONAU_SKILLS_DIR = appPath('donau_skills');
const CONVERSATIONS_DIR = ensureDir(dataPath('conversations'));
const localConversationStore = new LocalConversationStore(CONVERSATIONS_DIR);

// ── Session management ──────────────────────────────────────────────

interface ActiveSession {
  id: string;
  cluster: ClusterSession;
  home: string;
  info: { host: string; port: number; username: string };
  /** 仅存于服务端内存，用于网络恢复后原 sessionId 重建 SSH。 */
  credentials: ClusterCredentials;
  reconnectPromise?: Promise<void>;
  /** 终端 socket 连接，用于把 AI 执行的命令回显到用户终端 */
  socket?: Socket;
}

const sessions = new Map<string, ActiveSession>();

const pendingAiConfirmations = new CommandApprovals();
const pendingAiQuestions = new UserQuestions();
const pendingPlanReviews = new PlanReviews();
const steerQueue = new SteerQueue();
const formalWorkflowResumeLocks = new Set<string>();
const formalWorkflowWakeQueue = new JobWakeQueue();
/**
 * 正式流程续跑对账链路的 SSH 小 IO 超时。大 LSF 集群上登录节点繁忙时
 * cat/写 run.json 动辄超过默认 15s/20s，统一放宽到 90s；配套调度器查询
 * 用远端 `timeout 60` 自杀包装，本地放弃后远端进程也会退出。
 */
const FORMAL_RECONCILE_READ_TIMEOUT_MS = 90_000;
const FORMAL_RECONCILE_IO_TIMEOUTS = { readTimeoutMs: 90_000, writeTimeoutMs: 90_000 } as const;

function createSessionId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function getSession(sessionId: string | undefined): ActiveSession | undefined {
  if (!sessionId) return undefined;
  const s = sessions.get(sessionId);
  if (!s) return undefined;
  if (s.cluster.state !== 'connected') return undefined;
  return s;
}

function getKnownSession(sessionId: string | undefined): ActiveSession | undefined {
  return sessionId ? sessions.get(sessionId) : undefined;
}

function hasKnownSession(sessionId: string | undefined): boolean {
  return getKnownSession(sessionId) !== undefined;
}

function hasSession(sessionId: string | undefined): boolean {
  return getSession(sessionId) !== undefined;
}

function trackFormalWorkflowJobs(
  sessionId: string,
  workflowRun: { workflowId: string; runId: string; runDir: string; conversationId?: string; locale?: 'zh-CN' | 'en-US'; confirmationPolicy?: 'never' | 'dangerous' | 'state_changes' | 'every_command' } | undefined,
  jobIds: string[],
): void {
  jobWatcher.trackJobs(sessionId, jobIds);
  const session = getKnownSession(sessionId);
  if (!session || !workflowRun || jobIds.length === 0) return;
  addFormalWorkflowContinuations(jobIds, {
    workflowId: workflowRun.workflowId,
    runId: workflowRun.runId,
    runDir: workflowRun.runDir,
    sessionId,
    connection: session.info,
    conversationId: workflowRun.conversationId,
    locale: workflowRun.locale,
    confirmationPolicy: workflowRun.confirmationPolicy,
  });
}

/** 重启或重新登录后，用稳定的 host/user/port 找回尚未收尾的正式流程作业。 */
function restoreFormalWorkflowMonitoring(sessionId: string, session: ActiveSession): void {
  const pending = listPendingFormalWorkflowContinuations(session.info);
  if (pending.length === 0) return;
  jobWatcher.trackJobs(sessionId, pending.map(record => record.jobId));
  for (const record of pending) {
    if (record.terminalStatus) void reconcileFinishedWorkflowJob(sessionId, record.jobId, record.terminalStatus);
  }
  console.log('[workflow-continuation] restored %d jobs for %s', pending.length, session.info.username);
}

async function resumeFinishedFormalWorkflowRun(sessionId: string, run: any, jobId: string): Promise<boolean> {
  if (!run?.runDir || !needsAutomaticOutputReview(run) || formalWorkflowResumeLocks.has(run.runDir)) return false;
  const s = getSession(sessionId);
  if (!s) return false;
  const continuation = listPendingFormalWorkflowContinuations(s.info).find(record => record.runDir === run.runDir);
  if (continuation?.conversationId && findActiveRunByConversation(continuation.conversationId)) return false;
  if (unresolvedQcFailures(run).length) return false;
  const profile = loadServerAiProfile();
  if (!profile?.apiKey) {
    const paused = await updateWorkflowRun(s.cluster.exec.bind(s.cluster), s.home, run.runDir, {
      status: 'waiting_user',
      error: `作业 ${jobId} 已完成，但未找到可用 AI 配置，无法自动验收并继续。`,
    }, FORMAL_RECONCILE_IO_TIMEOUTS).catch(() => undefined);
    if (paused) emitWorkflowRunChanged(sessionId, paused);
    return true;
  }

  formalWorkflowResumeLocks.add(run.runDir);
  if (continuation) markFormalWorkflowResuming(continuation.id);
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 10 * 60_000);
  timer.unref?.();
  try {
    const resumed = await updateWorkflowRun(s.cluster.exec.bind(s.cluster), s.home, run.runDir, {
      status: 'running',
      error: '',
    }, FORMAL_RECONCILE_IO_TIMEOUTS);
    emitWorkflowRunChanged(sessionId, resumed);
    if (unresolvedQcFailures(resumed).length) return true;
    let finalText = '';
    const statusWrites: Promise<unknown>[] = [];
    await runAgent({
      sid: sessionId,
      run: (_sid, command, timeout) => s.cluster.exec(command, timeout),
      confirmCommand: async () => false,
      profile,
      home: s.home,
      skillsDir: APP_SKILLS_DIR,
      lsfSkillDir: LSF_SKILLS_DIR,
      donauSkillDir: DONAU_SKILLS_DIR,
      userSkillsDir: USER_SKILLS_DIR,
      runtimeConfig: {
        planningPolicy: 'auto',
        confirmationPolicy: continuation?.confirmationPolicy || 'dangerous',
        pathPolicy: 'full_access',
        maxCommands: 40,
        maxSteps: 200,
      },
      workflowRun: {
        workflowId: resumed.workflowId,
        runId: resumed.runId,
        runDir: resumed.runDir,
        policy: 'isolated-run-v1',
      },
      onJobsSubmitted: jobIds => trackFormalWorkflowJobs(sessionId, {
        workflowId: resumed.workflowId,
        runId: resumed.runId,
        runDir: resumed.runDir,
        conversationId: continuation?.conversationId,
        locale: continuation?.locale,
        confirmationPolicy: continuation?.confirmationPolicy,
      }, jobIds),
      jobSubmissionGuard,
      conversationId: continuation?.conversationId,
      locale: continuation?.locale || 'zh-CN',
    }, {
      onText: () => {},
      onReason: () => {},
      onToolCall: (name) => console.log('[workflow-resume:%s] tool=%s', resumed.runId, name),
      onToolResult: () => {},
      onStep: () => {},
      onAsk: (question) => {
        statusWrites.push(updateWorkflowRun(s.cluster.exec.bind(s.cluster), s.home, resumed.runDir, {
          status: 'waiting_user',
          error: question,
        }, FORMAL_RECONCILE_IO_TIMEOUTS).then(next => emitWorkflowRunChanged(sessionId, next)).catch(() => {}));
      },
      onWorkflowRunChanged: next => emitWorkflowRunChanged(sessionId, next),
      onDone: text => { finalText = text; },
      onErr: error => {
        console.error('[workflow-resume:%s] error=%s', resumed.runId, error);
        statusWrites.push(updateWorkflowRun(s.cluster.exec.bind(s.cluster), s.home, resumed.runDir, {
          status: 'waiting_user',
          error: `自动续跑失败：${error}`,
        }, FORMAL_RECONCILE_IO_TIMEOUTS).then(next => emitWorkflowRunChanged(sessionId, next)).catch(() => {}));
      },
      sig: () => abort.signal,
    }, [{
      role: 'user',
      content: `后台监控确认作业 ${jobId} 已结束。请读取当前步骤的真实日志和预期输出，验证退出结果与 QC；证据充分后更新该步骤为 done 并继续后续步骤。若输出失败则标记 failed；若缺少决定性信息则 ask_user。`,
    }]);
    await Promise.all(statusWrites);
    if (continuation?.conversationId) {
      const latest = await readWorkflowRun(s.cluster.exec.bind(s.cluster), s.home, resumed.runDir, FORMAL_RECONCILE_READ_TIMEOUT_MS);
      const answer = finalText && !finalText.startsWith('__') ? finalText : (latest.error || `流程当前状态：${latest.status}，步骤 ${latest.currentStep}/${latest.totalSteps}。`);
      await appendJobResumeConversation(continuation.conversationId, [
        { role: 'system', content: `后台作业 ${jobId} 结束，已触发同一 RUN 的输出核验与续跑；实际状态见下方。` },
        { role: 'assistant', content: answer },
      ], sessionId);
      io.to(workflowRunRoom(sessionId)).emit('ai:resumed', { conversationId: continuation.conversationId, jobId, preview: answer.slice(0, 200) });
    }
    return true;
  } finally {
    clearTimeout(timer);
    formalWorkflowResumeLocks.delete(run.runDir);
  }
}

/** 作业监控器的后台完成事件同步到对应流程步骤；无需保持流程页面打开。 */
async function reconcileFinishedWorkflowJob(sessionId: string, jobId: string, status: 'DONE' | 'EXIT'): Promise<void> {
  const s = getSession(sessionId);
  if (!s) return;
  const continuationRecords = markFormalWorkflowJobFinished(s.info, jobId, status, sessionId);
  for (const record of continuationRecords) {
    await formalWorkflowWakeQueue.enqueue(`${record.connectionKey}:${record.runDir}`, jobId, async () => {
      // 重试期间给流程面板的瞬时提示用最近一次成功读到的 run（不写盘，
      // 避免覆盖 SCHEDULER_REVIEW_PENDING 等状态机约定字段）。
      let lastKnownRun: WorkflowRun | undefined;
      try {
        // Use the exact durable binding, not a truncated recent-run index.
        const run = await readWorkflowRun(s.cluster.exec.bind(s.cluster), s.home, record.runDir, FORMAL_RECONCILE_READ_TIMEOUT_MS);
        lastKnownRun = run;
        const ids = collectActiveJobIds([run]);
        // 先用可信的持久化终态（续跑记录 + run.jobStates 里的调度器终态）预填；
        // 全部到齐时跳过调度器补查——大集群上这次 bjobs/sacct 是主要超时来源。
        const states = seedPersistedTerminalStates(run, listPendingFormalWorkflowContinuations(s.info));
        if (ids.length && needsSchedulerStateQuery(run, states)) {
          const output = await s.cluster.exec(
            `if command -v bjobs >/dev/null 2>&1; then timeout 60 bjobs -a -noheader -o "jobid stat" ${ids.join(' ')} 2>/dev/null; ` +
            `elif command -v sacct >/dev/null 2>&1; then timeout 60 sacct -n -X -j ${ids.join(',')} --format=JobIDRaw,State 2>/dev/null; fi; true`, 90_000,
          ).catch(() => '');
          for (const [id, state] of parseBjobsStates(output)) states.set(id, state);
        }
        states.set(jobId, status);
        const after = await reconcileWorkflowRunWithScheduler(s.cluster.exec.bind(s.cluster), s.home, run.runDir, states, FORMAL_RECONCILE_IO_TIMEOUTS);
        lastKnownRun = after;
        resetFormalWorkflowReconcileAttempts(record.id);
        emitWorkflowRunChanged(sessionId, after);
        if (['done', 'failed', 'cancelled'].includes(after.status)) {
          removeFormalWorkflowContinuation(record.id);
          return;
        }
        // 暗死路修复：补查后仍有作业状态无法确认时，写一条可见提示，而不是静默返回。
        if (!after.error) {
          const unknownIds = collectActiveJobIds([after]).filter(id => (after.jobStates?.[id] || 'UNKNOWN') === 'UNKNOWN');
          if (unknownIds.length > 0) {
            const hinted = await updateWorkflowRun(s.cluster.exec.bind(s.cluster), s.home, run.runDir, {
              error: `等待调度器核实其余 ${unknownIds.length} 个作业（${unknownIds.slice(0, 5).join(', ')}${unknownIds.length > 5 ? '…' : ''}）的状态；核实后自动继续，无需操作。`,
            }, FORMAL_RECONCILE_IO_TIMEOUTS);
            lastKnownRun = hinted;
            emitWorkflowRunChanged(sessionId, hinted);
          }
        }
        if (!needsAutomaticOutputReview(after)) {
          if (['waiting_user', 'blocked_env'].includes(after.status)) markFormalWorkflowWaitingUser(record.id);
          return;
        }
        if (record.resumeCount >= 3) {
          const paused = await updateWorkflowRun(s.cluster.exec.bind(s.cluster), s.home, record.runDir, {
            status: 'waiting_user', error: '自动验收多次失败，已暂停。请检查具体日志与 AI 配置后从断点恢复；未重复提交作业。',
          }, FORMAL_RECONCILE_IO_TIMEOUTS);
          emitWorkflowRunChanged(sessionId, paused);
          markFormalWorkflowWaitingUser(record.id);
          return;
        }
        const started = await resumeFinishedFormalWorkflowRun(sessionId, after, jobId);
        if (!started) return; // Busy/offline: retain job_finished for the next recovery sweep.
        const latest = await readWorkflowRun(s.cluster.exec.bind(s.cluster), s.home, record.runDir, FORMAL_RECONCILE_READ_TIMEOUT_MS);
        if (['waiting_user', 'blocked_env'].includes(latest.status)) markFormalWorkflowWaitingUser(record.id);
        else removeFormalWorkflowContinuation(record.id);
      } catch (err) {
        // 对账失败：计数并退避重排；连续失败到上限后转 waiting_user 暂停并通知用户。
        console.warn('[workflow-continuation] reconciliation deferred: %s', err instanceof Error ? err.message : String(err));
        const failure = await handleFormalReconcileFailure(record, {
          pauseRun: async (runDir, error) => {
            const paused = await updateWorkflowRun(s.cluster.exec.bind(s.cluster), s.home, runDir, { status: 'waiting_user', error }, FORMAL_RECONCILE_IO_TIMEOUTS);
            emitWorkflowRunChanged(sessionId, paused);
          },
          notify: notifyJobResume,
        });
        if (failure.action === 'retry') {
          // Keep the durable event pending. A failed read is not a request for user input.
          markFormalWorkflowJobFinished(s.info, jobId, status, sessionId);
          if (lastKnownRun) {
            emitWorkflowRunChanged(sessionId, {
              ...lastKnownRun,
              error: `自动续跑因集群响应缓慢重试中（第 ${failure.attempts} 次）；集群恢复后会自动继续，无需操作。`,
            });
          }
        }
      }
    });
  }
}

// Recover a terminal event lost during a disconnect, index read failure or busy foreground turn.
// 失败的记录按 reconcileAttempts 退避（45s→2min→5min→15min），不再每 45s 无差别重放。
const formalContinuationTimer = setInterval(() => {
  for (const [sessionId, session] of sessions) {
    if (session.cluster.state !== 'connected') continue;
    for (const record of listPendingFormalWorkflowContinuations(session.info)) {
      if (record.state === 'job_finished' && record.terminalStatus && isFormalWorkflowReconcileDue(record)) {
        void reconcileFinishedWorkflowJob(sessionId, record.jobId, record.terminalStatus);
      }
    }
  }
}, 45_000);
formalContinuationTimer.unref?.();

/** dsh/legacy 唤醒与后台（detached）运行共用的对话回写：把续跑系统消息与 AI 回答追加到对话存档。
 *  对话按计算目标物理分存：带 sessionId 的集群对话写到该集群的远程库，否则写本地库。 */
const appendJobResumeConversation = async (
  conversationId: string,
  messages: Array<{ role: string; content: string }>,
  sessionId?: string,
): Promise<boolean> => {
  try {
    let store: AnyConversationStore = localConversationStore;
    if (sessionId && sessionId !== 'local-workbench' && hasSession(sessionId)) {
      const s = getSession(sessionId);
      if (s) {
        store = new ClusterConversationStore(
          new SftpFileService(s.cluster.getSftp(), s.home, s.cluster.exec.bind(s.cluster)),
          s.home,
        );
      }
    }
    const record = await store.get(conversationId);
    if (!record) return false;
    (record.messages as AIMessage[]).push(...(messages as AIMessage[]));
    await store.save(enrichConversation(record as ConversationRecord));
    return true;
  } catch (err) {
    console.warn('[job-resume] appendConversation 失败: %s', err instanceof Error ? err.message : String(err));
    return false;
  }
};

async function readJobResumeConversation(conversationId: string, sessionId: string): Promise<{ messages: AIMessage[]; summary?: string } | null> {
  const s = getSession(sessionId);
  if (!s) return null;
  const store = new ClusterConversationStore(new SftpFileService(s.cluster.getSftp(), s.home, s.cluster.exec.bind(s.cluster)), s.home);
  const record = await store.get(conversationId);
  return record ? { messages: record.messages as AIMessage[], summary: record.summary } : null;
}

/** dsh/legacy 唤醒共用的外部通知（notify-config/飞书逻辑保持不变）。 */
const notifyJobResume = async (title: string, content: string): Promise<void> => {
  try {
    const cfg = await loadNotifyConfig();
    if (cfg?.enabled) await sendNotification(cfg, title, content);
  } catch (err) {
    console.warn('[job-resume] notify 失败: %s', err instanceof Error ? err.message : String(err));
  }
};

jobWatcher.configure({
  emitEvent: createJobEventHandler({
    reconcileWorkflow: (sessionId, jobId, status) => {
      void reconcileFinishedWorkflowJob(sessionId, jobId, status);
    },
    // job:finished / ai:resumed 都进 workflow-runs 房间；无房间的会话由 socket.io 静默忽略。
    emitToRoom: (sessionId, eventName, payload) => {
      io.to(workflowRunRoom(sessionId)).emit(eventName, payload);
    },
    // Agent 外圈闭合：若该作业登记过 dsh 绑定，向同一 dsh 会话注入续跑消息。
    resumeDshAgent: evt => {
      void maybeResumeAgent(
        evt,
        {
          dataRoot: DATA_ROOT,
          pluginSourceDir: appPath('vendor', 'dsh-plugin'),
          skillDirs: [APP_SKILLS_DIR, USER_SKILLS_DIR, LSF_SKILLS_DIR, DONAU_SKILLS_DIR, path.join(APP_SKILLS_DIR, 'bio'), path.join(APP_SKILLS_DIR, 'hpc')],
          getBinding,
          markResumed,
          exec: (sid, cmd, timeout) => {
            const s = getSession(sid);
            if (!s) return Promise.reject(new Error('no cluster session'));
            return s.cluster.exec(cmd, timeout);
          },
          appendConversation: appendJobResumeConversation,
          emitToUi: (sid, payload) => {
            io.to(workflowRunRoom(sid)).emit('ai:resumed', payload);
          },
          notify: notifyJobResume,
          onJobsSubmitted: (binding, jobIds) => {
            addBindings(jobIds, binding);
            jobWatcher.trackJobs(binding.sshSessionId, jobIds);
          },
        },
      );
    },
    // legacy(内置)引擎绑定：不走 dsh，直接向内置 runAgent 投唤醒 prompt 续跑原对话。
    resumeLegacyAgent: evt => {
      void maybeResumeLegacyAgent(evt, {
        getBinding,
        markResumed,
        getSession: sid => {
          const s = getSession(sid);
          return s ? { home: s.home, exec: s.cluster.exec.bind(s.cluster) } : undefined;
        },
        loadProfile: loadServerAiProfile,
        skillsDir: APP_SKILLS_DIR,
        lsfSkillDir: LSF_SKILLS_DIR,
      donauSkillDir: DONAU_SKILLS_DIR,
        userSkillsDir: USER_SKILLS_DIR,
        appendConversation: appendJobResumeConversation,
        loadConversation: readJobResumeConversation,
        emitToUi: (sid, payload) => {
          io.to(workflowRunRoom(sid)).emit('ai:resumed', payload);
        },
        notify: notifyJobResume,
        onJobsSubmitted: (binding, jobIds) => {
          // 唤醒轮里新提交的作业：继续跟踪并续登到原对话，保持监控闭环。
          jobWatcher.trackJobs(binding.sshSessionId, jobIds);
          try {
            registerLegacyJobBindings(binding.sshSessionId, jobIds, {
              conversationKey: binding.conversationKey,
              conversationId: binding.conversationId,
              workspace: binding.workspace,
              confirmationPolicy: binding.confirmationPolicy,
              profile: binding.profile,
              locale: binding.locale,
            });
          } catch (err) {
            console.warn('[job-bind] legacy 续跑作业绑定登记失败: %s', err instanceof Error ? err.message : String(err));
          }
        },
        jobSubmissionGuard,
      });
    },
  }),
  // 首轮基线例外：挂着未唤醒绑定的作业（重启恢复期间结束的）首轮即终态也要发事件。
  hasPendingBinding: (sessionId, jobId) => {
    const binding = getBinding(jobId, sessionId);
    const session = getKnownSession(sessionId);
    return Boolean(binding && binding.resumeCount === 0) || Boolean(session &&
      listPendingFormalWorkflowContinuations(session.info).some(record => record.jobId === jobId));
  },
});

interface CreateSessionSuccess {
  success: true;
  sessionId: string;
  home: string;
}

interface CreateSessionError {
  success: false;
  error: string;
  code?: string;
  fingerprint?: string;
  expected?: string;
  actual?: string;
}

async function createSession(
  credentials: ClusterCredentials,
): Promise<CreateSessionSuccess | CreateSessionError> {
  const cluster = new ClusterSession();

  try {
    await cluster.connect(credentials, async (fingerprint) => {
      // Browser form path already provides expectedFingerprint; this callback
      // is only reached when expectedFingerprint is missing (first connect).
      // We reject here and let the caller surface the fingerprint requirement.
      return false;
    });
  } catch (err: any) {
    cluster.close();
    if (err instanceof HostFingerprintRequiredError) {
      return {
        success: false,
        error: '首次连接需要确认主机指纹',
        code: err.code,
        fingerprint: err.fingerprint,
      };
    }
    if (err instanceof HostFingerprintMismatchError) {
      return {
        success: false,
        error: '主机指纹与已信任的不符',
        code: err.code,
        expected: err.expected,
        actual: err.actual,
      };
    }
    return {
      success: false,
      error: formatLoginFailure({ output: err?.message || String(err) }),
    };
  }

  // 多集群标签页：会话共存，仅在上限时淘汰最旧的会话。
  // 有活跃/暂停传输的会话不淘汰（jobWatcher 也同步不停）：淘汰会连 SSH 一起杀掉
  // 几个小时的大文件传输。全部会话都有传输时暂时突破上限，也不杀传输。
  const MAX_CLUSTER_SESSIONS = 8;
  while (sessions.size >= MAX_CLUSTER_SESSIONS) {
    const evictId = pickSessionToEvict(sessions.keys(), hasActiveTransfersForSession);
    if (!evictId) break;
    sessions.get(evictId)?.cluster.close();
    sessions.delete(evictId);
    jobWatcher.stop(evictId);
  }

  const home = await cluster.getHomeDirectory();
  const sessionId = createSessionId();
  sessions.set(sessionId, {
    id: sessionId,
    cluster,
    home,
    info: {
      host: credentials.host,
      port: credentials.port,
      username: credentials.username,
    },
    credentials: { ...credentials },
  });
  cluster.on('disconnected', (details?: { reason?: string }) => {
    const current = sessions.get(sessionId);
    if (current?.cluster === cluster) {
      console.error(
        '[SSH:%s] session disconnected host=%s user=%s reason=%s',
        sessionId,
        credentials.host,
        credentials.username,
        details?.reason || 'unknown',
      );
      jobWatcher.stop(sessionId);
      workflowRunSnapshotCache.delete(sessionId);
      io.to(workflowRunRoom(sessionId)).emit('ssh:disconnected', {
        error: 'SSH 主连接已断开。网络恢复后可点击重连；已提交的调度器作业不受影响。',
      });
    }
  });

  return { success: true, sessionId, home };
}

// ── Express app ─────────────────────────────────────────────────────

const app = express();
// Only a minimal liveness probe is public; application APIs remain behind web authentication.
app.get('/healthz', (_req, res) => res.json({ status: 'ok' }));
const httpServer = createServer(app);
const io = new SocketIOServer(httpServer, {
  path: '/socket.io',
  cors: { origin: webAccessConfig.enabled ? webAccessConfig.origin || false : '*' },
  allowRequest: (req, callback) => callback(null, !webAccessConfig.enabled || webAccess.originAllowed(req.headers.origin)),
});

const WORKFLOW_RUN_UPDATED_EVENT = 'workflow:run-updated';
const workflowRunRoom = (sessionId: string) => `workflow-runs:${sessionId}`;
const workflowRunSnapshotCache = new Map<string, { expiresAt: number; runs: unknown[] }>();

/** 单个运行记录的增量事件；客户端无需为一个步骤变化重新扫描整个集群。 */
function emitWorkflowRunChanged(sessionId: string, run: unknown): void {
  workflowRunSnapshotCache.delete(sessionId);
  io.to(workflowRunRoom(sessionId)).emit(WORKFLOW_RUN_UPDATED_EVENT, { run });
}

const sessionMiddleware = session({
  secret: SESSION_SECRET,
  store: new BoundedSessionStore({
    maxSessions: 256,
    ttlMs: 7 * 24 * 60 * 60 * 1000,
  }),
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: webAccessConfig.enabled && process.env.TRACE_WEB_COOKIE_SECURE === '1',
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000,
  },
});

if (webAccessConfig.enabled && process.env.TRACE_TRUST_PROXY === '1') app.set('trust proxy', 1);
if (PUBLIC_WORKER) app.set('trust proxy', 'loopback');
app.use(sessionMiddleware);
app.use(workerAuthentication);
app.use(webAccess.middleware);
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
// Private working files are just a cache. A successful mutation ACK requires a remote commit.
app.use((req, res, next) => {
  if (!publicState) return next();
  const json = res.json.bind(res);
  res.json = ((body: unknown) => {
    void publicState.flush().then(() => json(body), () => {
      if (!res.headersSent) res.status(503);
      json({ success: false, error: '集群持久保存失败，操作尚未确认；请检查连接或重新登录，未回退到服务器共享存储' });
    });
    return res;
  }) as typeof res.json;
  next();
});

// 竞赛版保留完整流程能力，仅移除 dsh。服务端同时拒绝 dsh 桥接
// API，避免旧页面缓存、插件或手工请求绕过产品边界。
app.use((req, res, next) => {
  if (IS_COMPETITION_EDITION && isCompetitionRestrictedApiPath(req.path)) {
    res.status(404).json({ error: '竞赛版不包含 DSH 桥接功能' });
    return;
  }
  next();
});

app.get('/api/app-info', (_req, res) => {
  res.json({
    edition: APP_EDITION,
    capabilities: {
      cluster: true,
      terminal: true,
      fileTransfer: true,
      filePreview: true,
      nativeAgent: true,
      workflowDevelopment: true,
      dsh: !IS_COMPETITION_EDITION && !PUBLIC_WORKER,
      localWorkspace: !PUBLIC_WORKER,
    },
  });
});

// Desktop-token guard for Electron-initiated endpoints.
function requireDesktopToken(req: Request, res: Response, next: () => void): void {
  if (!DESKTOP_TOKEN) {
    next();
    return;
  }
  const token = req.get('X-TRACE-Desktop-Token');
  if (token !== DESKTOP_TOKEN) {
    res.status(403).json({ error: 'Forbidden: invalid desktop token' });
    return;
  }
  next();
}

// ── Login / logout ──────────────────────────────────────────────────

async function handleLogin(
  req: Request,
  res: Response,
  credentials: ClusterCredentials,
): Promise<void> {
  const result = await createSession(credentials);
  if (result.success === false) {
    const status = result.code === 'HOST_FINGERPRINT_REQUIRED' ? 428
      : result.code === 'HOST_FINGERPRINT_MISMATCH' ? 409
      : 401;
    res.status(status).json(result);
    return;
  }

  (req.session as any).sshSessionId = result.sessionId;
  // 启动作业完成监控（轮询 bjobs/squeue，检测 DONE/EXIT 后触发通知）。
  // 此前这里从未接线，导致"测试通知能收到、真实作业完成不通知"。
  const s = getSession(result.sessionId);
  if (s) {
    if (publicState) {
      try {
        await publicState.attach(new SftpFileService(s.cluster.getSftp(), s.home, s.cluster.exec.bind(s.cluster)), s.home, s.cluster.exec.bind(s.cluster));
        initJobAgentBindings(DATA_ROOT);
        initFormalWorkflowContinuations(DATA_ROOT);
        rebindClusterJobs(result.sessionId, `${credentials.username}@${credentials.host}:${credentials.port}`);
      } catch {
        s.cluster.close(); sessions.delete(result.sessionId);
        res.status(503).json({ success: false, error: '集群用户目录无法读取或持久保存网页数据；请检查权限，未建立网页会话' });
        return;
      }
    }
    // 登录后探测一次该账号所在集群的调度器并打标签（后续不再重复查询）；
    // 探测失败按 none 处理，不阻塞登录。
    try {
      const tag = await resolveAccountScheduler(
        { username: credentials.username, host: credentials.host, port: credentials.port },
        (cmd, timeout) => s.cluster.exec(cmd, timeout),
      );
      s.cluster.scheduler = tag.kind;
      s.cluster.moduleAvailable = tag.hasModule;
      s.cluster.installers = tag.installers;
    } catch { /* 探测失败不阻塞登录 */ }
    restoreFormalWorkflowMonitoring(result.sessionId, s);
    restoreJobAgentBindings(result.sessionId);
    jobWatcher.start(result.sessionId, {
      cluster: { exec: s.cluster.exec.bind(s.cluster) },
      username: credentials.username,
      scheduler: s.cluster.scheduler,
    });
    refreshClusterSkillsInBackground(s.cluster.exec.bind(s.cluster), result.sessionId);
  }
  res.json({
    success: true,
    sessionId: result.sessionId,
    home: result.home,
    scheduler: s?.cluster.scheduler,
    schedulerLabel: s?.cluster.scheduler ? SCHEDULER_LABELS[s.cluster.scheduler] : undefined,
  });
}

app.post('/api/login', async (req, res) => {
  const { host, port, username, password, verificationCode, expectedFingerprint } = req.body || {};
  if (!host || !port || !username || !password) {
    res.status(400).json({ success: false, error: '缺少登录信息' });
    return;
  }
  if (PUBLIC_WORKER && (host !== process.env.TRACE_PUBLIC_SSH_HOST || sessions.size > 0)) {
    res.status(403).json({ success: false, error: '该隔离服务只能连接分配的集群；新连接请从网页登录入口建立' });
    return;
  }
  await handleLogin(req, res, {
    host,
    port: Number(port),
    username,
    password,
    verificationCode: verificationCode || '',
    expectedFingerprint,
  });
});

app.post('/api/desktop/connect', requireDesktopToken, async (req, res) => {
  const { host, port, username, password, verificationCode, expectedFingerprint } = req.body || {};
  if (!host || !port || !username || !password) {
    res.status(400).json({ success: false, error: '缺少连接信息' });
    return;
  }
  await handleLogin(req, res, {
    host,
    port: Number(port),
    username,
    password,
    verificationCode: verificationCode || '',
    expectedFingerprint,
  });
});

/** 手动重探调度器：集群后装了调度系统时用。清标签 → 重新探测 → 同步监控会话。 */
app.post('/api/cluster/scheduler/redetect', async (req, res) => {
  const sessionId = resolveRequestSessionId({
    cookie: (req.session as any)?.sshSessionId,
    header: req.get('X-SSH-Session-Id'),
    auth: undefined,
  }, hasSession);
  const s = sessionId ? getSession(sessionId) : undefined;
  if (!s) {
    res.status(401).json({ success: false, error: '需要活跃的集群会话' });
    return;
  }
  try {
    const key = schedulerTagKey({ username: s.info.username, host: s.info.host, port: s.info.port });
    await clearSchedulerTag(key);
    const tag = await resolveAccountScheduler(
      { username: s.info.username, host: s.info.host, port: s.info.port },
      (cmd, timeout) => s.cluster.exec(cmd, timeout),
    );
    s.cluster.scheduler = tag.kind;
    s.cluster.moduleAvailable = tag.hasModule;
    s.cluster.installers = tag.installers;
    jobWatcher.setScheduler(sessionId, tag.kind);
    res.json({ success: true, scheduler: tag.kind, schedulerLabel: SCHEDULER_LABELS[tag.kind] });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err?.message || String(err) });
  }
});

/**
 * 重建已知但已断开的会话（SSH/SFTP/PTY 全套，保留原 sessionId）。
 * /api/reconnect 与传输引擎的静默保活共用同一实现；并发调用经
 * active.reconnectPromise 去重，同一时刻最多一次握手。
 */
async function reconnectKnownSession(sessionId: string, active: ActiveSession): Promise<void> {
  if (!active.reconnectPromise) {
    const reconnecting = (async () => {
      const inMemory = getTransferCredentials(active.info.host, active.info.port, active.info.username);
      const credentials = buildReconnectCredentials(active.credentials, inMemory, totpNow);
      await active.cluster.connect(credentials, async () => false);
      active.credentials = credentials;
      active.home = await active.cluster.getHomeDirectory();
      // 调度器标签随会话恢复：命中磁盘缓存即可，不再发起 SSH 探测
      if (!active.cluster.scheduler) {
        try {
          const { schedulerTagKey, loadSchedulerTag } = await import('./server/cluster/schedulerProfile');
          const tag = await loadSchedulerTag(schedulerTagKey({
            username: active.info.username,
            host: active.info.host,
            port: active.info.port,
          }));
          if (tag) {
            active.cluster.scheduler = tag.kind;
            active.cluster.moduleAvailable = tag.hasModule;
            active.cluster.installers = tag.installers;
          }
        } catch { /* 无标签时后续流程按全局配置兜底 */ }
      }
      restoreFormalWorkflowMonitoring(sessionId, active);
      restoreJobAgentBindings(sessionId);
      jobWatcher.start(sessionId, {
        cluster: { exec: active.cluster.exec.bind(active.cluster) },
        username: active.info.username,
        scheduler: active.cluster.scheduler,
      });
      refreshClusterSkillsInBackground(active.cluster.exec.bind(active.cluster), sessionId);
    })();
    active.reconnectPromise = reconnecting;
    void reconnecting.finally(() => {
      if (active.reconnectPromise === reconnecting) active.reconnectPromise = undefined;
    }).catch(() => { /* 调用方（路由/保活钩子）拿原始失败 */ });
  }
  await active.reconnectPromise;
}

/**
 * 传输引擎的会话保活钩子：会话在且 connected → true；已知但断开 → 静默重连，
 * 成功 true 失败 false；完全未知的会话（已淘汰/从未存在）→ false。
 */
async function ensureTransferSessionAlive(sessionId: string): Promise<boolean> {
  const active = getKnownSession(sessionId);
  if (!active) return false;
  if (active.cluster.state !== 'connected') {
    try {
      await reconnectKnownSession(sessionId, active);
    } catch {
      return false;
    }
  }
  return active.cluster.state === 'connected';
}

/** 网络中断后保留原 sessionId，重建完整 SSH/SFTP/PTY，而不只是重建 Shell。 */
app.post('/api/reconnect', async (req, res) => {
  const sessionId = String(req.body?.sessionId || req.get('X-SSH-Session-Id') || '');
  const active = getKnownSession(sessionId);
  if (!active) {
    res.status(404).json({ success: false, error: '连接信息已失效，请重新登录该集群' });
    return;
  }
  if (active.cluster.state === 'connected') {
    res.json({ success: true, sessionId, home: active.home });
    return;
  }

  try {
    await reconnectKnownSession(sessionId, active);
    res.json({ success: true, sessionId, home: active.home });
  } catch (error) {
    const detail = formatLoginFailure({ output: error instanceof Error ? error.message : String(error) });
    res.status(401).json({
      success: false,
      error: `${detail}。如该集群要求动态验证码，请确认当前账号已保存对应的 TOTP 秘钥`,
    });
  }
});

app.post('/api/logout', (req, res) => {
  const targetId = typeof req.body?.sessionId === 'string' ? req.body.sessionId
    : req.get('X-SSH-Session-Id') || undefined;

  const closeOne = (id: string | undefined) => {
    if (!id) return;
    jobWatcher.stop(id);
    workflowRunSnapshotCache.delete(id);
    const s = getSession(id);
    if (s) {
      s.cluster.close();
      sessions.delete(id);
    }
  };

  if (targetId) {
    // 关闭单个集群会话（多标签页下"关闭标签"）：其余会话保持连接
    closeOne(targetId);
    const sess = req.session as any;
    if (sess?.sshSessionId === targetId) {
      const remaining = [...sessions.keys()][0];
      if (remaining) sess.sshSessionId = remaining;
      else req.session?.destroy(() => {});
    }
    res.json({ success: true });
    return;
  }

  // 无指定会话：断开全部（旧行为）
  for (const id of [...sessions.keys()]) closeOne(id);
  req.session?.destroy(() => {});
  res.json({ success: true });
});

// ── Static SPA ──────────────────────────────────────────────────────

app.use(express.static(staticPath('dist')));

// ── Modular routes ──────────────────────────────────────────────────

const resolveRemoteFileSession = (sessionId: string | undefined) => {
  const s = getSession(sessionId);
  if (!s) return undefined;
  return {
    cluster: s.cluster,
    home: s.home,
    info: s.info,
  };
};

registerFileRoutes(app, resolveRemoteFileSession);
registerLocalFileRoutes(app);
registerTransferRoutes(app, io, resolveRemoteFileSession, ensureTransferSessionAlive);
registerNotificationRoutes(app, (sessionId) => {
  const s = getSession(sessionId);
  if (!s) return undefined;
  // 会话级调度器(登录探测标签)与账号信息一并下发,供按会话读取/切换;
  // 缺 scheduler 的旧会话由路由层回退全局配置。
  return {
    cluster: { exec: s.cluster.exec.bind(s.cluster), scheduler: s.cluster.scheduler },
    info: { username: s.info.username, host: s.info.host, port: s.info.port },
  };
}, () => [...sessions.values()].map(s => ({
  // 聚合接口（/api/jobs/summary/all）遍历全部会话；connected 过滤在路由内完成
  sessionId: s.id,
  host: s.info.host,
  username: s.info.username,
  state: s.cluster.state,
  cluster: { exec: s.cluster.exec.bind(s.cluster), scheduler: s.cluster.scheduler },
})));
{
  enableRequestedCatalogueCleanup();
  registerWorkflowRoutes(app);
  registerPreflightRoutes(app, (req) => {
    const sessionId = resolveRequestSessionId({
      cookie: (req.session as any)?.sshSessionId,
      header: req.get('X-SSH-Session-Id'),
      auth: undefined,
    }, hasSession);
    const s = sessionId ? getSession(sessionId) : undefined;
    if (!s) return undefined;
    let sftp: { fastPut: (localPath: string, remotePath: string, cb: (err?: Error) => void) => void } | undefined;
    try { sftp = s.cluster.getSftp(); } catch { /* SFTP 未就绪时部署接口单独报 503 */ }
    return { exec: s.cluster.exec.bind(s.cluster), home: s.home, sftp };
  });
  registerWorkflowRunRoutes(app, (req) => {
    const sessionId = resolveRequestSessionId({
      cookie: (req.session as any)?.sshSessionId,
      header: req.get('X-SSH-Session-Id'),
      auth: undefined,
    }, hasSession);
    const s = sessionId ? getSession(sessionId) : undefined;
    if (!s || !sessionId) return undefined;
    let sftp: { fastPut: (localPath: string, remotePath: string, cb: (err?: Error) => void) => void } | undefined;
    try { sftp = s.cluster.getSftp(); } catch { /* SFTP 未就绪时跳过资产自动部署 */ }
    return { sessionId, exec: s.cluster.exec.bind(s.cluster), home: s.home, sftp, scheduler: s.cluster.scheduler };
  }, emitWorkflowRunChanged);
}

// ── 公共生信数据资源（webapis）：目录 / 调用 / 健康检测，仅 loopback ──

registerWebApiRoutes(app);

// ── dsh 引擎桥接路由（dsh 插件经此回调集群执行能力，token 守卫）─────────

if (!IS_COMPETITION_EDITION) {
  registerBridgeRoutes(app, {
    getSession,
    getDshSessionBinding,
    getBridgeToken,
    jobSubmissionGuard,
    onJobsSubmitted: (binding, jobIds) => {
      // Register continuation BEFORE watching: fast jobs can finish on the first poll.
      try {
        if (binding.resume) addBindings(jobIds, { sshSessionId: binding.sshSessionId,
          dshSessionId: binding.dshSessionId, conversationKey: binding.conversationKey, engine: 'dsh',
          workspace: binding.workspaceRoot, confirmationPolicy: binding.confirmationPolicy,
          ...binding.resume });
      } finally { jobWatcher.trackJobs(binding.sshSessionId, jobIds); }
    },
  });
}

// ── Skill routes ────────────────────────────────────────────────────

function loadSkillIndex() {
  return loadOrRefreshSkillIndex({
    skillsDir: APP_SKILLS_DIR,
    lsfSkillDir: LSF_SKILLS_DIR,
    donauSkillDir: DONAU_SKILLS_DIR,
    userSkillsDir: USER_SKILLS_DIR,
    indexPath: path.join(USER_SKILLS_DIR, '.skill-index.json'),
  });
}

/** 本地技能索引 + 已缓存的远程技能。普通页面请求绝不触发 SSH 文件扫描。 */
async function loadSkillIndexForRequest(req: Request) {
  const sessionId = resolveRequestSessionId({
    cookie: (req.session as any)?.sshSessionId,
    header: req.get('X-SSH-Session-Id'),
    auth: undefined,
  }, hasSession);
  const session = sessionId ? getSession(sessionId) : undefined;
  if (sessionId && session) refreshClusterSkillsInBackground(session.cluster.exec.bind(session.cluster), sessionId);
  const clusterSkills = sessionId ? getCachedClusterSkills(sessionId) : [];
  return loadOrRefreshSkillIndex({
    skillsDir: APP_SKILLS_DIR,
    lsfSkillDir: LSF_SKILLS_DIR,
    donauSkillDir: DONAU_SKILLS_DIR,
    userSkillsDir: USER_SKILLS_DIR,
    indexPath: path.join(USER_SKILLS_DIR, '.skill-index.json'),
    clusterSkills,
  });
}

app.get('/api/skills', async (req, res) => {
  try {
    const index = await loadSkillIndexForRequest(req);
    const skills = index.skills.map((s) => ({
      filename: s.filename,
      name: s.name,
      description: s.description,
      category: s.category,
      size: s.size,
      source: s.source,
    }));
    res.json({ success: true, skills });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message || String(err) });
  }
});

// 列表不再一次传输约 40MB 技能正文；仅在用户展开某一项时按需读取。
app.get('/api/skills/content', (req, res) => {
  try {
    const filename = String(req.query.filename || '');
    if (!filename) {
      res.status(400).json({ success: false, error: '缺少技能名称' });
      return;
    }
    const sessionId = resolveRequestSessionId({
      cookie: (req.session as any)?.sshSessionId,
      header: req.get('X-SSH-Session-Id'),
      auth: undefined,
    }, hasSession);
    const clusterSkills = sessionId ? getCachedClusterSkills(sessionId) : [];
    const index = loadOrRefreshSkillIndex({
      skillsDir: APP_SKILLS_DIR,
      lsfSkillDir: LSF_SKILLS_DIR,
      donauSkillDir: DONAU_SKILLS_DIR,
      userSkillsDir: USER_SKILLS_DIR,
      indexPath: path.join(USER_SKILLS_DIR, '.skill-index.json'),
      clusterSkills,
    });
    const skill = index.skills.find(item => item.filename === filename);
    if (!skill) {
      res.status(404).json({ success: false, error: '技能不存在或远程技能缓存尚未就绪' });
      return;
    }
    res.json({ success: true, filename: skill.filename, content: skill.content });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message || String(err) });
  }
});

app.post('/api/skills', async (req, res) => {
  try {
    const { filename, content } = req.body || {};
    if (typeof filename !== 'string' || typeof content !== 'string') {
      res.status(400).json({ success: false, error: '缺少 filename 或 content' });
      return;
    }
    const ok = await installSkillFromSource(
      { type: 'local', filename, content },
      { skillsDir: APP_SKILLS_DIR, lsfSkillDir: LSF_SKILLS_DIR, donauSkillDir: DONAU_SKILLS_DIR, userSkillsDir: USER_SKILLS_DIR },
    );
    res.json({ success: ok });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message || String(err) });
  }
});

app.get('/api/skills/search', async (req, res) => {
  try {
    const q = String(req.query.q || '');
    if (!q) {
      res.json({ success: true, results: [] });
      return;
    }
    const index = await loadSkillIndexForRequest(req);
    const matches = searchSkillIndex(index, q, 8);
    const results = matches.map((m) => {
      const excerpt = (m.excerpt || m.content || '').slice(0, 1500);
      return `- **${m.name || m.filename}**: ${m.description || ''}\n  \`\`\`\n${excerpt}\n  \`\`\``;
    });
    res.json({ success: true, results });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message || String(err) });
  }
});

// ── Conversation routes（本地权威存档，可选同步到集群）──────────────
// 对话不再依附 SSH 会话：无集群模式也能创建、读取和自动保存。连接集群后，
// 首次空库会非破坏性导入旧的 ~/trace_conversations，用户也可主动同步副本。

interface ConversationRecord {
  id: string;
  contextKey?: string;
  /** 对话归属的计算目标：'local-workbench' 或集群 sessionId；旧记录缺省按本地处理。 */
  scopeKey?: string;
  title: string;
  messages: AIMessage[];
  summary?: string;
  memory?: string;
  skillHints?: string[];
  structuredMemory?: StructuredMemory;
  createdAt: number;
  updatedAt: number;
}

function clusterConversationStoreFor(req: Request): ClusterConversationStore | undefined {
  const sessionId = resolveRequestSessionId({
    cookie: (req.session as any)?.sshSessionId,
    header: req.get('X-SSH-Session-Id'),
    auth: undefined,
  }, id => sessions.has(id));
  const s = sessionId ? getSession(sessionId) : undefined;
  if (!s) return undefined;
  return new ClusterConversationStore(
    new SftpFileService(s.cluster.getSftp(), s.home, s.cluster.exec.bind(s.cluster)),
    s.home,
  );
}

/** 对话读写的统一形状：本地库与集群远程库同构。 */
type AnyConversationStore = Pick<LocalConversationStore, 'list' | 'get' | 'save' | 'remove'>;

/** 对话归属的计算目标：优先取请求体/查询里的 scopeKey，其次 X-SSH-Session-Id 头。 */
function conversationScopeKey(req: Request): string {
  const raw = (req.body?.scopeKey ?? req.query.scope ?? req.headers['x-ssh-session-id'] ?? '') as string;
  const value = String(raw).trim();
  if (!value || value.length > 200 || /[\r\n\0]/.test(value)) return PUBLIC_WORKER
    ? String((req.session as any)?.sshSessionId || req.get('X-SSH-Session-Id') || '') : 'local-workbench';
  return value;
}

/**
 * 对话按计算目标物理分存：
 * - 本地工作台 → 本机数据目录（LocalConversationStore）；
 * - 集群目标且会话在线 → 写入该集群的 ~/trace_conversations（ClusterConversationStore），
 *   本地不再留副本，换机登录同一集群也能看到同样的对话；
 * - 集群目标但会话不在线 → 返回 null（调用方按"未连接"回应，不悄悄落到本地）。
 */
function conversationStoreFor(req: Request): AnyConversationStore | null {
  const scope = conversationScopeKey(req);
  if (scope === 'local-workbench') return PUBLIC_WORKER ? null : localConversationStore;
  const sessionId = hasSession(scope) ? scope : undefined;
  const s = sessionId ? getSession(sessionId) : undefined;
  if (!s) return null;
  return new ClusterConversationStore(
    new SftpFileService(s.cluster.getSftp(), s.home, s.cluster.exec.bind(s.cluster)),
    s.home,
  );
}

function enrichConversation(record: ConversationRecord): ConversationRecord {
  const enriched = mergeConversationMemory(record);
  return {
    ...record,
    summary: enriched.summary,
    memory: enriched.memory,
    skillHints: enriched.skillHints,
    updatedAt: Date.now(),
  };
}

/** 空的本地库首次连接旧集群时导入远程记录；不删除远程副本。 */
async function importClusterConversations(req: Request): Promise<void> {
  const clusterStore = clusterConversationStoreFor(req);
  if (!clusterStore) return;
  for (const summary of await clusterStore.list()) {
    try {
      if (await localConversationStore.get(summary.id)) continue;
      const record = await clusterStore.get(summary.id);
      if (record) await localConversationStore.save(record);
    } catch { /* 单条旧记录导入失败不阻塞其他记录 */ }
  }
}

app.post('/api/conversations', async (req, res) => {
  const store = conversationStoreFor(req);
  if (!store) {
    res.status(409).json({ success: false, error: '目标集群当前未连接，对话无法写入；请重新连接后再试' });
    return;
  }
  try {
    const { title, messages, clusterInfo, contextKey } = req.body || {};
    const id = createSessionId();
    const record = enrichConversation({
      id,
      contextKey: normalizeConversationContextKey(contextKey, `saved-${id}`),
      scopeKey: conversationScopeKey(req),
      title: title || '新对话',
      messages: Array.isArray(messages) ? messages : [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    await store.save(record);
    res.json({ success: true, conversation: { ...record, summary: record.summary || '', clusterInfo } });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message || String(err) });
  }
});

// 集群对话列表/导回：必须在 /api/conversations/:id 之前注册，
// 否则 GET /api/conversations/cluster 的 'cluster' 会被当成对话 id 匹配。
registerClusterConversationRoutes(app, {
  clusterConversationStoreFor,
  localStore: localConversationStore,
});

// 对话列表（摘要，不含消息体）——前端 ConversationList 依赖此路由；
// 缺失时会落到 SPA fallback 返回 index.html，导致前端 JSON 解析报错"加载失败"
// ?scope=<sessionId|local-workbench> 只读该计算目标的对话：
// 本地读本机库（旧记录无 scopeKey 归入本地工作台）；集群读该集群的远程库；
// 集群不在线时返回 connected:false + 空列表，不回退到本地（物理分离不混淆）
app.get('/api/conversations', async (req, res) => {
  const scope = typeof req.query.scope === 'string' ? req.query.scope : '';
  const store = conversationStoreFor(req);
  if (!store) {
    res.json({ success: true, connected: false, conversations: [] });
    return;
  }
  try {
    let conversations = await store.list();
    if (!PUBLIC_WORKER && conversations.length === 0 && (!scope || scope === 'local-workbench')) {
      // 仅本地工作台保留旧版本"首次连接旧集群导入远程记录"的迁移行为
      await importClusterConversations(req);
      conversations = await store.list();
    }
    if (!PUBLIC_WORKER && (scope === 'local-workbench' || !scope)) {
      conversations = filterConversationsByScope(conversations, 'local-workbench');
    }
    res.json({ success: true, conversations });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message || String(err) });
  }
});

// 聚合对话列表(v0.5.2+):本地工作台 + 所有已连接集群,每条标注来源(用户曾反馈
// "按流程跑完,对话记录里看不到最新对话"——列表按活跃 tab 过滤,集群对话在别的
// 作用域里不可见)。单集群读取失败只跳过该集群,不影响整体。必须在 :id 之前注册。
app.get('/api/conversations/all', async (_req, res) => {
  try {
    const sources: AggregatedConversationSource[] = [];
    if (!PUBLIC_WORKER) {
      try {
        const localList = await localConversationStore.list();
        sources.push({ originSessionId: 'local-workbench', clusterLabel: '', origin: 'local', list: localList as never });
      } catch { /* 本地库读取失败不阻塞集群部分 */ }
    }
    const jobs: Promise<void>[] = [];
    for (const [sessionId, s] of sessions) {
      if (s.cluster.state !== 'connected') continue;
      jobs.push((async () => {
        let list: Awaited<ReturnType<ClusterConversationStore['list']>> | null = null;
        try {
          const store = new ClusterConversationStore(
            new SftpFileService(s.cluster.getSftp(), s.home, s.cluster.exec.bind(s.cluster)),
            s.home,
          );
          list = await Promise.race([
            store.list(),
            new Promise<never>((_, reject) => setTimeout(() => reject(new Error('cluster conversation list timeout')), 20_000)),
          ]);
        } catch { /* 单集群失败降级跳过 */ }
        if (!list) return;
        sources.push({
          originSessionId: sessionId,
          clusterLabel: `${s.info.username}@${s.info.host}`,
          origin: 'cluster',
          list: list as never,
        });
      })());
    }
    await Promise.all(jobs);
    const out = aggregateConversationLists(sources);
    res.json({ success: true, conversations: out });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message || String(err) });
  }
});

app.get('/api/conversations/:id', async (req, res) => {
  const store = conversationStoreFor(req);
  if (!store) {
    res.status(409).json({ success: false, error: '目标集群当前未连接，无法读取该对话' });
    return;
  }
  try {
    const record = await store.get(String(req.params.id));
    if (!record) {
      res.status(404).json({ success: false, error: '对话不存在' });
      return;
    }
    res.json({ success: true, conversation: record });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message || String(err) });
  }
});

app.delete('/api/conversations/:id', async (req, res) => {
  const store = conversationStoreFor(req);
  if (!store) {
    res.status(409).json({ success: false, error: '目标集群当前未连接，无法删除该对话' });
    return;
  }
  try {
    await store.remove(String(req.params.id));
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message || String(err) });
  }
});

app.put('/api/conversations/:id', async (req, res) => {
  const store = conversationStoreFor(req);
  if (!store) {
    res.status(409).json({ success: false, error: '目标集群当前未连接，无法保存该对话' });
    return;
  }
  try {
    const existing = await store.get(String(req.params.id));
    const { title, messages, contextKey } = req.body || {};
    if (!existing && (!Array.isArray(messages) || messages.length === 0)) {
      res.status(404).json({ success: false, error: '对话不存在，恢复保存需要完整消息快照' });
      return;
    }
    const now = Date.now();
    // Auto-save is deliberately idempotent. A prior version could retain an
    // activeConversationId after the backing cluster file was moved, an index
    // was rebuilt, or the target reconnected; returning 404 then made every
    // subsequent save fail forever. Recreate the same safe id from the latest
    // in-memory snapshot instead of requiring manual conversation recovery.
    const record = enrichConversation({
      ...(existing as ConversationRecord | undefined),
      id: String(req.params.id),
      contextKey: (existing as ConversationRecord | undefined)?.contextKey
        || normalizeConversationContextKey(contextKey, `saved-${req.params.id}`),
      // 旧记录没有 scopeKey：首次保存时按当前请求的计算目标补齐
      scopeKey: (existing as ConversationRecord | undefined)?.scopeKey || conversationScopeKey(req),
      title: title || (existing as ConversationRecord | undefined)?.title || '新对话',
      messages: Array.isArray(messages) ? messages : ((existing as ConversationRecord | undefined)?.messages || []),
      createdAt: (existing as ConversationRecord | undefined)?.createdAt || now,
      updatedAt: now,
    });
    await store.save(record);
    res.json({
      success: true,
      conversation: {
        ...record,
        summary: record.summary || '',
      },
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message || String(err) });
  }
});

app.post('/api/conversations/:id/sync', async (req, res) => {
  const clusterStore = clusterConversationStoreFor(req);
  if (!clusterStore) {
    res.status(401).json({ success: false, error: '同步到集群需要活跃的 SSH 会话' });
    return;
  }
  try {
    const record = await localConversationStore.get(String(req.params.id));
    if (!record) {
      res.status(404).json({ success: false, error: '对话不存在' });
      return;
    }
    await clusterStore.save(record);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message || String(err) });
  }
});

// ── AI streaming ────────────────────────────────────────────────────

async function buildClusterSnapshot(sessionId: string, timeoutMs = 2_500) {
  const s = getSession(sessionId);
  if (!s) return undefined;
  try {
    const cmd = clusterContext.buildSnapshotCommand('standard', s.cluster.scheduler);
    const output = await s.cluster.exec(cmd, timeoutMs);
    const snapshot = clusterContext.parse(output, s.cluster.scheduler);
    clusterContext.setCache(sessionId, snapshot);
    return snapshot;
  } catch {
    return undefined;
  }
}

const clusterSnapshotRefreshes = new Map<string, Promise<void>>();

/**
 * AI 请求只读取已有快照；远程采集始终在后台、单会话去重且有 2.5s 硬预算。
 * 共享文件系统、quota 或调度器变慢时，不再阻塞 SSE 心跳和模型首包。
 */
function getClusterSnapshotForAi(sessionId: string) {
  const cached = clusterContext.getCached(sessionId) ?? undefined;
  if (!cached && !clusterSnapshotRefreshes.has(sessionId)) {
    const startedAt = Date.now();
    const pending = buildClusterSnapshot(sessionId)
      .then(snapshot => {
        console.log(
          '[AI context] background cluster snapshot %s in %dms',
          snapshot ? 'ready' : 'skipped',
          Date.now() - startedAt,
        );
      })
      .finally(() => clusterSnapshotRefreshes.delete(sessionId));
    clusterSnapshotRefreshes.set(sessionId, pending);
  }
  return cached;
}

// 前端保存 AI 设置时同步到服务端共享配置（QQ 机器人等复用）
app.post('/api/ai-profile', (req, res) => {
  try {
    saveServerAiProfile(profileFromBody(req.body || {}));
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message || String(err) });
  }
});

app.get('/api/public/profile', (_req, res) => {
  if (!PUBLIC_WORKER) { res.sendStatus(404); return; }
  let preferences = {};
  try { preferences = JSON.parse(fs.readFileSync(dataPath('browser-preferences.json'), 'utf8')); } catch {}
  res.json({ profile: loadServerAiProfile() || null, preferences });
});

app.put('/api/public/preferences', (req, res) => {
  if (!PUBLIC_WORKER) { res.sendStatus(404); return; }
  const { key, value } = req.body || {};
  if (typeof key !== 'string' || !/^(?:trace_agent_settings|trace-confirm-mode|trace_cmd_history|trace_workflow_(?:run_config|habits)_v1:[\w.-]{1,180})$/.test(key)
    || typeof value !== 'string' || Buffer.byteLength(value) > 256 * 1024) {
    res.status(400).json({ error: '无效的网页偏好设置' }); return;
  }
  let preferences: Record<string, string> = {};
  try { preferences = JSON.parse(fs.readFileSync(dataPath('browser-preferences.json'), 'utf8')); } catch {}
  preferences[key] = value;
  fs.writeFileSync(dataPath('browser-preferences.json'), JSON.stringify(preferences), { mode: 0o600 });
  res.json({ success: true });
});

app.get('/api/public/session', (req, res) => {
  const s = PUBLIC_WORKER && getSession(req.get('X-SSH-Session-Id'));
  if (!s) { res.sendStatus(401); return; }
  res.json({ home: s.home });
});

app.post('/api/public/upload', async (req, res) => {
  if (!PUBLIC_WORKER) { res.sendStatus(404); return; }
  const s = getSession(req.get('X-SSH-Session-Id'));
  if (!s) { res.sendStatus(401); return; }
  let temporary: string | undefined;
  try {
    const destination = assertSafeRemoteMutation(String(req.query.path || ''), s.home);
    const sftp = s.cluster.getSftp();
    const service = new SftpFileService(sftp, s.home, s.cluster.exec.bind(s.cluster));
    const exists = await service.stat(destination).then(() => true, error => {
      if (error.code === 2 || error.code === 'ENOENT') return false; throw error;
    });
    if (exists && req.query.replace !== '1') { res.status(409).json({ error: '集群已存在该文件；需要明确确认替换' }); return; }
    temporary = `${destination}.trace-upload-${createSessionId()}`;
    await pipeline(req, sftp.createWriteStream(temporary, { flags: 'wx', mode: 0o600 }));
    const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
    await s.cluster.exec(`mv ${req.query.replace === '1' ? '-f' : '-n'} -- ${quote(temporary)} ${quote(destination)}`, 15000);
    const remains = await service.stat(temporary).then(() => true, () => false);
    if (remains) throw new Error('上传期间目标文件被其他会话创建，未覆盖；请重新检查');
    temporary = undefined;
    res.json({ success: true, path: destination });
  } catch (error) {
    if (!res.destroyed) res.status(400).json({ success: false, error: error instanceof Error ? error.message : '上传失败' });
  } finally {
    if (temporary) await new SftpFileService(s.cluster.getSftp(), s.home, s.cluster.exec.bind(s.cluster)).remove(temporary, false).catch(() => {});
  }
});

// 非流式 AI 网关：一次性补全 / 终端命令自动补全 / 选中输出分析。
// 补全只读集群快照缓存（不远程采集），路径建议零延迟。
registerGatewayRoutes(app, {
  resolveSnapshot: (req) => {
    const sid = resolveRequestSessionId({
      cookie: (req.session as any)?.sshSessionId,
      header: req.get('X-SSH-Session-Id'),
      auth: undefined,
    }, hasSession);
    return sid ? clusterContext.getCached(sid) : null;
  },
});

app.post('/api/ai/stream', async (req, res) => {
  if (PUBLIC_WORKER && !getSession(req.get('X-SSH-Session-Id'))) {
    res.status(401).json({ error: '请先连接自己的集群，公共网页没有本地执行模式' });
    return;
  }
  const profile = profileFromBody(req.body);
  if (!profile.apiKey) {
    res.status(400).json({ error: 'Missing API Key' });
    return;
  }
  // 同步到服务端共享配置（QQ 机器人等复用同一份 AI 设置）
  saveServerAiProfile(profile);
  // 长对话自动压缩的执行器：复用本次请求的供应商配置，仅在实际触发压缩时调用。
  const compactionSummarizer = createAiCompactionSummarizer(profile);

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const heartbeat = setInterval(() => {
    if (!res.writableEnded && !res.destroyed) res.write(': heartbeat\n\n');
  }, 15_000);

  const sessionId = resolveRequestSessionId({
    cookie: (req.session as any)?.sshSessionId,
    header: req.get('X-SSH-Session-Id'),
    auth: undefined,
  }, hasSession);
  // 快速模式已移除：旧客户端无论传什么 mode/isFastMode，统一按 agent 处理（不 400）。
  const mode = 'agent';
  const s = getSession(sessionId);
  if (s && sessionId) refreshClusterSkillsInBackground(s.cluster.exec.bind(s.cluster), sessionId);
  const aiRequestId = createSessionId();
  const aiStartedAt = Date.now();
  const requestLocale: 'zh-CN' | 'en-US' = req.body?.locale === 'en-US' ? 'en-US' : 'zh-CN';
  const requestAbort = new AbortController();
  let terminalEvent = 'none';
  // 登记在途运行：对话带 conversationId 时，客户端断连不再杀任务——
  // 服务端转入后台继续跑（detached），终态回写对话存档并通知；
  // 无 conversationId 的运行（QQ 机器人等）保持断连即中止的旧语义。
  const runConversationId = typeof req.body?.conversationId === 'string' && req.body.conversationId ? req.body.conversationId : undefined;
  const existingConversationRun = runConversationId
    ? findActiveRunByConversation(runConversationId)
    : undefined;
  if (existingConversationRun) {
    clearInterval(heartbeat);
    res.write(`data: ${JSON.stringify({
      type: 'error',
      code: 'already_running',
      requestId: existingConversationRun.requestId,
      error: requestLocale === 'en-US' ? 'An agent is already running in this conversation. A duplicate executor was prevented; the existing task continues in the background.' : '这个对话已有 Agent 正在执行。已阻止第二个执行器启动；原任务仍在后台继续，请稍后查看实时进度。',
    })}\n\n`);
    res.end();
    return;
  }
  const activeRun = registerActiveRun({
    requestId: aiRequestId,
    conversationId: runConversationId,
    sessionId: sessionId ?? undefined,
    abort: requestAbort,
  });
  const onResponseClose = () => {
    if (terminalEvent === 'none' && runConversationId) {
      markRunDetached(activeRun);
      console.warn('[AI:%s] client detached after %dms; run continues in background', aiRequestId, Date.now() - aiStartedAt);
      return;
    }
    if (!res.writableEnded) {
      console.warn('[AI:%s] client stream closed after %dms', aiRequestId, Date.now() - aiStartedAt);
    }
    requestAbort.abort();
  };
  res.once('close', onResponseClose);

  let deferredPublicDone: any;
  const turnClock = new AgentTurnClock();
  let requestWatchdog: ReturnType<typeof createRequestWatchdog> | undefined;
  let armRequestWatchdog = () => {};
  const deliver = (event: any) => {
    pushRunEvent(activeRun, event);
    if (!res.writableEnded && !res.destroyed) {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    }
  };
  const send = (event: any) => {
    turnClock.observe(event);
    armRequestWatchdog();
    if (PUBLIC_WORKER && event?.type === 'done') { deferredPublicDone = event; return; }
    deliver(event);
  };
  console.log(
    '[AI:%s] request start mode=%s provider=%s model=%s session=%s',
    aiRequestId,
    mode,
    profile.provider,
    profile.model,
    sessionId ? 'connected' : 'none',
  );
  send({ type: 'status', phase: 'preparing', message: requestLocale === 'en-US' ? 'Preparing the conversation, cluster context and relevant skills…' : '正在整理对话、集群环境和相关技能…', requestId: aiRequestId });

  // 防止模型供应商或工具等待永不收尾。看门狗必须独立关闭 SSE，
  // 不能把收尾寄托在供应商是否正确响应 AbortSignal。
  // 收敛为单一 agent 模式后统一 15 分钟硬上限；Agent（尤其正式流程）允许
  // 在同一 SSE 请求中跨步骤续跑。供应商静默仍由更短的首包/空闲看门狗处理。
  const requestHardLimitMs = 15 * 60_000;
  const maxRequestWallMs = 45 * 60_000;
  const onRequestTimeout = () => {
    terminalEvent = 'watchdog';
    const diagnostics = turnClock.snapshot();
    const stages: Record<string, string> = { preparing: '准备上下文/引擎', requesting: '等待模型响应', waiting_tool: '等待工具返回', waiting_model: '等待模型接续', generating: '模型生成', waiting_user: '等待用户回答', waiting_approval: '等待用户审批', resuming: '恢复原任务', reconnecting: '恢复引擎连接' };
    const detail = requestLocale === 'en-US'
      ? `Stage: ${diagnostics.stage}; last tool: ${diagnostics.lastTool || 'none'}; stage duration: ${Math.round(diagnostics.stageMs / 1000)}s; no event for ${Math.round(diagnostics.lastEventAgeMs / 1000)}s.`
      : `最后阶段：${stages[diagnostics.stage] || diagnostics.stage}；最后工具：${diagnostics.lastTool || '无'}；该阶段持续 ${Math.round(diagnostics.stageMs / 1000)} 秒，最近 ${Math.round(diagnostics.lastEventAgeMs / 1000)} 秒无新事件。`;
    const limit = diagnostics.wallMs >= maxRequestWallMs ? '45-minute total safety limit' : '15-minute active-execution limit (human waits excluded)';
    console.error('[AI:%s] execution watchdog: %s', aiRequestId, JSON.stringify(diagnostics));
    send({
      type: 'error',
      error: requestLocale === 'en-US' ? `This Agent turn reached the ${limit} and is paused. ${detail} SSH stays connected; submitted jobs remain monitored. Outputs are unverified.`
        : `AI 本轮已达${diagnostics.wallMs >= maxRequestWallMs ? '45 分钟总安全时限' : '15 分钟有效执行上限（不含等待回答/审批）'}，已暂停。${detail} 集群 SSH 未因此断开，已提交作业仍由后台监控；产物尚未核验。`,
      timeoutDiagnostics: diagnostics,
      requestId: aiRequestId,
    });
    requestAbort.abort();
    if (!res.writableEnded && !res.destroyed) res.end();
  };
  requestWatchdog = createRequestWatchdog({ clock: turnClock, signal: requestAbort.signal,
    getTerminalEvent: () => terminalEvent, onTimeout: onRequestTimeout,
    activeLimitMs: requestHardLimitMs, wallLimitMs: maxRequestWallMs });
  armRequestWatchdog = requestWatchdog.arm;
  armRequestWatchdog();

  // 轮末未消费的插话：先从队列取出（done/error 前随 SSE 通知前端），
  // detached 运行时再由收尾块追加进对话存档，保证一条都不丢。
  let unconsumedSteers: string[] = [];
  const drainSteers = (): string[] => {
    const texts = steerQueue.drain(aiRequestId);
    if (!texts.length) return unconsumedSteers;
    unconsumedSteers = texts;
    send({ type: 'steer_unconsumed', texts, requestId: aiRequestId });
    return texts;
  };

  try {
      const rawMessages: AIMessage[] = messagesFromBody(req.body);
      const languageInstruction: AIMessage = {
        role: 'system',
        content: requestLocale === 'en-US'
          ? 'Use English for all user-facing text. Keep commands, paths, filenames, raw tool output, and scientific identifiers unchanged.'
          : '面向用户的内容使用中文。命令、路径、目录名、文件名、工具原始输出和科学标识符必须逐字原样引用，禁止翻译或改写。',
      };
      const query = [...rawMessages].reverse().find((m) => m.role === 'user')?.content || '';
      // 0.2.9 的 dsh 映射按 SSH 会话复用，表面上“记得更多”，但会让不同
      // 对话串线。现在保持每个对话独立，同时从该对话的本地权威存档恢复
      // 长期记忆；旧记录没有 structuredMemory 时在读取时无损补齐。
      const requestedConversationId = typeof req.body?.conversationId === 'string'
        ? req.body.conversationId
        : undefined;
      let persistedConversationMemory = mergeConversationMemory({
        messages: rawMessages,
      } as ConversationWithMemory);
      if (requestedConversationId) {
        const persisted = await (PUBLIC_WORKER ? conversationStoreFor(req)?.get(requestedConversationId) : localConversationStore.get(requestedConversationId));
        if (persisted) {
          persistedConversationMemory = mergeConversationMemory({
            ...persisted,
            messages: messagesFromBody(persisted),
          } as ConversationWithMemory);
        }
      }
      const effectiveConversationSummary = persistedConversationMemory.memory
        || (typeof req.body?.summary === 'string' ? req.body.summary : undefined);
      // 正式流程上下文有独立的结构化请求字段，不再依赖最近聊天窗口里是否还留着
      // 最初那条 marker。旧客户端仍可从消息 marker 向后兼容恢复。
      let workflowRunContext = normalizeWorkflowExecutionContext(req.body?.workflowRunContext)
        || findLatestWorkflowExecutionContext(rawMessages);
      // 用户直接把 RUN 目录路径贴进普通对话询问（无 marker、无绑定字段）时，从路径恢复绑定：
      // 读 run.json 拿 workflowId/runId，本轮按流程会话处理（只读问答或执行器），
      // 避免落入通用 Agent 的 set_plan 门槛、重复造计划、把旧提交回执当新作业。
      if (!workflowRunContext && s) {
        const pathHit = extractRunDirFromText(
          `${query}\n${rawMessages.slice(-3).map(m => m.content).join('\n')}`,
        );
        if (pathHit) {
          try {
            const raw = await s.cluster.exec(`cat '${pathHit.replace(/'/g, `'\\''`)}'/run.json`, 15_000);
            const parsed = JSON.parse(raw);
            if (parsed?.workflowId && parsed?.runId) {
              workflowRunContext = normalizeWorkflowExecutionContext({
                workflowId: String(parsed.workflowId),
                runId: String(parsed.runId),
                runDir: pathHit,
                policy: 'isolated-run-v1',
              });
              if (workflowRunContext) {
                console.log('[AI:%s] recovered workflow run binding from pasted path: %s', aiRequestId, pathHit);
              }
            }
          } catch { /* 读不到 run.json 就不绑定，走通用 Agent */ }
        }
      }
      let workflowStartIndex = -1;
      if (workflowRunContext) {
        for (let index = rawMessages.length - 1; index >= 0; index -= 1) {
          if (parseWorkflowExecutionContext(rawMessages[index].content)?.runDir === workflowRunContext.runDir) {
            workflowStartIndex = index;
            break;
          }
        }
      }
      const contextMessages = workflowStartIndex >= 0
        ? rawMessages.slice(workflowStartIndex).slice(-16)
        : rawMessages;
    console.log(
      '[AI:%s] input messages=%d chars=%d',
      aiRequestId,
      rawMessages.length,
      rawMessages.reduce((sum, item) => sum + item.content.length, 0),
    );

    // ── dsh 引擎分支 ────────────────────────────────────────────────
    // agent 模式且路由判定为 dsh 时，由 dsh sidecar 接管本轮对话；
    // 事件经翻译层发出与内置引擎完全相同的 SSE 形状，前端无感知。
    // 引擎不可用（dsh 未安装/启动失败）时返回 'fallback'，落回内置引擎。
    let handledByDsh = false;
    const dshDecision = selectDshEngine({
      envEngine: IS_COMPETITION_EDITION || PUBLIC_WORKER ? 'legacy' : process.env.TRACE_AI_ENGINE,
      mode,
      hasWorkflowRunContext: Boolean(workflowRunContext),
      provider: profile.provider,
      requestedEngine: PUBLIC_WORKER ? 'native' : req.body?.agentConfig?.engine,
    });
    if (dshDecision.engine === 'legacy') {
      send({
        type: 'status',
        phase: 'preparing',
        message: workflowRunContext ? '结构化流程使用 TRACE 原生智能体…' : '正在接入 TRACE 原生智能体…',
        requestId: aiRequestId,
      });
    }
    if (dshDecision.engine === 'dsh') {
      console.log('[AI:%s] engine=dsh reason=%s', aiRequestId, dshDecision.reason);
      send({ type: 'status', phase: 'preparing', message: requestLocale === 'en-US' ? 'Connecting to the DSH engine…' : '正在接入 dsh 引擎…', requestId: aiRequestId });
      const dshConfirmIds = new Set<string>();
      const dshQuestionIds = new Set<string>();
      // 用户在前端选择的本地工作区（无效则忽略，dsh 会话回退 DATA_ROOT）
      const workspace = normalizeWorkspace(req.body?.workspace);
      if (req.body?.workspace && !workspace) {
        console.warn('[AI:%s] workspace 无效已忽略: %s', aiRequestId, String(req.body.workspace).slice(0, 200));
      }
      try {
        const outcome = await runDshAgent({
          send: (evt: any) => {
            if (evt?.type === 'done' || evt?.type === 'error') terminalEvent = evt.type;
            send(evt);
          },
          requestAbort: requestAbort.signal,
          requestId: aiRequestId,
          profile: {
            provider: profile.provider,
            model: profile.model,
            apiKey: profile.apiKey,
            baseUrl: profile.baseUrl,
          },
          userText: query,
          summary: effectiveConversationSummary,
          recentMessages: rawMessages.slice(-12),
          locale: requestLocale,
          sshSessionId: sessionId ?? undefined,
          workspace,
          conversationId: typeof req.body?.conversationId === 'string' ? req.body.conversationId : undefined,
          // dsh persists its own history. Scope that mapping to one TRACE
          // conversation instead of the whole SSH session, otherwise separate
          // sidebar chats silently share context.
          conversationKey: buildDshConversationKey({
            sshSessionId: sessionId || undefined,
            conversationContextId: req.body?.conversationContextId,
            conversationId: req.body?.conversationId,
            requestId: aiRequestId,
          }),
          confirmationPolicy: req.body?.agentConfig?.confirmationPolicy,
          dataRoot: dataPath(''),
          pluginSourceDir: appPath('vendor', 'dsh-plugin'),
          skillDirs: [APP_SKILLS_DIR, USER_SKILLS_DIR, LSF_SKILLS_DIR, DONAU_SKILLS_DIR, path.join(APP_SKILLS_DIR, 'bio'), path.join(APP_SKILLS_DIR, 'hpc')],
          onJobsSubmitted: jobIds => {
            if (sessionId) jobWatcher.trackJobs(sessionId, jobIds);
          },
          onConfirm: ({ command, risk }) => {
            const id = `confirm-${createSessionId()}`;
            dshConfirmIds.add(id);
            return pendingAiConfirmations.request({ id, command, risk, send, requestId: aiRequestId,
              signal: requestAbort.signal, title: requestLocale === 'en-US' ? 'Agent requests permission to run a command' : 'Agent 请求执行命令' });
          },
          onQuestion: async ({ questions }) => {
            const answers: Array<{ id: string; selected: string[]; custom?: string; intent?: 'clarification' }> = [];
            for (const question of questions) {
              const id = `question-${createSessionId()}`;
              dshQuestionIds.add(id);
              const labels = Array.isArray(question.options)
                ? question.options.map(option => String(option?.label || '').trim()).filter(Boolean)
                : [];
              const prompt = [question.header, question.question, question.detail]
                .map(value => typeof value === 'string' ? value.trim() : '')
                .filter(Boolean)
                .join('\n');
              const answer = await pendingAiQuestions.request({ id, signal: requestAbort.signal, send, requestId: aiRequestId,
                question: prompt || (requestLocale === 'en-US' ? 'Please provide the information required for this task.' : '请补充本次任务所需信息。'),
                options: labels.map(label => ({ label, description: question.options?.find(option => option.label === label)?.description })),
                multiSelect: question.multiSelect === true });
              dshQuestionIds.delete(id);
              if (answer === null) return null;
              answers.push({
                id: String(question.id || ''),
                ...answer,
              });
            }
            return { answers };
          },
        });
        handledByDsh = outcome === 'completed';
        if (!handledByDsh) {
          console.warn('[AI:%s] dsh engine unavailable, falling back to legacy', aiRequestId);
          send({ type: 'status', phase: 'preparing', message: requestLocale === 'en-US' ? 'DSH is unavailable; switching to the built-in engine…' : 'dsh 引擎不可用，已回退内置引擎…', requestId: aiRequestId });
        }
      } finally {
        for (const id of dshConfirmIds) {
          pendingAiConfirmations.cancel(id);
        }
        for (const id of dshQuestionIds) {
          pendingAiQuestions.cancel(id);
        }
      }
    }

    if (handledByDsh) {
      // dsh 引擎已处理本轮请求（done/error 事件已发出）
    } else if (s) {
      // Agent mode uses tools via runAgent.
      // showInTerminal（前端"AI 控制"开关）：开启时把 AI 执行的命令及输出回显到集群终端
      const showInTerminal = !!req.body.showInTerminal;

      // Agent 主链路统一走智能上下文：集群快照、历史摘要、相关技能和 token 预算
      // 在这里一次构建，避免“模块存在但正式 Agent 没接线”。
      const contextStartedAt = Date.now();
      let agentSkillIndex: SkillIndex | undefined;
      if (!workflowRunContext) {
        try {
          // 关键路径只取缓存。正式流程直接读取当前步骤来源，不构建通用技能包。
          const clusterSkills = getCachedClusterSkills(sessionId!);
          agentSkillIndex = loadOrRefreshSkillIndex({
            skillsDir: APP_SKILLS_DIR,
            lsfSkillDir: LSF_SKILLS_DIR,
      donauSkillDir: DONAU_SKILLS_DIR,
            userSkillsDir: USER_SKILLS_DIR,
            indexPath: path.join(USER_SKILLS_DIR, '.skill-index.json'),
            clusterSkills,
          });
        } catch { /* 技能索引失败不阻塞主流程 */ }
      }

      // 正式流程已经绑定独立 RUN 与用户选择的输入；不再注入或刷新通用集群快照。
      const clusterSnapshot = workflowRunContext ? undefined : getClusterSnapshotForAi(sessionId!);
      // 成品流程本身已把参数、脚本和进度写进 RUN/run.json。这里不再把整段
      // 历史/流程说明重新投入模型，只保留本轮用户补充；权威状态由 runner 定点读取。
      const workflowTurnText = parseWorkflowExecutionContext(query)
        ? '开始或继续当前结构化流程；直接从 RUN/run.json 的当前未完成步骤执行。'
        : query.slice(-2_000);
      const workflowTurnMode = workflowRunContext
        ? classifyWorkflowTurn(workflowTurnText)
        : undefined;
      const workflowConversationMessages = contextMessages
        .filter(message => message.role === 'user' || message.role === 'assistant')
        .slice(-6)
        .map(message => ({ role: message.role as 'user' | 'assistant', content: message.content }));
      const agentMessages = workflowRunContext
        ? [
            languageInstruction,
            ...workflowConversationMessages,
            ...(
              workflowConversationMessages.at(-1)?.role === 'user'
              && workflowConversationMessages.at(-1)?.content === workflowTurnText
                ? []
                : [{ role: 'user' as const, content: workflowTurnText || '继续当前结构化流程。' }]
            ),
          ]
        : await buildSmartContext({
            messages: [languageInstruction, ...contextMessages],
            mode: 'agent',
            userQuery: query,
            clusterSnapshot,
            model: profile.model,
            locale: requestLocale,
            summary: effectiveConversationSummary,
            structuredMemory: persistedConversationMemory.structuredMemory,
            skillIndex: agentSkillIndex,
            conversationId: requestedConversationId,
            compactSummarize: requestedConversationId ? compactionSummarizer : undefined,
            onCompacted: info => send({ type: 'compacted', count: info.count, summaryChars: info.summaryChars, requestId: aiRequestId }),
          });
      console.log(
        '[AI:%s] context ready messages=%d chars=%d context=%dms elapsed=%dms workflowScoped=%s cachedSkills=%d cachedSnapshot=%s',
        aiRequestId,
        agentMessages.length,
        agentMessages.reduce((sum, item) => sum + item.content.length, 0),
        Date.now() - contextStartedAt,
        Date.now() - aiStartedAt,
        workflowRunContext ? 'yes' : 'no',
        workflowRunContext ? 0 : getCachedClusterSkills(sessionId!).length,
        clusterSnapshot ? 'yes' : 'no',
      );
      send({
        type: 'status',
        phase: 'requesting',
        message: workflowRunContext
          ? workflowTurnMode === 'inspect'
            ? '已恢复流程状态，正在进行只读查询…'
            : '已恢复流程进度，正在执行当前步骤…'
          : `上下文已就绪，正在请求 ${profile.model}…`,
        requestId: aiRequestId,
      });

      const requestConfirmationIds = new Set<string>();
      const requestPlanReviewIds = new Set<string>();
      // legacy 路径的作业绑定会话标识：与 dsh 路径同款（buildDshConversationKey），
      // 作业终态唤醒时凭它锁定原对话并回写续跑内容。
      const agentConversationId = typeof req.body?.conversationId === 'string' ? req.body.conversationId : undefined;
      const agentConversationKey = buildDshConversationKey({
        sshSessionId: sessionId || undefined,
        conversationContextId: req.body?.conversationContextId,
        conversationId: req.body?.conversationId,
        requestId: aiRequestId,
      });
      const rawConfirmationPolicy = req.body?.agentConfig?.confirmationPolicy;
      const agentConfirmationPolicy = rawConfirmationPolicy === 'never' || rawConfirmationPolicy === 'state_changes' || rawConfirmationPolicy === 'every_command'
        ? rawConfirmationPolicy
        : undefined;
      // 集群会话同样接受前端配置的本地工作区：cluster_fs 的 push/pull 本地端
      // 与本地模式同规（normalizeWorkspace 校验存在且为目录），不传则互传动作如实报错。
      const requestedAgentWorkspaces = Array.isArray(req.body?.workspaces) ? req.body.workspaces : [];
      const agentWorkspaces = [...new Set([
        ...requestedAgentWorkspaces.map((value: unknown) => normalizeWorkspace(value)).filter((value): value is string => Boolean(value)),
        normalizeWorkspace(req.body?.workspace),
      ].filter((value): value is string => Boolean(value)))].slice(0, 20);
      const ctx: AgentCtx = {
        sid: sessionId,
        profile,
        run: async (_sid, cmd, timeout) => {
          if (showInTerminal && s.socket) {
            s.socket.emit('data', `\r\n\x1b[36m[AI] $ ${cmd}\x1b[0m\r\n`);
          }
          const output = await s.cluster.exec(cmd, timeout || 30_000);
          if (showInTerminal && s.socket && output) {
            s.socket.emit('data', output.replace(/\n/g, '\r\n') + '\r\n');
          }
          return output;
        },
        getSftp: () => s.cluster.getSftp(),
        confirmCommand: async (command, details) => {
          const id = `confirm-${createSessionId()}`;
          requestConfirmationIds.add(id);
          const decision = await pendingAiConfirmations.request({ id, command, risk: details?.risk,
            title: details?.title, send, signal: requestAbort.signal, requestId: aiRequestId });
          return decision.approved;
        },
        // 计划审批：set_plan 后挂起本轮，等用户批准/编辑/取消（事件与恢复走同一条 SSE）。
        reviewPlan: (plan) => {
          const id = createPlanReviewId();
          requestPlanReviewIds.add(id);
          return pendingPlanReviews.request({
            id,
            goal: plan.goal,
            steps: plan.steps.map(step => ({ title: step.title, verification: step.verification })),
            send,
            signal: requestAbort.signal,
            requestId: aiRequestId,
          });
        },
        // 中途插话：模型循环在每个模型步开始前从这里取走用户插话。
        steer: { take: () => steerQueue.take(aiRequestId) },
        home: s.home,
        skillsDir: APP_SKILLS_DIR,
        lsfSkillDir: LSF_SKILLS_DIR,
      donauSkillDir: DONAU_SKILLS_DIR,
        userSkillsDir: USER_SKILLS_DIR,
        workspace: agentWorkspaces[0],
        workspaces: agentWorkspaces,
        runtimeConfig: req.body.agentConfig,
        resumePlan: req.body.resumePlan,
        workflowRun: workflowRunContext,
        scheduler: s.cluster.scheduler,
        moduleAvailable: s.cluster.moduleAvailable,
        installers: s.cluster.installers,
        workflowTurnMode,
        conversationId: agentConversationId,
        conversationKey: agentConversationKey,
        jobSubmissionGuard,
        onJobsSubmitted: jobIds => {
          trackFormalWorkflowJobs(
            sessionId,
            workflowRunContext ? {
              workflowId: workflowRunContext.workflowId,
              runId: workflowRunContext.runId,
              runDir: workflowRunContext.runDir,
              conversationId: agentConversationId,
              locale: requestLocale,
              confirmationPolicy: agentConfirmationPolicy,
            } : undefined,
            jobIds,
          );
          // legacy 引擎同样登记 job-agent 绑定（dsh 路径在 dshAgentRunner 内登记），
          // 作业终态后 maybeResumeLegacyAgent 凭绑定唤醒原对话。登记失败不打断主链路。
          // 正式流程作业不登记：它们已由 formalWorkflowContinuations + 流程状态机
          // 负责续跑（resumeFinishedFormalWorkflowRun），再绑对话会双唤醒。
          if (workflowRunContext) return;
          try {
            registerLegacyJobBindings(sessionId, jobIds, {
              connectionKey: `${s.info.username}@${s.info.host}:${s.info.port}`,
              conversationKey: agentConversationKey,
              conversationId: agentConversationId,
              confirmationPolicy: agentConfirmationPolicy,
              profile: { provider: profile.provider, model: profile.model, baseUrl: profile.baseUrl },
              locale: requestLocale,
            });
          } catch (err) {
            console.warn('[job-bind] legacy 作业绑定登记失败: %s', err instanceof Error ? err.message : String(err));
          }
        },
        locale: requestLocale,
      };

      try {
        let providerResponded = false;
        await runAgent(ctx, {
          onText: (text) => send({ type: 'content', content: text }),
          onReason: (text) => send({ type: 'reasoning', content: text }),
          onToolCall: (name, args) => send({ type: 'tool_call', name, args }),
          onToolResult: (name, result) => send({ type: 'tool_result', name, result }),
          onStep: (step) => send({ type: 'step', step }),
          onAsk: (question, options) => send({ type: 'ask', question, options }),
          onPlan: (plan) => send({ type: 'plan', plan }),
          onPlanUpdate: (plan, stepId) => send({ type: 'plan_update', plan, stepId }),
          onSteer: (texts) => send({ type: 'steer_applied', texts, requestId: aiRequestId }),
          onWorkflowRunChanged: (run) => emitWorkflowRunChanged(sessionId, run),
          onWorkflowRunMissing: (wf) => {
            terminalEvent = 'error';
            console.warn('[AI:%s] workflow run missing on cluster, detach: %s', aiRequestId, wf.runDir);
            send({
              type: 'workflow_run_missing',
              workflowId: wf.workflowId,
              runId: wf.runId,
              runDir: wf.runDir,
              requestId: aiRequestId,
            });
          },
          onActivity: (type) => {
            if (providerResponded || type === 'start' || type === 'start-step') return;
            providerResponded = true;
            console.log('[AI:%s] first provider activity type=%s elapsed=%dms', aiRequestId, type, Date.now() - aiStartedAt);
            send({ type: 'status', phase: 'working', message: 'AI 已响应，正在规划和执行…', requestId: aiRequestId });
          },
          onDone: (text) => {
            drainSteers();
            terminalEvent = 'done';
            send({ type: 'done', content: text, requestId: aiRequestId });
          },
          onErr: (error) => {
            drainSteers();
            terminalEvent = 'error';
            console.error('[AI:%s] agent error after %dms: %s', aiRequestId, Date.now() - aiStartedAt, error);
            send({ type: 'error', error, requestId: aiRequestId });
          },
          sig: () => requestAbort.signal,
        }, agentMessages);
      } finally {
        for (const id of requestConfirmationIds) {
          pendingAiConfirmations.cancel(id);
        }
        for (const id of requestPlanReviewIds) {
          pendingPlanReviews.cancel(id);
        }
      }
    } else {
      // 未连接集群（无 SSH 会话）：本地模式。Agent 走本地工作区工具组
      // （list_local_files / read_local_file / write_local_file / run_local_command），
      // 读写由服务端强制限制在用户指定的本地工作区内；不注入集群快照。
      const requestedLocalWorkspaces = Array.isArray(req.body?.workspaces) ? req.body.workspaces : [];
      const localWorkspaces = [...new Set([
        ...requestedLocalWorkspaces.map((value: unknown) => normalizeWorkspace(value)).filter((value): value is string => Boolean(value)),
        normalizeWorkspace(req.body?.workspace),
      ].filter((value): value is string => Boolean(value)))].slice(0, 20);
      const localWorkspace = localWorkspaces[0];
      if (req.body?.workspace && !localWorkspace) {
        console.warn('[AI:%s] workspace 无效已忽略: %s', aiRequestId, String(req.body.workspace).slice(0, 200));
      }
      const smartMessages = await buildSmartContext({
        messages: [languageInstruction, ...rawMessages],
        mode,
        userQuery: query,
        model: profile.model,
        locale: requestLocale,
        selectedOutput: req.body.selectedOutput,
        summary: effectiveConversationSummary,
        structuredMemory: persistedConversationMemory.structuredMemory,
        conversationId: requestedConversationId,
        compactSummarize: requestedConversationId ? compactionSummarizer : undefined,
        onCompacted: info => send({ type: 'compacted', count: info.count, summaryChars: info.summaryChars, requestId: aiRequestId }),
      });
      send({ type: 'status', phase: 'requesting', message: `正在请求 ${profile.model}…`, requestId: aiRequestId });

      const localConfirmationIds = new Set<string>();
      const localPlanReviewIds = new Set<string>();
      const localCtx: AgentCtx = {
        sid: sessionId || 'local-workspace',
        profile,
        // 本地模式下集群工具不会挂载，run 不应被调用；兜底抛错防误用。
        run: async () => { throw new Error('当前为本地模式，集群命令不可用'); },
        confirmCommand: async (command, details) => {
          const id = `confirm-${createSessionId()}`;
          localConfirmationIds.add(id);
          const decision = await pendingAiConfirmations.request({ id, command, risk: details?.risk,
            title: details?.title, send, signal: requestAbort.signal, requestId: aiRequestId });
          return decision.approved;
        },
        // 与集群路径一致：本地模式的 set_plan 同样先经用户审批再执行。
        reviewPlan: (plan) => {
          const id = createPlanReviewId();
          localPlanReviewIds.add(id);
          return pendingPlanReviews.request({
            id,
            goal: plan.goal,
            steps: plan.steps.map(step => ({ title: step.title, verification: step.verification })),
            send,
            signal: requestAbort.signal,
            requestId: aiRequestId,
          });
        },
        steer: { take: () => steerQueue.take(aiRequestId) },
        skillsDir: APP_SKILLS_DIR,
        lsfSkillDir: LSF_SKILLS_DIR,
      donauSkillDir: DONAU_SKILLS_DIR,
        userSkillsDir: USER_SKILLS_DIR,
        runtimeConfig: req.body.agentConfig,
        resumePlan: req.body.resumePlan,
        localOnly: true,
        workspace: localWorkspace,
        workspaces: localWorkspaces,
        locale: requestLocale,
      };

      try {
        let providerResponded = false;
        await runAgent(localCtx, {
          onText: (text) => send({ type: 'content', content: text }),
          onReason: (text) => send({ type: 'reasoning', content: text }),
          onToolCall: (name, args) => send({ type: 'tool_call', name, args }),
          onToolResult: (name, result) => send({ type: 'tool_result', name, result }),
          onStep: (step) => send({ type: 'step', step }),
          onAsk: (question, options) => send({ type: 'ask', question, options }),
          onPlan: (plan) => send({ type: 'plan', plan }),
          onPlanUpdate: (plan, stepId) => send({ type: 'plan_update', plan, stepId }),
          onSteer: (texts) => send({ type: 'steer_applied', texts, requestId: aiRequestId }),
          onActivity: (type) => {
            if (providerResponded || type === 'start' || type === 'start-step') return;
            providerResponded = true;
            console.log('[AI:%s] first provider activity type=%s elapsed=%dms', aiRequestId, type, Date.now() - aiStartedAt);
            send({ type: 'status', phase: 'working', message: 'AI 已响应，正在规划和执行…', requestId: aiRequestId });
          },
          onDone: (text) => {
            drainSteers();
            terminalEvent = 'done';
            send({ type: 'done', content: text, requestId: aiRequestId });
          },
          onErr: (error) => {
            drainSteers();
            terminalEvent = 'error';
            console.error('[AI:%s] local agent error after %dms: %s', aiRequestId, Date.now() - aiStartedAt, error);
            send({ type: 'error', error, requestId: aiRequestId });
          },
          sig: () => requestAbort.signal,
        }, smartMessages);
      } finally {
        for (const id of localConfirmationIds) {
          pendingAiConfirmations.cancel(id);
        }
        for (const id of localPlanReviewIds) {
          pendingPlanReviews.cancel(id);
        }
      }
    }
  } catch (err: any) {
    terminalEvent = 'error';
    console.error('[AI:%s] route error after %dms: %s', aiRequestId, Date.now() - aiStartedAt, err?.message || String(err));
    drainSteers();
    send({ type: 'error', error: err.message || String(err) });
  } finally {
    requestWatchdog?.stop();
    if (publicState) {
      try { await publicState.flush(); if (terminalEvent === 'done' && deferredPublicDone) deliver(deferredPublicDone); }
      catch { terminalEvent = 'error'; deliver({ type: 'error', error: '任务执行已结束，但集群设置/恢复信息保存失败；请检查集群连接，不能视为已完整保存', requestId: aiRequestId }); }
    }
    clearInterval(heartbeat);
    res.off('close', onResponseClose);
    if (!res.writableEnded && !res.destroyed) res.end();
    // 后台（detached）运行的收尾：把最终答复追加进对话存档并广播 ai:resumed，
    // 用户回到该对话时自动刷新出结果；未脱离的连接由客户端自己保存，不写两遍。
    const terminalKind = terminalEvent === 'done' ? 'done' as const : 'error' as const;
    finishActiveRun(activeRun, terminalKind, activeRun.text);
    if (activeRun.detached && runConversationId) {
      const text = activeRun.text.trim();
      const failure = [...activeRun.events].reverse().find(event => event.type === 'error');
      const failureText = String(failure?.error || (requestLocale === 'en-US' ? 'The background task was interrupted. Check existing jobs and outputs before resuming.' : '后台任务中断，请先检查现有作业与产物后再恢复。'));
      const content = terminalKind === 'done'
        ? (text || (requestLocale === 'en-US' ? '(The background turn ended without text.)' : '(后台任务已结束，未产生文本)'))
        : `${text ? `${text}\n\n` : ''}${failureText}`;
      // 轮末未消费的插话按用户消息存档，排在最终答复之前，下一轮模型能看到它们。
      void appendJobResumeConversation(runConversationId, [
        ...unconsumedSteers.map(steerText => ({ role: 'user', content: steerText })),
        { role: 'assistant', content },
      ], activeRun.sessionId);
      const sid = activeRun.sessionId || 'local-workbench';
      io.to(workflowRunRoom(sid)).emit('ai:resumed', {
        type: 'ai:resumed',
        conversationId: runConversationId,
        preview: content.slice(0, 200),
      });
    }
    console.log(
      '[AI:%s] request finalized outcome=%s aborted=%s elapsed=%dms',
      aiRequestId,
      terminalEvent,
      requestAbort.signal.aborted,
      Date.now() - aiStartedAt,
    );
  }
});

// ─── 后台 AI 运行管理：查询 / 续流 / 中止 ──────────────────────────────
// 切换对话/窗口后任务不停止：客户端断连只是 detached，可凭 conversationId 找回。
app.get('/api/ai/active', (req, res) => {
  const conversationId = String(req.query.conversationId || '');
  if (!conversationId) {
    res.status(400).json({ success: false, error: '缺少 conversationId' });
    return;
  }
  const run = findActiveRunByConversation(conversationId);
  res.json({
    success: true,
    running: Boolean(run),
    requestId: run?.requestId,
    startedAt: run?.startedAt,
    textPreview: run?.text.slice(-200) || '',
  });
});

app.post('/api/ai/abort', (req, res) => {
  const requestId = String(req.body?.requestId || '');
  const run = requestId ? getActiveRun(requestId) : undefined;
  if (!run || run.terminal) {
    res.status(404).json({ success: false, error: '运行已结束或不存在' });
    return;
  }
  abortActiveRun(run);
  res.json({ success: true });
});

// attach：重放脱连期间缓冲的事件，然后继续实时推送；终态后关闭
app.get('/api/ai/stream/attach', (req, res) => {
  const requestId = String(req.query.requestId || '');
  const run = requestId ? getActiveRun(requestId) : undefined;
  if (!run) {
    res.status(404).json({ success: false, error: '运行已结束或不存在' });
    return;
  }
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  const writeEvent = (event: any) => {
    if (!res.writableEnded && !res.destroyed) res.write(`data: ${JSON.stringify(event)}\n\n`);
  };
  for (const event of replayRunEvents(run)) writeEvent(event);
  if (run.terminal) {
    res.end();
    return;
  }
  const detachListener = attachRunListener(run, writeEvent);
  const heartbeat = setInterval(() => {
    if (!res.writableEnded && !res.destroyed) res.write(': heartbeat\n\n');
  }, 15_000);
  const cleanup = () => {
    detachListener();
    clearInterval(heartbeat);
  };
  res.once('close', cleanup);
  // 终态后事件推送完毕即收尾（下一轮事件循环里 terminal 已写入）
  const closer = setInterval(() => {
    if (run.terminal) {
      clearInterval(closer);
      cleanup();
      if (!res.writableEnded && !res.destroyed) res.end();
    }
  }, 500);
});

app.post('/api/ai/confirm', (req, res) => {
  const id = String(req.body?.id || '');
  if (!id || typeof req.body?.approved !== 'boolean') {
    res.status(400).json({ success: false, error: 'invalid_confirmation_response' });
    return;
  }
  const receipt = pendingAiConfirmations.respond(id, req.body.approved);
  res.status(receipt.success ? 200 : 409).json({ ...receipt,
    ...(receipt.success ? {} : { error: 'confirmation_no_longer_pending' }) });
});

app.post('/api/ai/question', (req, res) => {
  const id = String(req.body?.id || '');
  if (!id || (req.body?.cancelled !== undefined && typeof req.body.cancelled !== 'boolean')) {
    res.status(400).json({ success: false, error: 'invalid_question_response' });
    return;
  }
  const receipt = pendingAiQuestions.respond(id, req.body?.answer, req.body?.cancelled === true);
  res.status(receipt.success ? 200 : receipt.error === 'invalid_question_answer' ? 400 : 409).json(receipt);
});

// 计划审批：批准按计划继续；edit 带用户改过的 steps 继续；cancel 取消本轮。
app.post('/api/ai/plan-review', (req, res) => {
  const id = String(req.body?.id || '');
  const action = req.body?.action;
  if (!id || (action !== 'approve' && action !== 'edit' && action !== 'cancel')) {
    res.status(400).json({ success: false, error: 'invalid_plan_review_response' });
    return;
  }
  const receipt = pendingPlanReviews.respond(id, { action, steps: req.body?.steps });
  res.status(receipt.success ? 200 : receipt.error === 'invalid_plan_review_steps' ? 400 : 409).json(receipt);
});

// 中途插话：AI 运行中用户发来的新指令。挂起的反问优先把插话当回答消化；
// 否则按 requestId 排队，agentRunner 在下一个模型步开始前注入。
app.post('/api/ai/steer', (req, res) => {
  const requestId = String(req.body?.requestId || '');
  const text = String(req.body?.text || '').trim();
  if (!requestId || !text) {
    res.status(400).json({ success: false, error: 'invalid_steer_request' });
    return;
  }
  const run = getActiveRun(requestId);
  if (!run || run.terminal) {
    res.status(404).json({ success: false, error: '运行已结束或不存在' });
    return;
  }
  const questionReceipt = pendingAiQuestions.respondForRequest(requestId, text);
  if (questionReceipt.success) {
    res.json({ success: true, delivered: 'question' });
    return;
  }
  const position = steerQueue.enqueue(requestId, text);
  if (!position) {
    res.status(429).json({ success: false, error: '插话排队已满，请稍后再试' });
    return;
  }
  res.json({ success: true, delivered: 'queued', position });
});

// ── Remote file download (used by AI chat output file links) ─────────

app.get('/api/files/download', async (req, res) => {
  // 支持 ?sessionId=（<a download> 链接无法带请求头，用 query 指定集群）
  const sessionId = resolveRequestSessionId({
    cookie: (req.session as any)?.sshSessionId,
    header: req.get('X-SSH-Session-Id') || req.query.sessionId,
    auth: undefined,
  }, hasSession);
  const s = getSession(sessionId);
  if (!s) {
    res.status(401).json({ error: 'SSH session required' });
    return;
  }

  const remotePath = String(req.query.path || '');
  if (!remotePath) {
    res.status(400).json({ error: 'Missing path' });
    return;
  }

  try {
    const service = new SftpFileService(s.cluster.getSftp(), s.home, s.cluster.exec.bind(s.cluster));
    let entry;
    try {
      entry = await service.stat(remotePath);
    } catch (statErr: any) {
      // 明确区分"文件不存在/路径非法"与其它错误，方便前端诊断
      const msg = statErr?.message || String(statErr);
      if (/no such file|not exist|ENOENT/i.test(msg)) {
        res.status(404).json({ error: `文件不存在（可能仍在写入或路径已变化）：${remotePath}` });
      } else {
        res.status(400).json({ error: `路径无效：${msg}` });
      }
      return;
    }
    if (entry.kind === 'directory') {
      res.status(400).json({ error: 'Cannot download a directory' });
      return;
    }

    // basename 可能含非 Latin-1 字符（如中文文件名），HTTP 头需 RFC 5987 编码
    const baseName = path.basename(remotePath).replace(/"/g, '');
    const fallback = baseName.replace(/[^\x20-\x7e]/g, '_');
    const encoded = encodeURIComponent(baseName).replace(/'/g, '%27');
    res.setHeader('Content-Disposition', `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`);
    res.setHeader('Content-Type', 'application/octet-stream');

    const sftp = s.cluster.getSftp();
    const stream = sftp.createReadStream(remotePath);
    stream.on('error', (err) => {
      if (!res.headersSent) {
        res.status(500).json({ error: err.message });
      } else {
        res.end();
      }
    });
    stream.pipe(res);
  } catch (err: any) {
    res.status(500).json({ error: err.message || String(err) });
  }
});

// ── 流程运行监控：读取集群 ~/trace_runs 与 ~/trace_flows 下的 run.json ──────────────

app.get('/api/workflow-runs', async (req, res) => {
  const sessionId = resolveRequestSessionId({
    cookie: (req.session as any)?.sshSessionId,
    header: req.get('X-SSH-Session-Id'),
    auth: undefined,
  }, hasSession);
  const s = sessionId ? getSession(sessionId) : undefined;
  if (!s) {
    res.status(401).json({ success: false, error: '需要活跃的 SSH 会话' });
    return;
  }
  const cached = sessionId ? workflowRunSnapshotCache.get(sessionId) : undefined;
  if (cached && cached.expiresAt > Date.now()) {
    res.json({ success: true, runs: cached.runs });
    return;
  }
  try {
    // 正常刷新只读取 run-index.txt 列出的少量 run.json。历史目录发现只由
    // 用户明确点击“导入历史运行”触发，页面刷新不再使用任何目录 glob。
    const runs: any[] = await readIndexedWorkflowRuns(s.cluster.exec.bind(s.cluster), s.home, 20);
    // 主动核对所有活动流程的真实调度器状态，不再等到 AI 心跳超时后才检查。
    let reconciled = runs;
    const activeJobIds = collectActiveJobIds(runs);
    if (activeJobIds.length > 0) {
      try {
        const ids = activeJobIds.join(' ');
        const csv = activeJobIds.join(',');
        const schedulerRaw = await s.cluster.exec(
          `if command -v bjobs >/dev/null 2>&1; then ` +
          `bjobs -a -noheader -o "jobid stat" ${ids} 2>/dev/null; ` +
          `elif command -v squeue >/dev/null 2>&1; then ` +
          `squeue -h -j ${csv} -o "%i %T" 2>/dev/null; ` +
          `command -v sacct >/dev/null 2>&1 && sacct -n -X -j ${csv} --format=JobIDRaw,State 2>/dev/null; ` +
          `fi; true`,
          15_000,
        );
        reconciled = reconcileRunsWithScheduler(runs, parseBjobsStates(schedulerRaw));
        // 只在客观状态发生变化时回写，run.json 继续作为可移植的集群侧镜像。
        for (let i = 0; i < reconciled.length; i++) {
          const before = runs[i];
          const after = reconciled[i];
          const beforeSteps = (before.steps || []).map((step: any) => step.status).join(',');
          const afterSteps = (after.steps || []).map((step: any) => step.status).join(',');
          if (before.status !== after.status || beforeSteps !== afterSteps || JSON.stringify(before.jobStates) !== JSON.stringify(after.jobStates)) {
            const persisted = await reconcileWorkflowRunWithScheduler(s.cluster.exec.bind(s.cluster), s.home, after.runDir, parseBjobsStates(schedulerRaw));
            reconciled[i] = persisted;
            if (sessionId) emitWorkflowRunChanged(sessionId, persisted);
          }
        }
      } catch { /* 调度器核对失败不影响 run.json 基本展示 */ }
    }
    // 停顿判定：只有调度器也未证明任务仍活跃时才标记 stalled。
    let annotated = annotateRuns(reconciled);
    annotated.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    const visibleRuns = annotated.slice(0, 20);
    if (sessionId) workflowRunSnapshotCache.set(sessionId, {
      expiresAt: Date.now() + 10_000,
      runs: visibleRuns,
    });
    res.json({ success: true, runs: visibleRuns });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message || String(err) });
  }
});

app.post('/api/workflow-runs/import-history', async (req, res) => {
  const sessionId = resolveRequestSessionId({
    cookie: (req.session as any)?.sshSessionId,
    header: req.get('X-SSH-Session-Id'),
    auth: undefined,
  }, hasSession);
  const s = sessionId ? getSession(sessionId) : undefined;
  if (!s) {
    res.status(401).json({ success: false, error: '需要活跃的 SSH 会话' });
    return;
  }
  try {
    const count = await importLegacyWorkflowRunIndex(s.cluster.exec.bind(s.cluster), s.home);
    if (sessionId) workflowRunSnapshotCache.delete(sessionId);
    res.json({ success: true, count });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message || String(err) });
  }
});

// 直连互传凭据同步（仅内存暂存）：前端登录成功后推送目标账号密码+TOTP 种子
app.post('/api/transfer-credentials', (req, res) => {
  try {
    const { host, port, username, password, totpSecret } = req.body || {};
    if (!host || !username) {
      res.status(400).json({ success: false, error: '缺少 host/username' });
      return;
    }
    setTransferCredentials(String(host), String(port || 22), String(username), String(password || ''), String(totpSecret || ''));
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message || String(err) });
  }
});

app.get('/api/qqbot/config', (_req, res) => {
  const config = loadQQBotConfig();
  res.json({
    success: true,
    config: {
      appId: config.appId || '',
      appSecret: config.appSecret ? '******' : '',
      allowlist: config.allowlist || [],
    },
    running: qqBotInstance !== null,
  });
});

app.put('/api/qqbot/config', (req, res) => {
  try {
    const current = loadQQBotConfig();
    const body = req.body || {};
    const next: QQBotConfig = {
      appId: typeof body.appId === 'string' ? body.appId.trim() : (current.appId || ''),
      // '******' 或未传 = 保持原密钥；空串 = 清除
      appSecret: body.appSecret === '******' || body.appSecret === undefined
        ? (current.appSecret || '')
        : String(body.appSecret).trim(),
      allowlist: Array.isArray(body.allowlist)
        ? body.allowlist.map((s: unknown) => String(s).trim()).filter(Boolean)
        : (current.allowlist || []),
      ai: current.ai,
    };
    fs.mkdirSync(path.dirname(dataPath('qqbot.json')), { recursive: true });
    // appSecret / ai.apiKey 加密落盘；encryptSecret 对空值/已加密值原样返回
    fs.writeFileSync(dataPath('qqbot.json'), JSON.stringify({
      ...next,
      appSecret: next.appSecret ? encryptSecret(next.appSecret) : next.appSecret,
      ai: next.ai?.apiKey ? { ...next.ai, apiKey: encryptSecret(next.ai.apiKey) } : next.ai,
    }, null, 2));
    const running = launchQQBot(); // 保存后立即按新配置重启机器人
    res.json({ success: true, running });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message || String(err) });
  }
});

// SPA fallback: serve index.html for unknown non-API routes.
app.get('*', (_req, res) => {
  res.sendFile(staticPath('dist/index.html'));
});

// ── Socket.IO terminal ──────────────────────────────────────────────

io.use((socket, next) => {
  sessionMiddleware(socket.request as any, {} as any, next as any);
});

io.use((socket, next) => {
  if (PUBLIC_WORKER && socket.handshake.headers['x-trace-worker'] !== process.env.TRACE_PUBLIC_WORKER_TOKEN) {
    return next(new Error('Forbidden'));
  }
  if (webAccessConfig.enabled && !webAccess.authorized(socket.request as any)) {
    return next(new Error('TRACE web authentication required'));
  }
  next();
});

io.on('connection', (socket) => {
  const sessionId = resolveSocketSessionId(
    (socket.request as any).session?.sshSessionId,
    socket.handshake.headers['x-ssh-session-id'],
    (socket.handshake.auth as any)?.sessionId,
    hasKnownSession,
  );
  const s = getKnownSession(sessionId);
  if (!s) {
    socket.disconnect();
    return;
  }

  if (s.cluster.state !== 'connected') {
    socket.emit('ssh:disconnected', {
      error: 'SSH 主连接已断开。网络恢复后可点击重连。',
    });
  }

  // 记录终端 socket，AI agent 执行命令时可回显到该终端（showInTerminal）
  s.socket = socket;
  socket.join(workflowRunRoom(s.id));

  const { cluster } = s;

  const onData = (data: string | Buffer) => {
    socket.emit('data', typeof data === 'string' ? data : data.toString('utf8'));
  };
  let attachedShell: typeof cluster.shell = undefined;
  const detachShell = () => {
    attachedShell?.off('data', onData);
    attachedShell?.stderr?.off('data', onData);
    attachedShell = undefined;
  };
  const attachShell = () => {
    if (attachedShell === cluster.shell && attachedShell) return;
    detachShell();
    attachedShell = cluster.shell;
    attachedShell?.on('data', onData);
    attachedShell?.stderr?.on('data', onData);
  };
  const restoreShell = async () => {
    try {
      socket.emit('shell:restarting');
      await cluster.respawnShell();
      attachShell();
      socket.emit('shell:ready');
    } catch (err: any) {
      socket.emit('shell:respawn-error', err?.message || String(err));
    }
  };

  attachShell();
  if (cluster.shell) socket.emit('shell:ready');
  else if (cluster.state === 'connected') void restoreShell();

  cluster.onShellDead = (reason) => {
    detachShell();
    console.warn('[SSH:%s] shell channel ended (%s), rebuilding automatically', sessionId, reason || 'unknown');
    // SSH 主连接仍在时自动重建 PTY；用户无需再手动点“重连”。
    void restoreShell();
  };

  socket.on('shell:respawn', () => {
    void restoreShell();
  });

  socket.on('data', (data) => {
    try {
      cluster.write(data);
    } catch {
      socket.emit('shell:dead');
    }
  });

  socket.on('resize', (cols, rows) => {
    try {
      cluster.resize(Number(cols), Number(rows));
    } catch {
      // ignore
    }
  });

  socket.on('disconnect', () => {
    detachShell();
    if (s.socket === socket) {
      s.socket = undefined;
      cluster.onShellDead = undefined;
    }
  });
});

// ── Start server ────────────────────────────────────────────────────

configureHttpServerForSse(httpServer);

// ── QQ 机器人：配置读写 + 保存后热重启；密钥只在服务端保存，读取时脱敏 ──
let qqBotInstance: QQBot | null = null;

function loadQQBotConfig(): QQBotConfig {
  try {
    const parsed = JSON.parse(fs.readFileSync(dataPath('qqbot.json'), 'utf8'));
    // appSecret / ai.apiKey 落盘为密文（enc:v1: 前缀），历史明文原样透传
    if (parsed?.appSecret) parsed.appSecret = decryptSecret(parsed.appSecret);
    if (parsed?.ai?.apiKey) parsed.ai.apiKey = decryptSecret(parsed.ai.apiKey);
    return parsed;
  } catch {
    return { appId: '', appSecret: '', allowlist: [] };
  }
}

function launchQQBot(): boolean {
  const config = loadQQBotConfig();
  const appId = config?.appId || process.env.QQ_BOT_APP_ID || '';
  const appSecret = config?.appSecret || process.env.QQ_BOT_APP_SECRET || '';
  qqBotInstance?.stop();
  qqBotInstance = null;
  if (!appId || !appSecret) return false;
  qqBotInstance = new QQBot(
    { appId, appSecret, allowlist: config.allowlist, ai: config.ai },
    {
      getClusterSession: () => {
        const first = [...sessions.values()][0];
        return first
          ? { sid: first.id, home: first.home, exec: first.cluster.exec.bind(first.cluster) }
          : undefined;
      },
      getAiProfile: loadServerAiProfile,
      saveConversation: async (record) => {
        // QQ 对话存档到当前集群的 ~/trace_conversations（与应用对话记录同库）
        const first = [...sessions.values()][0];
        if (!first) throw new Error('当前没有已连接的集群');
        const store = new ClusterConversationStore(
          new SftpFileService(first.cluster.getSftp(), first.home, first.cluster.exec.bind(first.cluster)),
          first.home,
        );
        await store.save(enrichConversation(record as ConversationRecord));
      },
      skillsDir: APP_SKILLS_DIR,
      lsfSkillDir: LSF_SKILLS_DIR,
      donauSkillDir: DONAU_SKILLS_DIR,
      userSkillsDir: USER_SKILLS_DIR,
      trackJobs: (sid, jobIds) => jobWatcher.trackJobs(sid, jobIds),
      log: msg => console.log(msg),
    },
  );
  qqBotInstance.start().catch(err => console.error('[QQBot] 启动失败:', err?.message || err));
  return true;
}

httpServer.listen(PORT, webAccessConfig.host, () => {
  console.log(`[TRACE] Server listening on http://${webAccessConfig.host}:${PORT}`);
  if (!PUBLIC_WORKER) initBridgeState(PORT);
  initJobAgentBindings(DATA_ROOT);
  if (!PUBLIC_WORKER) {
    ensureDemoConversationSeed().catch(err => console.error('[DemoSeed] 写入示例对话失败:', err?.message || err));
    launchQQBot();
  } else {
    process.send?.({ type: 'public-worker-ready', port: (httpServer.address() as any).port });
  }
});

if (webAccessConfig.enabled || PUBLIC_WORKER) {
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    if (publicState) await Promise.race([publicState.flush().catch(() => {}), new Promise(resolve => setTimeout(resolve, 2000))]);
    qqBotInstance?.stop();
    stopSidecar();
    for (const [sessionId, active] of sessions) {
      jobWatcher.stop(sessionId);
      active.cluster.close();
    }
    sessions.clear();
    io.close();
    httpServer.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

if (publicState) {
  const persistence = setInterval(() => void publicState.flush().catch(() => {}), 5000);
  persistence.unref();
}

// Electron 主进程崩溃时，后台不得成为长期占端口的孤儿进程。
// 这不会影响 `npm run dev`（开发模式没有 TRACE_PARENT_PID）。
const desktopParentPid = Number(process.env.TRACE_PARENT_PID || 0);
if (Number.isSafeInteger(desktopParentPid) && desktopParentPid > 0 && desktopParentPid !== process.pid) {
  let parentGone = false;
  const parentWatch = setInterval(() => {
    if (parentGone) return;
    try {
      process.kill(desktopParentPid, 0);
    } catch {
      parentGone = true;
      console.error('[TRACE] Electron parent pid=%d is gone; closing orphan backend.', desktopParentPid);
      qqBotInstance?.stop();
      stopSidecar();
      for (const [sessionId, session] of sessions) {
        jobWatcher.stop(sessionId);
        session.cluster.close();
      }
      sessions.clear();
      httpServer.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 3_000).unref();
    }
  }, 5_000);
  parentWatch.unref();
}
