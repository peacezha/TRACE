import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { isPublicWeb, readPublicPreference, savePublicPreference } from '../services/publicWeb';
import { motion } from 'motion/react';
import type { Socket } from 'socket.io-client';
import {
  X, Package, Database, FolderOpen, FileSearch, Plus, Trash2, Play, Loader2,
  CheckCircle2, XCircle, AlertTriangle, FileText, Terminal, RefreshCw,
  Wrench, ChevronDown, ChevronRight, Circle, Download, Upload, Code2, Save,
  GitBranch, Bot,
} from 'lucide-react';
import WorkflowFlowGraph from './WorkflowFlowGraph';
import HtmlReportFrame from './rich-content/HtmlReportFrame';
import WorkflowPreflightCard from './WorkflowPreflightCard';
import WorkflowQcNotice from './WorkflowQcNotice';
import { unresolvedQcFailures } from '@/shared/workflowQc';
import { needsAutomaticOutputReview } from '@/shared/workflowContinuation';
import { useWorkflowText, useWorkflowLocale } from '../i18n';
import { writeClipboardText } from '../services/clipboard';
import { buildDataPrepGuide } from '../features/workflows/dataPrepGuide';
import { encodeExampleFor } from '../features/workflows/encodeExample';
import type { Workflow } from '@/shared/workflow';
import { isPendingDisposal, workflowDisposalReason } from '@/shared/workflowCatalog';
import type { PickPathKind } from '@/shared/fileTransfer';
import type { PreflightResult } from '@/shared/flowManifest';
import {
  createWorkflowRun, deployWorkflowAssets, fetchRunLog, fetchWorkflowRuns, fetchWorkflowStepCode, getCachedPreflight,
  importWorkflowRunHistory, mergeWorkflowRunUpdate, reconcileWorkflowRunSnapshot, runBelongsToWorkflow, runPreflight,
  resumeWorkflowRun, runPreflightForConfig, saveWorkflowStepCode,
  type PreflightRunReport, type WorkflowRun, type WorkflowRunConfigInput,
} from '../features/workflows/api';
import { composeResumeRunMessage, composeRunMessage, type PreRunCheckSummary } from '../features/workflows/compose';
import { workflowSlug } from '@/shared/flowManifest';
import {
  clearWorkflowHabits,
  getWorkflowHabitSuggestion,
  recordWorkflowHabit,
} from '../features/workflows/workflowHabits';

interface FlowRunnerDrawerProps {
  workflow: Workflow;
  sessionId?: string | null;
  socket?: Socket | null;
  onClose: () => void;
  /** 把组装好的执行协议发给 AI agent（聊天页签可见执行过程）；
   *  options.dedicatedConversation=true（启动/恢复正式运行）时由 App 开该次运行专属的对话执行，
   *  缺省（环境补齐等讨论消息）留在当前对话。 */
  onRun: (message: string, options?: { dedicatedConversation?: boolean }) => void;
  /** 打开集群文件树/传输工作区选择集群文件或目录，取消时 resolve null */
  onPickFolder?: (kind?: PickPathKind) => Promise<string | null>;
  /** 在文件传输工作区打开本次运行目录。 */
  onOpenRunFolder?: (path: string) => void;
  /** 作为 AI 工作台主页面呈现，而不是右侧覆盖抽屉。 */
  embedded?: boolean;
  /** 本地工作台未连接计算资源时，打开计算资源管理/连接入口。 */
  onConnectCompute?: () => void;
}

export const RUN_STATUS: Record<string, { label: string; cls: string }> = {
  blocked_env: { label: '环境未就绪', cls: 'bg-orange-500/15 text-orange-500' },
  running: { label: '运行中', cls: 'bg-sky-500/15 text-sky-500' },
  waiting_user: { label: '等待确认', cls: 'bg-amber-500/15 text-amber-500' },
  waiting_jobs: { label: '后台监控', cls: 'bg-indigo-500/15 text-indigo-400' },
  done: { label: '已完成', cls: 'bg-emerald-500/15 text-emerald-500' },
  failed: { label: '失败', cls: 'bg-red-500/15 text-red-400' },
  cancelled: { label: '已取消', cls: 'bg-gray-500/15 text-gray-400' },
  unknown: { label: '未知', cls: 'bg-scholar-700/50 text-scholar-400' },
};

export const QC_BADGE: Record<string, { label: string; cls: string }> = {
  pass: { label: 'QC 通过', cls: 'bg-emerald-500/15 text-emerald-500' },
  warn: { label: 'QC 警告', cls: 'bg-amber-500/15 text-amber-500' },
  fail: { label: 'QC 未过', cls: 'bg-red-500/15 text-red-400' },
};

export function defaultParamValues(workflow: Workflow): Record<string, string> {
  return Object.fromEntries(workflow.params.map(p => [p.name, p.defaultValue ?? '']));
}

export function defaultStepValues(workflow: Workflow): Record<number, Record<string, string>> {
  const values: Record<number, Record<string, string>> = {};
  workflow.steps.forEach((step, index) => {
    if (step.params?.length) values[index + 1] = Object.fromEntries(step.params.map(p => [p.name, p.defaultValue ?? '']));
  });
  return values;
}

export function validateParamValue(param: Workflow['params'][number], value: string): string | null {
  if (!value) return null;
  if (param.type === 'number') {
    const n = Number(value);
    if (!Number.isFinite(n)) return `${param.label || param.name}必须是数字`;
    if (param.min !== undefined && n < param.min) return `${param.label || param.name}不能小于 ${param.min}`;
    if (param.max !== undefined && n > param.max) return `${param.label || param.name}不能大于 ${param.max}`;
  }
  if (param.pattern) {
    try {
      if (!new RegExp(param.pattern).test(value)) return `${param.label || param.name}格式不正确`;
    } catch { return `${param.label || param.name}的校验规则无效`; }
  }
  return null;
}

/** 必填判定：显式 required 优先；否则有默认值视为可选 */
export function isWorkflowParamRequired(p: Workflow['params'][number]): boolean {
  return p.required ?? !p.defaultValue;
}

export default function FlowRunnerDrawer({ workflow, sessionId: requestedSessionId, socket, onClose, onRun, onPickFolder, onOpenRunFolder, embedded = false, onConnectCompute }: FlowRunnerDrawerProps) {
  const sessionId = requestedSessionId === 'local-workbench' ? null : requestedSessionId;
  const displayText = useWorkflowText();
  const [initialHabit] = useState(() => getWorkflowHabitSuggestion(workflow.id));
  const [preflight, setPreflight] = useState<PreflightResult | null | undefined>(undefined);
  const [checkingAll, setCheckingAll] = useState(false);
  const [itemBusy, setItemBusy] = useState<Record<string, boolean>>({});
  // 环境检查失败不再静默：保留旧状态的同时把错误显示出来
  const [checkError, setCheckError] = useState('');
  const [inputs, setInputs] = useState<string[]>([]);
  const [manualInput, setManualInput] = useState('');
  const [paramValues, setParamValues] = useState<Record<string, string>>(() => ({
    ...defaultParamValues(workflow),
    ...(initialHabit?.params || {}),
  }));
  // 步骤级参数：key = 步骤序号（1-based）
  const [stepValues, setStepValues] = useState<Record<number, Record<string, string>>>(() => {
    const defaults = defaultStepValues(workflow);
    for (const [step, values] of Object.entries(initialHabit?.stepParams || {})) {
      defaults[Number(step)] = { ...(defaults[Number(step)] || {}), ...values };
    }
    return defaults;
  });
  // 用户为参考数据改指的实际路径（按参考数据名）
  const [refOverrides, setRefOverrides] = useState<Record<string, string>>({});
  const [skippedSteps, setSkippedSteps] = useState<number[]>(() => initialHabit?.skippedSteps || []);
  const [stepCommandOverrides, setStepCommandOverrides] = useState<Record<number, string>>({});
  // 步骤代码/指令可见性：外层“步骤与代码”折叠块 + 逐步代码块展开状态；
  // 流程图节点可点击：跳到对应步骤卡片并展开它的代码块
  const [stepsPanelOpen, setStepsPanelOpen] = useState(false);
  const [openCodeSteps, setOpenCodeSteps] = useState<number[]>([]);
  const stepCardRefs = useRef(new Map<number, HTMLDivElement>());
  const jumpToStepCode = useCallback((n: number) => {
    setStepsPanelOpen(true);
    setOpenCodeSteps(list => (list.includes(n) ? list : [...list, n]));
    requestAnimationFrame(() => {
      stepCardRefs.current.get(n)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  }, []);
  const [formError, setFormError] = useState('');
  const [deployBusy, setDeployBusy] = useState(false);
  const [deployResults, setDeployResults] = useState<Array<{ remotePath: string; ok: boolean; error?: string }> | null>(null);
  const [runs, setRuns] = useState<WorkflowRun[]>([]);
  const [realtimeConnected, setRealtimeConnected] = useState(() => !!socket?.connected);
  const [expandedRunDir, setExpandedRunDir] = useState<string | null>(null);
  const [logRunDir, setLogRunDir] = useState<string | null>(null);
  const [reportPath, setReportPath] = useState<string | null>(null);
  const [codeRun, setCodeRun] = useState<WorkflowRun | null>(null);
  const [startingRun, setStartingRun] = useState(false);
  // 启动前整体检查：非 null 时以覆盖层展示集中解答卡
  const [preRunReport, setPreRunReport] = useState<PreflightRunReport | null>(null);
  const [preRunChecking, setPreRunChecking] = useState(false);
  const [importingHistory, setImportingHistory] = useState(false);
  const [configNotice, setConfigNotice] = useState(() => initialHabit
    ? `已按之前 ${initialHabit.sampleCount} 次使用习惯预填非敏感参数`
    : '');
  const [resumingRunDir, setResumingRunDir] = useState<string | null>(null);

  const manifest = workflow.manifest;
  const inputHint = manifest?.inputHint;
  // 占位符路径的参考数据（{{参数}}）由运行时参数指定，不参与校验按钮
  const isPlaceholder = (p: string) => /\{\{[^}]+\}\}/.test(p);

  useEffect(() => {
    const connected = () => setRealtimeConnected(true);
    const disconnected = () => setRealtimeConnected(false);
    setRealtimeConnected(!!socket?.connected);
    socket?.on('connect', connected);
    socket?.on('disconnect', disconnected);
    return () => {
      socket?.off('connect', connected);
      socket?.off('disconnect', disconnected);
    };
  }, [socket]);

  const configStorageKey = `trace_workflow_run_config_v1:${workflow.id}`;

  const loadSavedConfig = useCallback(() => {
    try {
      const raw = isPublicWeb() ? readPublicPreference(configStorageKey) : localStorage.getItem(configStorageKey);
      if (!raw) { setConfigNotice('没有已保存的配置'); return; }
      const saved = JSON.parse(raw);
      setInputs(Array.isArray(saved.inputs) ? saved.inputs.map(String) : []);
      setParamValues({ ...defaultParamValues(workflow), ...(saved.paramValues || {}) });
      setStepValues({ ...defaultStepValues(workflow), ...(saved.stepValues || {}) });
      setRefOverrides(saved.refOverrides || {});
      setSkippedSteps(Array.isArray(saved.skippedSteps) ? saved.skippedSteps.map(Number) : []);
      setStepCommandOverrides(saved.stepCommandOverrides || {});
      setConfigNotice('已载入保存的配置');
    } catch {
      setConfigNotice('保存的配置已损坏，未载入');
    }
  }, [configStorageKey, workflow]);

  const saveCurrentConfig = useCallback(async () => {
    const value = JSON.stringify({
      inputs, paramValues, stepValues, refOverrides, skippedSteps, stepCommandOverrides,
    });
    if (isPublicWeb()) {
      const saved = await savePublicPreference(configStorageKey, value);
      setConfigNotice(saved ? '配置已保存到当前集群，可在下次登录时载入' : '保存失败，配置尚未写入集群');
      return;
    }
    localStorage.setItem(configStorageKey, value);
    setConfigNotice('配置已保存，可在下次运行时载入');
  }, [configStorageKey, inputs, paramValues, stepValues, refOverrides, skippedSteps, stepCommandOverrides]);

  const resetConfig = useCallback(() => {
    setInputs([]);
    setParamValues(defaultParamValues(workflow));
    setStepValues(defaultStepValues(workflow));
    setRefOverrides({});
    setSkippedSteps([]);
    setStepCommandOverrides({});
    setConfigNotice('已恢复流程默认配置');
  }, [workflow]);

  const requestResetConfig = useCallback(() => {
    const modified = inputs.length > 0
      || Object.keys(refOverrides).length > 0
      || skippedSteps.length > 0
      || Object.keys(stepCommandOverrides).length > 0
      || JSON.stringify(paramValues) !== JSON.stringify(defaultParamValues(workflow))
      || JSON.stringify(stepValues) !== JSON.stringify(defaultStepValues(workflow));
    if (modified && !window.confirm('当前流程配置有修改，确定放弃这些修改并恢复默认吗？')) return;
    resetConfig();
  }, [inputs, paramValues, refOverrides, resetConfig, skippedSteps, stepCommandOverrides, stepValues, workflow]);

  // ── 预检：进入面板先读缓存 ──
  useEffect(() => {
    if (!sessionId) { setPreflight(null); return; }
    let stopped = false;
    getCachedPreflight(workflow.id, sessionId)
      .then(r => { if (!stopped) setPreflight(r); })
      .catch(() => { if (!stopped) setPreflight(null); });
    return () => { stopped = true; };
  }, [workflow.id, sessionId]);

  // ── 运行记录：Socket 实时增量 + 60 秒断线补偿 ──
  useEffect(() => {
    if (!sessionId) { setRuns([]); return; }
    let stopped = false;
    const load = async () => {
      try {
        const all = await fetchWorkflowRuns(sessionId);
        if (!stopped) setRuns(current => reconcileWorkflowRunSnapshot(
          current,
          all.filter(r => runBelongsToWorkflow(r, workflow)),
        ));
      } catch { /* 下轮再试 */ }
    };
    const onRunUpdated = (payload: { run?: WorkflowRun }) => {
      if (!stopped && payload?.run && runBelongsToWorkflow(payload.run, workflow)) {
        setRuns(current => mergeWorkflowRunUpdate(current, payload.run));
      }
    };
    void load();
    socket?.on('workflow:run-updated', onRunUpdated);
    socket?.on('connect', load);
    const timer = setInterval(load, 60_000);
    return () => {
      stopped = true;
      clearInterval(timer);
      socket?.off('workflow:run-updated', onRunUpdated);
      socket?.off('connect', load);
    };
  }, [workflow, sessionId, socket]);

  const doCheckAll = useCallback(async () => {
    if (!sessionId) return;
    setCheckingAll(true);
    setCheckError('');
    try {
      setPreflight(await runPreflight(workflow.id, sessionId));
    } catch (e: any) {
      setCheckError(`环境检查失败：${e?.message || String(e)}`);
    } finally {
      setCheckingAll(false);
    }
  }, [workflow.id, sessionId]);

  const doCheckItem = useCallback(async (kind: 'software' | 'references', name: string) => {
    if (!sessionId) return;
    setItemBusy(b => ({ ...b, [`${kind}:${name}`]: true }));
    setCheckError('');
    try {
      const only = kind === 'software' ? { software: [name] } : { references: [name] };
      setPreflight(await runPreflight(workflow.id, sessionId, only));
    } catch (e: any) {
      setCheckError(`校验「${name}」失败：${e?.message || String(e)}`);
    } finally {
      setItemBusy(b => ({ ...b, [`${kind}:${name}`]: false }));
    }
  }, [workflow.id, sessionId]);

  // 部署内置管线文件到集群（如 HiDOG 三个核心 py），完成后自动重新全量检查
  const handleDeploy = useCallback(async () => {
    if (!sessionId) return;
    setDeployBusy(true);
    setDeployResults(null);
    try {
      const { results } = await deployWorkflowAssets(workflow.id, sessionId);
      setDeployResults(results);
      if (results.every(r => r.ok)) await doCheckAll();
    } catch (e: any) {
      setDeployResults([{ remotePath: '', ok: false, error: e.message || String(e) }]);
    } finally {
      setDeployBusy(false);
    }
  }, [sessionId, workflow.id, doCheckAll]);

  // 缺失项一键补齐：组装消息发给 AI（直接修复，登录节点操作；只有真正需要抉择才询问）
  const handleProvision = useCallback((kind: 'software' | 'references', name: string, detail?: string) => {
    const kindLabel = kind === 'software' ? '软件' : '参考数据';
    onRun([
      `流程「${workflow.name}」（ID: ${workflow.id}）的${kindLabel}「${name}」未就绪${detail ? `（${detail}）` : ''}。`,
      '请直接修复，不用先报方案等我确认：优先 module load 或安装到流程家目录 02_reference/（或你判断的合适位置），下载和安装只能在登录节点进行（计算节点无网络）。',
      '修复后用一条精确命令验证该项，然后重新核查并继续流程；只有确实需要我抉择时才 ask_user。',
    ].join('\n'));
  }, [onRun, workflow.id, workflow.name]);

  const addInput = useCallback((p: string) => {
    const v = p.trim();
    if (v && !inputs.includes(v)) setInputs(list => [...list, v]);
  }, [inputs]);

  const pickFolder = useCallback(async () => {
    if (!onPickFolder) return;
    const picked = await onPickFolder('any');
    if (picked) addInput(picked);
  }, [onPickFolder, addInput]);

  // path 类型参数：选中的文件/目录作为该参数的值
  const pickPathForParam = useCallback(async (paramName: string, kind: 'file' | 'folder') => {
    if (!onPickFolder) return;
    const picked = await onPickFolder(kind);
    if (picked) setParamValues(v => ({ ...v, [paramName]: picked }));
  }, [onPickFolder]);

  // 参考数据：为其改指实际路径，文件或目录均可（占位参考有同名参数时同步写入参数值）
  const pickFileForReference = useCallback(async (refName: string) => {
    if (!onPickFolder) return;
    const picked = await onPickFolder('any');
    if (!picked) return;
    setRefOverrides(v => ({ ...v, [refName]: picked }));
    const ref = manifest?.references.find(r => r.name === refName);
    const placeholder = ref?.path.match(/^\{\{(\w+)\}\}$/);
    if (placeholder && workflow.params.some(p => p.name === placeholder[1])) {
      setParamValues(v => ({ ...v, [placeholder[1]]: picked }));
    }
  }, [onPickFolder, manifest, workflow.params]);

  // 必填判定：显式 required 优先；否则有默认值视为可选
  const isRequired = isWorkflowParamRequired;
  const missingParams = useMemo(
    () => workflow.params.filter(p => isRequired(p) && !(paramValues[p.name] ?? '').trim()).map(p => p.label || p.name),
    [workflow.params, paramValues],
  );
  const needInputs = !!inputHint || workflow.params.some(p => /INPUT|DATA|FASTQ| SAMPLE/i.test(p.name));

  const buildRunConfig = useCallback((): WorkflowRunConfigInput => ({
    inputs,
    params: paramValues,
    stepParams: stepValues,
    referenceOverrides: refOverrides,
    skippedSteps,
    stepCommandOverrides,
  }), [inputs, paramValues, stepValues, refOverrides, skippedSteps, stepCommandOverrides]);

  // 正式创建运行并发出执行协议；preRunCheck 记录启动前整体检查结论（通过 / 用户接受的警告）
  const startRun = useCallback(async (preRunCheck?: PreRunCheckSummary) => {
    setFormError('');
    setStartingRun(true);
    try {
      const run = await createWorkflowRun(workflow.id, buildRunConfig(), sessionId);
      const sampleCount = recordWorkflowHabit(workflow.id, {
        params: paramValues,
        stepParams: stepValues,
        skippedSteps,
      });
      if (sampleCount >= 2) setConfigNotice(`已学习本次选择（累计 ${sampleCount} 次），路径和命令不会保存`);
      setRuns(current => mergeWorkflowRunUpdate(current, run));
      onRun(composeRunMessage(workflow, {
        preflight: preflight ?? null,
        preRunCheck,
        inputs,
        paramValues,
        stepValues,
        referenceOverrides: refOverrides,
        skippedSteps,
        stepCommandOverrides,
        run: { runId: run.runId || run.runDir.split('/').pop() || 'run', runDir: run.runDir },
      }), { dedicatedConversation: true });
      setPreRunReport(null);
      // 旧抽屉模式运行后回到聊天区；主页面模式保持流程时间线可见。
      if (!embedded) onClose();
    } catch (e: any) {
      setFormError(e?.message || '创建流程运行失败');
    } finally {
      setStartingRun(false);
    }
  }, [buildRunConfig, onRun, onClose, workflow, preflight, paramValues, stepValues, refOverrides, skippedSteps, stepCommandOverrides, sessionId, embedded]);

  // 启动前整体检查：无问题直接建运行；有问题弹集中解答卡，解答后用最新配置重检，通过才继续
  const checkBeforeRun = useCallback(async () => {
    setFormError('');
    setPreRunChecking(true);
    try {
      const report = await runPreflightForConfig(workflow.id, buildRunConfig(), sessionId);
      if (report.issues.length === 0) {
        await startRun({ passed: true });
      } else {
        setPreRunReport(report);
      }
    } catch (e: any) {
      setFormError(`启动前整体检查失败：${e?.message || String(e)}`);
    } finally {
      setPreRunChecking(false);
    }
  }, [workflow.id, buildRunConfig, sessionId, startRun]);

  // 集中解答卡：参考数据改指实际路径（占位参考有同名参数时同步写入参数值，与服务端解析顺序一致）
  const handlePreRunReferenceChange = useCallback((refName: string, path: string) => {
    setRefOverrides(v => ({ ...v, [refName]: path }));
    const ref = manifest?.references.find(r => r.name === refName);
    for (const match of (ref?.path ?? '').matchAll(/\{\{\s*([\w.-]+)\s*\}\}/g)) {
      if (workflow.params.some(p => p.name === match[1])) {
        setParamValues(v => ({ ...v, [match[1]]: path }));
      }
    }
  }, [manifest, workflow.params]);

  // 用户明确接受剩余警告，仍然开始运行（有 blocker 时卡片内禁用该按钮）
  const handlePreRunRunAnyway = useCallback(async () => {
    if (!preRunReport) return;
    const acceptedWarnings = preRunReport.issues
      .filter(issue => issue.severity === 'warn')
      .map(issue => `${issue.label || issue.name}：${issue.message}`);
    await startRun({ passed: false, acceptedWarnings });
  }, [preRunReport, startRun]);

  const handleRun = useCallback(async () => {
    if (isPendingDisposal(workflow)) { setFormError(displayText('此流程在待弃置中，不能发起新运行。请在流程管理中恢复；已有任务不受影响。')); return; }
    if (needInputs && inputs.length === 0) {
      setFormError('请先选择要处理的数据目录');
      return;
    }
    if (missingParams.length > 0) {
      setFormError(`还有参数未填写：${missingParams.join('、')}`);
      return;
    }
    const validationErrors: string[] = [];
    workflow.params.forEach(p => {
      const error = validateParamValue(p, paramValues[p.name] ?? '');
      if (error) validationErrors.push(error);
    });
    workflow.steps.forEach((step, index) => {
      if (skippedSteps.includes(index + 1)) return;
      for (const p of step.params || []) {
        const value = stepValues[index + 1]?.[p.name] ?? '';
        if ((p.required ?? !p.defaultValue) && !value.trim()) validationErrors.push(`步骤 ${index + 1}：${p.label || p.name}未填写`);
        const error = validateParamValue(p, value);
        if (error) validationErrors.push(`步骤 ${index + 1}：${error}`);
      }
    });
    if (validationErrors.length > 0) {
      setFormError(validationErrors.slice(0, 3).join('；'));
      return;
    }
    // 前端校验过后，先做启动前整体检查（软件/参考数据/输入/参数/脚本占位符）
    await checkBeforeRun();
  }, [workflow, displayText, needInputs, inputs, missingParams, paramValues, stepValues, skippedSteps, checkBeforeRun]);

  const activeRun = runs.find(r => !r.stale && (r.status === 'running' || r.status === 'waiting_user' || r.status === 'waiting_jobs' || r.status === 'blocked_env'));
  const envReady = preflight?.ready;
  // 有实际检查过且失败的必需项（"未检查"不算缺失）
  const envFailed = !!preflight && [...preflight.software, ...preflight.references]
    .some(i => !i.ok && i.required && i.detail && i.detail !== '未检查');
  const inputHintText = inputHint || '选择计算资源上要处理的数据目录';
  const dedicatedFlowDir = `~/trace_flows/${workflowSlug(workflow.name)}/`;
  // 数据准备引导：从流程定义生成（格式要点 + 可复制模板）
  const locale = useWorkflowLocale();
  const prepText = (zh: string, en: string) => locale === 'en-US' ? en : zh;
  const dataPrep = useMemo(() => buildDataPrepGuide(workflow, locale), [workflow, locale]);

  /** 让 AI 协助准备数据：留在当前对话，AI 先看目录再帮忙生成/检查输入文件 */
  const handleAskAiDataPrep = useCallback(() => {
    const paramLines = workflow.params
      .filter(p => p.type === 'path' || /INPUT|DATA|FASTQ|SAMPLE|SHEET|JSON|YAML|CONFIG/i.test(p.name))
      .map(p => `- ${p.name} (${displayText(p.label)})${p.help ? `: ${displayText(p.help)}` : ''}`);
    const message = [
      prepText(`我准备运行流程「${workflow.name}」（ID: ${workflow.id}），请帮我准备数据：`, `I plan to run "${displayText(workflow.name)}" (ID: ${workflow.id}). Please help me prepare the input data. Respond in English.`),
      ...(dataPrep.summary ? [prepText(`数据形态：${dataPrep.summary}`, `Input data: ${dataPrep.summary}`)] : []),
      ...(paramLines.length ? [prepText('需要我准备/确认的输入：', 'Inputs to prepare or confirm:'), ...paramLines] : []),
      '',
      prepText('请先看一下我当前目录里有什么（我会告诉你数据目录，或你直接列当前目录），', 'First inspect the data directory I provide, or list the current directory.'),
      prepText('然后帮我生成或检查样本表/输入文件；格式确认无误后再开始流程。', 'Then generate or validate the sample sheet and input files. Confirm their format before starting the workflow.'),
    ].join('\n');
    onRun(message);
  }, [workflow, dataPrep.summary, onRun, locale, displayText]);

  /** 「参考示例」一键填参：只填空着的参数（不覆盖用户已填），数据目录有示例就一并带上 */
  const handleFillEncodeExample = useCallback(() => {
    const spec = encodeExampleFor(workflow.id);
    if (!spec) return;
    const filled: string[] = [];
    const kept: string[] = [];
    for (const [name, value] of Object.entries(spec.params)) {
      if (workflow.params.some(p => p.name === name)) {
        if ((paramValues[name] ?? '') === '') {
          filled.push(name);
        } else {
          kept.push(name);
        }
      }
    }
    setParamValues(current => {
      const next = { ...current };
      for (const name of filled) next[name] = spec.params[name];
      return next;
    });
    if (spec.inputDir && inputs.length === 0) {
      setInputs([spec.inputDir]);
    }
    setConfigNotice(
      prepText(`已按参考示例填好 ${filled.length} 个参数${kept.length ? `（${kept.length} 个您已填写的保持不变）` : ''}，`
        + '点「开始运行」即可。示例是 GRCh38 chr19 小数据集，只用于验证流程跑通。',
      `Filled ${filled.length} example parameters; preserved ${kept.length} existing values. Click Run workflow to start. The small GRCh38 chr19 dataset is for workflow validation only.`),
    );
  }, [workflow, paramValues, inputs.length, locale]);

  const handleImportHistory = useCallback(async () => {
    if (!sessionId) return;
    setImportingHistory(true);
    try {
      const count = await importWorkflowRunHistory(sessionId);
      const all = await fetchWorkflowRuns(sessionId);
      setRuns(all.filter(run => runBelongsToWorkflow(run, workflow)));
      setConfigNotice(`已按你的操作导入 ${count} 条历史运行；平时不会自动扫描。`);
    } catch (error: any) {
      setFormError(error?.message || '导入历史运行失败');
    } finally {
      setImportingHistory(false);
    }
  }, [sessionId, workflow]);

  const handleResumeRun = useCallback(async (candidate: WorkflowRun, acknowledgeFailedQc = false) => {
    if (!sessionId) return;
    setResumingRunDir(candidate.runDir);
    setFormError('');
    try {
      const run = acknowledgeFailedQc
        ? await resumeWorkflowRun(candidate.runDir, candidate.revision, sessionId, true)
        : await resumeWorkflowRun(candidate.runDir, candidate.revision, sessionId);
      setRuns(current => mergeWorkflowRunUpdate(current, run));
      if (run.status !== 'done') onRun(composeResumeRunMessage(workflow, run), { dedicatedConversation: true });
      if (!embedded) onClose();
    } catch (error: any) {
      setFormError(error?.message || '继续流程失败，请刷新状态后重试');
    } finally {
      setResumingRunDir(null);
    }
  }, [embedded, onClose, onRun, sessionId, workflow]);

  const handleOpenRunFolder = useCallback((runDir: string) => {
    onOpenRunFolder?.(runDir);
    if (!embedded) onClose();
  }, [embedded, onClose, onOpenRunFolder]);

  return (
    <motion.div
      initial={embedded ? false : { x: '100%', opacity: 0 }}
      animate={embedded ? undefined : { x: 0, opacity: 1 }}
      transition={{ duration: 0.2, ease: 'easeOut' }}
      className={embedded
        ? 'relative h-full min-w-0 bg-scholar-900 flex flex-col'
        : 'fixed inset-y-0 right-0 z-30 w-[600px] max-w-[92vw] bg-scholar-900 border-l border-scholar-700 shadow-lg flex flex-col'}
    >
      {/* 头部（GitBranch 为流程语义图标；不用 Play 三角，避免“可点击播放”的误导） */}
      <div className="px-4 py-3 border-b border-scholar-700/60 flex items-center gap-2 shrink-0">
        <GitBranch className="w-4 h-4 text-accent shrink-0" />
        <div className="flex-1 min-w-0">
          <h2 className="text-sm font-medium text-scholar-100 truncate">{displayText(workflow.name)}</h2>
          {workflow.description && <p className="text-[11px] text-scholar-400 truncate">{displayText(workflow.description)}</p>}
        </div>
        <button onClick={onClose} className="btn-icon" aria-label="关闭"><X className="w-4 h-4" /></button>
      </div>

      <div className="flex-1 overflow-y-auto p-3 space-y-3">
        {!sessionId && (
          <section className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-300">
            <p>流程运行需要计算资源。当前本地工作台只能编辑配置，连接计算资源后才能检查环境并运行。</p>
            {onConnectCompute && <button type="button" onClick={onConnectCompute} className="btn-primary mt-2 !px-3 !py-1.5 !text-[11px]">连接计算资源</button>}
          </section>
        )}
        {isPendingDisposal(workflow) && <section className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm leading-6 text-amber-400">
          <p>{displayText('此流程在待弃置中，不能发起新运行。请在流程管理中恢复；已有任务不受影响。')}</p>
          <p data-user-content="true">{workflow.lifecycle?.reason || displayText(workflowDisposalReason(workflow))}</p>
        </section>}
        <section className="rounded-lg border border-emerald-500/25 bg-emerald-500/5 p-3">
          <div className="flex items-center gap-2">
            <FolderOpen className="w-3.5 h-3.5 text-emerald-500 shrink-0" />
            <span className="text-xs font-medium text-scholar-100">专属工作目录</span>
            <span className="ml-auto text-[10px] text-emerald-500">强制隔离</span>
          </div>
          <code className="mt-1.5 block text-[10px] text-scholar-300 break-all">{dedicatedFlowDir}</code>
          <p className="mt-1 text-[10px] text-scholar-500">每次运行创建独立 RUN 文件夹，并预生成 code/step-NN.sh。用户可按步骤查看修改，AI 只能在当前 RUN 内工作。</p>
        </section>

        {/* ── 卡片1：环境检查 ── */}
        <details className="rounded-lg border border-scholar-700/60 bg-scholar-800/40">
          <summary className="px-3 py-2 flex items-center gap-2 cursor-pointer list-none">
            <Package className="w-3.5 h-3.5 text-accent" />
            <span className="text-xs font-medium text-scholar-100 flex-1">按需环境检查</span>
            {preflight && (
              <span className={`text-[10px] px-1.5 py-0.5 rounded ${
                envReady ? 'bg-emerald-500/15 text-emerald-500'
                : envFailed ? 'bg-orange-500/15 text-orange-500'
                : 'bg-scholar-700/50 text-scholar-400'}`}>
                {envReady ? '已就绪' : envFailed ? '有缺失' : '部分未检查'}
              </span>
            )}
            <button onClick={() => void doCheckAll()} disabled={checkingAll || !sessionId}
              className="btn-ghost !text-[11px] !px-2" title="SSH 只读核查全部软件与参考数据">
              {checkingAll ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />} 全部检查
            </button>
          </summary>
          <div className="p-2 space-y-1 border-t border-scholar-700/40">
            {checkError && (
              <p className="text-[11px] text-[var(--color-danger)] px-1 py-1 flex items-start gap-1">
                <AlertTriangle className="w-3 h-3 shrink-0 mt-0.5" />{checkError}
              </p>
            )}
            {preflight?.moduleSystem === 'unavailable' && (
              <p className="text-[11px] text-orange-400 px-1 py-1">
                Module 系统未在非交互 SSH 中初始化：{preflight.moduleSystemDetail || '请检查站点 modules.sh/lmod.sh'}
              </p>
            )}
            {preflight === undefined && <p className="text-[11px] text-scholar-500 px-1 py-1">正在读取上次检查结果…</p>}
            {preflight === null && (manifest?.software.length || manifest?.references.length) ? (
              <p className="text-[11px] text-scholar-500 px-1 py-1">尚未检查过，点击"全部检查"或逐项校验</p>
            ) : null}
            <EnvItems
              title="必要软件" icon={<Package className="w-3 h-3" />}
              items={preflight?.software ?? (manifest?.software ?? []).map(s => ({ name: s.name, ok: false, required: s.required, detail: undefined }))}
              checked={preflight != null}
              kind="software"
              itemBusy={itemBusy}
              onCheck={name => void doCheckItem('software', name)}
              onProvision={(name, detail) => handleProvision('software', name, detail)}
              sessionId={sessionId}
            />
            <EnvItems
              title="必要参考数据" icon={<Database className="w-3 h-3" />}
              items={(preflight?.references ?? (manifest?.references ?? []).map(r => ({ name: r.name, ok: false, required: r.required, detail: r.path })))}
              checked={preflight != null}
              kind="references"
              itemBusy={itemBusy}
              onCheck={name => void doCheckItem('references', name)}
              onProvision={(name, detail) => handleProvision('references', name, detail)}
              onPickFile={name => void pickFileForReference(name)}
              overrides={refOverrides}
              sessionId={sessionId}
              placeholderNames={(manifest?.references ?? []).filter(r => isPlaceholder(r.path)).map(r => r.name)}
            />
            {(!manifest?.software.length && !manifest?.references.length) && (
              <p className="text-[11px] text-scholar-500 px-1 py-1">本流程无软件与参考数据依赖</p>
            )}
            {/* 内置管线文件：随应用分发，一键部署到集群 */}
            {workflow.assets && workflow.assets.length > 0 && (
              <div className="mt-1.5 rounded-md border border-accent/20 bg-accent/5 p-2">
                <div className="flex items-center gap-2">
                  <Package className="w-3 h-3 text-accent shrink-0" />
                  <span className="text-[10px] font-medium text-scholar-200 flex-1">
                    管线文件（{workflow.assets.length} 个，已随应用内置）
                  </span>
                  <button onClick={() => void handleDeploy()} disabled={deployBusy || !sessionId}
                    className="btn-primary !text-[10px] !px-2 !py-0.5"
                    title="把内置管线文件上传到计算资源流程家目录 01_software/">
                    {deployBusy ? <Loader2 className="w-2.5 h-2.5 animate-spin" /> : <Upload className="w-2.5 h-2.5" />}
                    部署管线文件
                  </button>
                </div>
                <p className="mt-1 text-[9px] text-scholar-500">
                  {workflow.assets.map(a => displayText(a.label || a.remotePath)).join(' / ')}
                </p>
                {deployResults && (
                  <div className="mt-1 space-y-0.5">
                    {deployResults.map((r, i) => (
                      <p key={i} className={`text-[9px] flex items-center gap-1 ${r.ok ? 'text-emerald-500' : 'text-red-400'}`}>
                        {r.ok ? <CheckCircle2 className="w-2.5 h-2.5" /> : <XCircle className="w-2.5 h-2.5" />}
                        {r.remotePath || '部署失败'}{r.error ? `：${r.error}` : r.ok ? ' 已部署' : ''}
                      </p>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </details>

        {/* ── 卡片2：数据选择（纯参数/运维流程不显示无关目录选择） ── */}
        {needInputs && <section className="rounded-lg border border-scholar-700/60 bg-scholar-800/40">
          <header className="px-3 py-2 flex items-center gap-2 border-b border-scholar-700/40">
            <FolderOpen className="w-3.5 h-3.5 text-accent" />
            <span className="text-xs font-medium text-scholar-100 flex-1">数据选择</span>
            <span className="text-[10px] text-scholar-500">{inputHintText}</span>
          </header>
          {/* 数据准备指南：很多人不知道数据该怎么填——给出格式要点、可复制模板和 AI 协助入口 */}
          <div className="px-2 pt-2">
            <details open={inputs.length === 0} className="rounded-md border border-accent/25 bg-accent/5">
              <summary className="px-2 py-1.5 flex items-center gap-1.5 cursor-pointer list-none text-[11px] text-accent font-medium">
                <FileText className="w-3 h-3" /> {prepText('数据怎么准备？（格式说明 + 模板 + AI 协助）', 'How do I prepare my data? (Formats, templates and AI assistance)')}
              </summary>
              <div className="px-2.5 pb-2 pt-1 space-y-1.5">
                <p className="text-[11px] text-scholar-200 font-medium">{dataPrep.summary}</p>
                <ul className="list-disc pl-4 space-y-0.5 text-[10px] text-scholar-300 leading-relaxed">
                  {dataPrep.points.map((point, i) => <li key={i}>{point}</li>)}
                </ul>
                {dataPrep.templates.length > 0 && (
                  <div className="space-y-1.5 pt-1">
                    {dataPrep.templates.map(tpl => (
                      <div key={tpl.param} className="rounded border border-scholar-700/60 bg-scholar-950/70">
                        <div className="flex items-center gap-2 px-2 py-1 border-b border-scholar-700/40">
                          <span className="text-[10px] font-medium text-scholar-200 flex-1">{tpl.label}</span>
                          <button
                            type="button"
                            onClick={async () => {
                              try {
                                await writeClipboardText(tpl.content);
                                setConfigNotice(prepText('模板「' + tpl.label + '」已复制，粘贴到文本编辑器保存为 ' + tpl.filename, 'Copied ' + tpl.label + '. Paste into a text editor and save as ' + tpl.filename));
                              } catch {
                                setConfigNotice(prepText('复制失败，请选择模板文本并使用 Ctrl+C。', 'Copy failed. Select the template text and press Ctrl+C.'));
                              }
                            }}
                            className="text-[10px] px-1.5 py-0.5 rounded bg-scholar-800 text-scholar-200 hover:text-scholar-50 border border-scholar-700/60"
                          >{prepText('复制模板', 'Copy template')}</button>
                        </div>
                        <pre className="text-[10px] leading-relaxed text-scholar-300 px-2 py-1.5 whitespace-pre-wrap break-all max-h-36 overflow-y-auto font-mono">{tpl.content}</pre>
                      </div>
                    ))}
                  </div>
                )}
                <button
                  type="button"
                  onClick={handleAskAiDataPrep}
                  disabled={!sessionId}
                  className="btn-ghost !text-[11px] !px-2.5 !text-accent border-accent/30"
                  title={prepText('让 AI 看你的数据目录并协助生成/检查输入文件', 'Ask AI to inspect your data directory and help generate or validate input files')}
                >
                  <Bot className="w-3 h-3" /> {prepText('让 AI 帮我准备数据', 'Ask AI to help prepare my data')}
                </button>
                {encodeExampleFor(workflow.id) && (
                  <button
                    type="button"
                    onClick={handleFillEncodeExample}
                    disabled={!sessionId}
                    className="btn-ghost !text-[11px] !px-2.5 !text-emerald-500 border-emerald-500/30"
                    title={prepText('把参数自动填成集群示例参考库（~/trace_refs/encode_example）里的文件，填完即可运行', 'Fill parameters using files from the cluster example reference library (~/trace_refs/encode_example)')}
                  >
                    <Package className="w-3 h-3" /> {prepText('参考示例（一键填好，直接运行）', 'Reference example (fill parameters and run)')}
                  </button>
                )}
              </div>
            </details>
          </div>
          <div className="p-2 space-y-1.5">
            {inputs.map(p => (
              <div key={p} className="flex items-center gap-1.5 bg-scholar-950/60 rounded px-2 py-1">
                <FolderOpen className="w-3 h-3 text-scholar-500 shrink-0" />
                <code className="flex-1 text-[11px] text-scholar-200 truncate" title={p}>{p}</code>
                <button onClick={() => setInputs(list => list.filter(x => x !== p))}
                  className="text-scholar-500 hover:text-red-500 shrink-0" aria-label="移除"><Trash2 className="w-3 h-3" /></button>
              </div>
            ))}
            <div className="flex gap-1.5">
              <button onClick={() => void pickFolder()} disabled={!onPickFolder || !sessionId}
                className="btn-ghost !text-[11px] !px-2.5" title={onPickFolder ? '打开计算资源文件树选择文件或目录' : '需要先连接计算资源'}>
                <FolderOpen className="w-3 h-3" /> 选择文件或目录
              </button>
              <input value={manualInput} onChange={e => setManualInput(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') { addInput(manualInput); setManualInput(''); } }}
                placeholder="或手动输入计算资源路径后回车"
                className="flex-1 bg-scholar-950 border border-scholar-600 rounded px-2 py-1 text-[11px] focus:outline-none focus:ring-1 focus:ring-accent/50" />
              {manualInput.trim() && (
                <button onClick={() => { addInput(manualInput); setManualInput(''); }} className="btn-ghost !text-[11px] !px-2">
                  <Plus className="w-3 h-3" />
                </button>
              )}
            </div>
          </div>
        </section>}

        {/* ── 卡片3：参数配置（全局 + 逐步） ── */}
        {workflow.params.length > 0 && (
          <section className="rounded-lg border border-scholar-700/60 bg-scholar-800/40">
            <header className="px-3 py-2 flex items-center gap-2 border-b border-scholar-700/40">
              <Wrench className="w-3.5 h-3.5 text-accent" />
              <span className="text-xs font-medium text-scholar-100 flex-1">全局参数</span>
              <span className="text-[10px] text-scholar-500">{displayText(`${workflow.params.length} 个参数`)}</span>
            </header>
            <div className="p-2 grid grid-cols-2 gap-2">
              {workflow.params.map(p => (
                <ParamField key={p.name} param={p}
                  value={paramValues[p.name] ?? ''}
                  onChange={v => setParamValues(prev => ({ ...prev, [p.name]: v }))}
                  onPickPath={p.type === 'path' && onPickFolder ? kind => void pickPathForParam(p.name, kind) : undefined}
                  required={isRequired(p)}
                />
              ))}
            </div>
          </section>
        )}

        {/* ── 流程预览：整条步骤链（未运行时全为待执行灰态），先看清流程长什么样 ── */}
        {workflow.steps.length > 0 && (
          <section className="rounded-lg border border-scholar-700/60 bg-scholar-800/40 p-3">
            <div className="flex items-center gap-2 mb-1">
              <GitBranch className="w-3.5 h-3.5 text-accent" />
              <span className="text-xs font-medium text-scholar-100 flex-1">流程预览</span>
              <span className="text-[10px] text-scholar-500">{workflow.steps.length} 步</span>
            </div>
            <WorkflowFlowGraph
              steps={workflow.steps.map((s, i) => ({
                n: i + 1,
                stepId: s.id || `step-${String(i + 1).padStart(2, '0')}`,
                title: s.title,
                status: 'pending' as const,
                dependsOn: s.dependsOn,
                phase: s.phase,
              }))}
              onSelectStep={jumpToStepCode}
            />
            <p className="mt-1 text-[10px] text-scholar-500">点击任意步骤节点，可跳到该步骤的代码 / 指令。</p>
          </section>
        )}

        {/* ── 步骤级高级配置：每步的代码/指令直接可见，覆盖命令默认折叠 ── */}
        {workflow.steps.length > 0 && (
          <details
            className="rounded-lg border border-scholar-700/60 bg-scholar-800/40"
            open={stepsPanelOpen || undefined}
            onToggle={e => setStepsPanelOpen((e.target as HTMLDetailsElement).open)}
          >
            <summary className="px-3 py-2 flex items-center gap-2 cursor-pointer list-none">
              <Wrench className="w-3.5 h-3.5 text-accent" />
              <span className="text-xs font-medium text-scholar-100 flex-1">步骤、代码与高级设置</span>
              <span className="text-[10px] text-scholar-500">{displayText(`${workflow.steps.length} 步 · 默认按流程执行`)}</span>
            </summary>
            <div className="p-2 space-y-2.5 border-t border-scholar-700/40">
              {workflow.steps.map((s, i) => (
                <div
                  key={i}
                  ref={el => { if (el) stepCardRefs.current.set(i + 1, el); else stepCardRefs.current.delete(i + 1); }}
                  className={`rounded-md border p-2 transition-colors ${openCodeSteps.includes(i + 1) ? 'border-accent/50 bg-scholar-950/60' : 'border-scholar-700/40 bg-scholar-950/40'}`}
                >
                  <div className="flex items-center gap-2 mb-1.5">
                    <p className="text-[10px] font-medium text-scholar-300 flex-1">{i + 1}. <span>{displayText(s.title)}</span></p>
                    {s.agent?.confidence && (
                      <span className={`text-[9px] px-1 rounded ${s.agent.confidence === 'high' ? 'bg-emerald-500/10 text-emerald-500' : s.agent.confidence === 'medium' ? 'bg-amber-500/10 text-amber-500' : 'bg-red-500/10 text-red-500'}`}>
                        {s.agent.confidence === 'high' ? '高可信' : s.agent.confidence === 'medium' ? '中可信' : '低可信'}
                      </span>
                    )}
                    {s.agent?.requiresReview && <span className="text-[9px] px-1 rounded bg-red-500/10 text-red-500">运行前确认</span>}
                    {s.optional ? (
                      <label className="text-[10px] text-scholar-400 flex items-center gap-1">
                        <input type="checkbox" checked={!skippedSteps.includes(i + 1)} onChange={e => {
                          setSkippedSteps(list => e.target.checked
                            ? list.filter(n => n !== i + 1)
                            : [...new Set([...list, i + 1])]);
                        }} />本次执行
                      </label>
                    ) : <span className="text-[9px] text-scholar-500">必需步骤</span>}
                  </div>
                  {s.agent && (s.agent.evidence || s.agent.inputs?.length || s.agent.outputs?.length) && (
                    <div className="mb-1.5 rounded bg-scholar-900/70 px-2 py-1.5 text-[9px] text-scholar-400 space-y-0.5">
                      {s.agent.sourceSection && <p>{displayText('来源：')}{s.agent.sourceSection}{s.agent.sourcePath ? ` · ${s.agent.sourcePath}` : ''}</p>}
                      {s.agent.evidence && <p className="text-scholar-300">{displayText('依据：')}{displayText(s.agent.evidence)}</p>}
                      {!!s.agent.inputs?.length && <p>{displayText('输入：')}{s.agent.inputs.map(displayText).join(' / ')}</p>}
                      {!!s.agent.outputs?.length && <p>{displayText('预期输出：')}{s.agent.outputs.map(displayText).join(' / ')}</p>}
                    </div>
                  )}
                  {/* 每步的代码/指令：默认展开可读，不需要先开“高级” */}
                  <details
                    className="mb-1.5"
                    open={openCodeSteps.includes(i + 1) || undefined}
                    onToggle={e => {
                      const open = (e.target as HTMLDetailsElement).open;
                      setOpenCodeSteps(list => (open ? [...new Set([...list, i + 1])] : list.filter(n => n !== i + 1)));
                    }}
                  >
                    <summary className="text-[10px] text-accent cursor-pointer select-none list-none flex items-center gap-1">
                      <Code2 className="w-3 h-3" /> 代码 / 指令
                    </summary>
                    <div className="relative mt-1">
                      <pre className="text-[10px] leading-relaxed text-scholar-200 bg-scholar-950 border border-scholar-700/60 rounded px-2 py-1.5 whitespace-pre-wrap break-all max-h-56 overflow-y-auto font-mono">{s.command}</pre>
                      <button
                        type="button"
                        onClick={() => void writeClipboardText(s.command).catch(() => setConfigNotice(prepText('代码复制失败，请选择文本并使用 Ctrl+C。', 'Code copy failed. Select the text and press Ctrl+C.')))}
                        className="absolute top-1 right-1 text-[9px] px-1.5 py-0.5 rounded bg-scholar-800/90 text-scholar-300 hover:text-scholar-100 border border-scholar-700/60"
                        title="复制本步命令"
                      >
                        复制
                      </button>
                    </div>
                  </details>
                  {!!s.params?.length && <div className="grid grid-cols-2 gap-2">
                    {s.params.map(p => (
                      <ParamField key={p.name} param={p}
                        value={stepValues[i + 1]?.[p.name] ?? ''}
                        onChange={v => setStepValues(prev => ({
                          ...prev,
                          [i + 1]: { ...(prev[i + 1] || {}), [p.name]: v },
                        }))}
                        required={p.required ?? !p.defaultValue}
                      />
                    ))}
                  </div>}
                  <details className="mt-1.5">
                    <summary className="text-[9px] text-accent/80 cursor-pointer">高级：覆盖本次运行命令</summary>
                    <textarea
                      value={stepCommandOverrides[i + 1] ?? ''}
                      onChange={e => setStepCommandOverrides(current => ({ ...current, [i + 1]: e.target.value }))}
                      placeholder={s.command}
                      rows={3}
                      className="mt-1 w-full bg-scholar-900 border border-scholar-600 rounded px-2 py-1 text-[10px] font-mono focus:outline-none resize-y"
                    />
                    <p className="text-[9px] text-scholar-500 mt-0.5">留空使用流程原命令；覆盖只对本次运行有效，AI 执行前仍会做安全校验。</p>
                  </details>
                </div>
              ))}
            </div>
          </details>
        )}

        {/* ── 运行区 ── */}
        <div className="flex items-center gap-2">
          <button type="button" onClick={saveCurrentConfig} className="btn-ghost !text-[11px] !px-2">保存配置</button>
          <button type="button" onClick={loadSavedConfig} className="btn-ghost !text-[11px] !px-2">载入配置</button>
          <button type="button" onClick={requestResetConfig} className="btn-ghost !text-[11px] !px-2">恢复默认</button>
          <button type="button" onClick={() => {
            clearWorkflowHabits(workflow.id);
            resetConfig();
            setConfigNotice('已清除本流程的使用习惯');
          }} className="btn-ghost !text-[11px] !px-2">清除习惯</button>
          {configNotice && <span className="text-[10px] text-scholar-500">{configNotice}</span>}
        </div>
        {formError && <p className="text-[11px] text-red-400 flex items-center gap-1"><AlertTriangle className="w-3 h-3" />{formError}</p>}
        {preflight && envFailed && (
          <p className="text-[11px] text-orange-400 flex items-center gap-1">
            <AlertTriangle className="w-3 h-3" />
            环境有必需项未就绪，运行后 AI 会先引导你补齐，再开始分析。
          </p>
        )}
        <button onClick={() => void handleRun()} disabled={!sessionId || startingRun || preRunChecking || isPendingDisposal(workflow)}
          className="btn-primary w-full !py-2.5 text-sm">
          {startingRun || preRunChecking ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
          {startingRun ? '正在创建正式运行…' : preRunChecking ? displayText('正在整体检查…') : '运行流程'}
        </button>

        {/* ── 卡片4：任务监控 ── */}
        <section className="rounded-lg border border-scholar-700/60 bg-scholar-800/40">
          <header className="px-3 py-2 flex items-center gap-2 border-b border-scholar-700/40">
            <Terminal className="w-3.5 h-3.5 text-accent" />
            <span className="text-xs font-medium text-scholar-100 flex-1">任务监控</span>
            <span className={`w-1.5 h-1.5 rounded-full ${realtimeConnected ? 'bg-emerald-500' : 'bg-amber-500'}`} />
            <span className="text-[10px] text-scholar-500">{realtimeConnected ? '实时' : '重连中'}</span>
            <span className="text-[10px] text-scholar-500">
              {runs.length === 0 ? '尚未运行' : `${runs.length} 次运行${activeRun ? '，进行中' : ''}`}
            </span>
            <button type="button" onClick={() => void handleImportHistory()} disabled={importingHistory || !sessionId}
              className="text-[9px] text-scholar-500 hover:text-accent" title="仅本次按你的操作扫描旧版流程运行目录">
              {importingHistory ? '导入中…' : '导入旧记录'}
            </button>
          </header>
          <div className="p-2 space-y-1.5">
            {runs.length === 0 && <p className="text-[11px] text-scholar-500 px-1 py-1">点击"运行流程"发起第一次任务</p>}
            {runs.slice(0, 6).map(run => (
              <RunItem
                key={run.runDir}
                run={run}
                expanded={expandedRunDir === run.runDir}
                onToggle={() => setExpandedRunDir(expandedRunDir === run.runDir ? null : run.runDir)}
                onShowLog={() => setLogRunDir(run.runDir)}
                onShowReport={() => run.reportPath && setReportPath(run.reportPath)}
                onShowCode={() => setCodeRun(run)}
                onOpenFolder={() => handleOpenRunFolder(run.runDir)}
                onResume={acknowledgeFailedQc => void handleResumeRun(run, acknowledgeFailedQc)}
                resuming={resumingRunDir === run.runDir}
              />
            ))}
          </div>
        </section>
      </div>

      {/* 日志弹窗 */}
      {logRunDir && sessionId && (
        <LogDialog runDir={logRunDir} sessionId={sessionId} onClose={() => setLogRunDir(null)} />
      )}
      {/* 报告弹窗 */}
      {reportPath && sessionId && (
        <ReportDialog reportPath={reportPath} sessionId={sessionId} onClose={() => setReportPath(null)} />
      )}
      {codeRun && sessionId && (
        <RunCodeDialog
          run={codeRun}
          sessionId={sessionId}
          onClose={() => setCodeRun(null)}
          onRunUpdated={updated => {
            setRuns(current => mergeWorkflowRunUpdate(current, updated));
            setCodeRun(updated);
          }}
        />
      )}
      {/* 启动前整体检查：集中解答卡覆盖层（解答写回配置 → 重检通过才建运行） */}
      {preRunReport && (
        <div className="absolute inset-0 z-10 bg-scholar-900/95 overflow-y-auto p-3">
          <WorkflowPreflightCard
            workflow={workflow}
            report={preRunReport}
            paramValues={paramValues}
            stepValues={stepValues}
            refOverrides={refOverrides}
            inputs={inputs}
            onParamChange={(name, value) => setParamValues(prev => ({ ...prev, [name]: value }))}
            onStepParamChange={(step, name, value) => setStepValues(prev => ({ ...prev, [step]: { ...(prev[step] || {}), [name]: value } }))}
            onReferenceChange={handlePreRunReferenceChange}
            onInputChange={(index, value) => setInputs(list => list.map((p, i) => (i === index ? value : p)))}
            onProvision={handleProvision}
            onPickPath={onPickFolder}
            onRecheck={() => void checkBeforeRun()}
            onRunAnyway={() => void handlePreRunRunAnyway()}
            onCancel={() => setPreRunReport(null)}
            busy={preRunChecking || startingRun}
          />
        </div>
      )}
    </motion.div>
  );
}

/** 单个参数控件（全局参数与步骤参数共用；对话内配置卡也复用） */
export function ParamField({ param: p, value, onChange, onPickPath, required }: {
  param: Workflow['params'][number];
  value: string;
  onChange: (v: string) => void;
  /** path 型参数的集群路径选取入口：kind 限定选文件还是选目录 */
  onPickPath?: (kind: 'file' | 'folder') => void;
  required: boolean;
}) {
  const text = useWorkflowText();
  const wide = p.type === 'path' || !p.type || p.type === 'text';
  return (
    <label className={`block ${wide ? 'col-span-2' : ''}`}>
      <span className="text-[10px] text-scholar-400">{text(p.label || p.name)}
        {required
          ? <span className="text-red-400"> *</span>
          : <span className="text-scholar-500">({text('可选')}{p.defaultValue ? `, ${text('默认')} ${p.defaultValue}` : `, ${text('留空由 AI 处理')}`})</span>}
      </span>
      {p.type === 'select' ? (
        <select value={value} onChange={e => onChange(e.target.value)}
          className="mt-0.5 w-full bg-scholar-950 border border-scholar-600 rounded px-2 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-accent/50">
          <option value="">（未选择）</option>
          {(p.options || []).map(o => <option key={o} value={o}>{o}</option>)}
        </select>
      ) : p.type === 'number' ? (
        <input type="number" value={value} onChange={e => onChange(e.target.value)}
          min={p.min} max={p.max} step={p.step}
          placeholder={p.placeholder ? text(p.placeholder) : p.defaultValue}
          className="mt-0.5 w-full bg-scholar-950 border border-scholar-600 rounded px-2 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-accent/50" />
      ) : p.type === 'boolean' ? (
        <select value={value} onChange={e => onChange(e.target.value)}
          className="mt-0.5 w-full bg-scholar-950 border border-scholar-600 rounded px-2 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-accent/50">
          <option value="">（默认）</option>
          <option value="true">是</option>
          <option value="false">否</option>
        </select>
      ) : (
        <div className="mt-0.5 flex gap-1">
          <input value={value} onChange={e => onChange(e.target.value)}
            placeholder={p.placeholder ? text(p.placeholder) : p.defaultValue || p.name}
            className="flex-1 bg-scholar-950 border border-scholar-600 rounded px-2 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-accent/50" />
          {onPickPath && (
            <>
              <button type="button" onClick={() => onPickPath('file')}
                className="btn-ghost !text-[11px] !px-2 shrink-0" title="选择文件" aria-label="选择文件">
                <FileSearch className="w-3 h-3" />
              </button>
              <button type="button" onClick={() => onPickPath('folder')}
                className="btn-ghost !text-[11px] !px-2 shrink-0" title="选择目录" aria-label="选择目录">
                <FolderOpen className="w-3 h-3" />
              </button>
            </>
          )}
        </div>
      )}
      {p.help && <span className="mt-0.5 block text-[9px] text-scholar-500">{text(p.help)}</span>}
    </label>
  );
}

/** 环境项列表（软件或参考数据）：状态灯 + 校验 + 安装/选文件；对话内运行卡复用 */
export function EnvItems({ title, icon, items, checked, kind, itemBusy, onCheck, onProvision, onPickFile, overrides, sessionId, placeholderNames }: {
  title: string;
  icon: React.ReactNode;
  items: { name: string; ok: boolean; required: boolean; detail?: string }[];
  checked: boolean;
  kind: 'software' | 'references';
  itemBusy: Record<string, boolean>;
  onCheck: (name: string) => void;
  onProvision: (name: string, detail?: string) => void;
  onPickFile?: (name: string) => void;
  overrides?: Record<string, string>;
  sessionId?: string | null;
  placeholderNames?: string[];
}) {
  const text = useWorkflowText();
  if (items.length === 0) return null;
  return (
    <div>
      <p className="text-[10px] text-scholar-400 flex items-center gap-1 px-1 pt-1">{icon}{text(title)}</p>
      {items.map(item => {
        const busy = !!itemBusy[`${kind}:${item.name}`];
        const isParam = placeholderNames?.includes(item.name);
        // 未检查过（无结果或 detail 为"未检查"）显示灰色，不当作"未通过"
        const unchecked = !checked || !item.detail || item.detail === '未检查';
        const override = overrides?.[item.name];
        return (
          <div key={item.name} className="flex items-center gap-1.5 px-1 py-1">
            {override
              ? <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500 shrink-0" />
              : unchecked
              ? <Circle className="w-3.5 h-3.5 text-scholar-600 shrink-0" />
              : item.ok
                ? <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500 shrink-0" />
                : item.required
                  ? <XCircle className="w-3.5 h-3.5 text-red-400 shrink-0" />
                  : <AlertTriangle className="w-3.5 h-3.5 text-amber-500 shrink-0" />}
            <span className="text-[11px] text-scholar-200 shrink-0">{text(item.name)}</span>
            {!item.required && <span className="text-[9px] text-scholar-500 shrink-0">（可选）</span>}
            <span className="flex-1 text-[10px] text-scholar-500 truncate" title={override || item.detail || ''}>
              {override ? `${text('已指定：')}${override}` : isParam ? text('运行时由参数指定或 AI 协助准备') : unchecked ? text('未检查') : item.detail ? text(item.detail) : ''}
            </span>
            {kind === 'references' && onPickFile && (
              <button onClick={() => onPickFile(item.name)}
                className="text-[10px] text-accent hover:underline shrink-0 flex items-center gap-0.5"
                title="在文件传输工作区中选择该参考数据的实际文件/目录">
                <FolderOpen className="w-2.5 h-2.5" /> 选择文件
              </button>
            )}
            {!override && !unchecked && !item.ok && (
              <button onClick={() => onProvision(item.name, item.detail)}
                className="text-[10px] text-orange-400 hover:underline shrink-0 flex items-center gap-0.5">
                <Wrench className="w-2.5 h-2.5" /> 安装部署
              </button>
            )}
            {!isParam && (
              <button onClick={() => onCheck(item.name)} disabled={busy || !sessionId}
                className="text-[10px] text-accent hover:underline shrink-0 flex items-center gap-0.5">
                {busy ? <Loader2 className="w-2.5 h-2.5 animate-spin" /> : <RefreshCw className="w-2.5 h-2.5" />} 校验
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** 单次任务条目：状态、进度、步骤时间线（含起止时间）、日志/报告入口；对话内运行卡复用 */
export function RunItem({ run, expanded, onToggle, onShowLog, onShowReport, onShowCode, onOpenFolder, onResume, resuming }: {
  run: WorkflowRun;
  expanded: boolean;
  onToggle: () => void;
  onShowLog: () => void;
  onShowReport: () => void;
  onShowCode: () => void;
  onOpenFolder: () => void;
  onResume: (acknowledgeFailedQc?: boolean) => void;
  resuming: boolean;
}) {
  const t = useWorkflowText();
  const [reviewQc, setReviewQc] = useState(false);
  // A changed verdict/revision must be reviewed again, not acknowledged by a stale dialog.
  useEffect(() => setReviewQc(false), [run.revision]);
  const qcBlocked = unresolvedQcFailures(run).length > 0;
  const autoReview = needsAutomaticOutputReview(run);
  const st = run.stale
    ? { label: '疑似中断', cls: 'bg-gray-500/20 text-gray-400' }
    : autoReview ? { label: '自动验收中', cls: 'bg-accent/15 text-accent' } : RUN_STATUS[run.status] || RUN_STATUS.unknown;
  const total = run.totalSteps || run.steps?.length || 0;
  const current = run.currentStep ?? (run.steps?.filter(s => s.status === 'done').length ?? 0);
  const pct = total > 0 ? Math.round((current / total) * 100) : 0;
  const fmtTime = (ms?: number) => ms ? new Date(ms).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : '';
  const fmtDur = (a?: number, b?: number) => {
    if (!a || !b || b < a) return '';
    const sec = Math.round((b - a) / 1000);
    return sec < 60 ? `${sec}s` : `${Math.floor(sec / 60)}m${sec % 60 ? `${sec % 60}s` : ''}`;
  };
  const started = run.startedAt
    ? new Date(run.startedAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
    : '';
  const canResume = !!run.stale || (!autoReview && ['failed', 'waiting_user', 'blocked_env'].includes(run.status));

  return (
    <div className="bg-scholar-950/50 border border-scholar-700/50 rounded-lg">
      <button onClick={onToggle} className="w-full text-left p-2">
        <div className="flex items-center gap-1.5">
          {expanded ? <ChevronDown className="w-3 h-3 text-scholar-500 shrink-0" /> : <ChevronRight className="w-3 h-3 text-scholar-500 shrink-0" />}
          <span className="text-[11px] text-scholar-200 truncate flex-1">{run.runId || run.runDir.split('/').pop()}</span>
          <span className={`px-1.5 py-0.5 rounded text-[9px] shrink-0 ${st.cls}`}>{st.label}</span>
        </div>
        <div className="mt-1 flex items-center gap-2">
          <div className="flex-1 h-1 bg-scholar-700/60 rounded-full overflow-hidden">
            <div className={`h-full rounded-full transition-all ${run.status === 'failed' ? 'bg-red-500' : run.status === 'blocked_env' ? 'bg-orange-500' : 'bg-accent'}`}
              style={{ width: `${pct}%` }} />
          </div>
          <span className="text-[9px] text-scholar-500 shrink-0">{current}/{total} {started}</span>
        </div>
      </button>
      <WorkflowQcNotice run={run} />
      {qcBlocked && canResume && <div className="mx-2 mb-2 space-y-2 text-sm">
        {!reviewQc ? <div className="flex flex-wrap gap-2">
          <button type="button" onClick={onShowLog} className="btn-ghost !text-sm">{t('先检查质控日志')}</button>
          <button type="button" onClick={() => setReviewQc(true)} disabled={resuming} className="btn-ghost !text-sm" style={{ color: 'var(--color-danger)' }}>{t('仍要继续（不推荐）')}</button>
        </div> : <div className="rounded-lg border border-red-500/40 p-3">
          <p>{t('继续可能降低结论可靠性。请先核对质控报告；确认后仅允许推进，不会把 QC 改为通过。')}</p>
          <div className="mt-2 flex flex-wrap gap-2">
            <button type="button" onClick={() => setReviewQc(false)} disabled={resuming} className="btn-ghost !text-sm">{t('取消')}</button>
            <button type="button" onClick={() => { setReviewQc(false); onResume(true); }} disabled={resuming} className="btn-ghost !text-sm" style={{ color: 'var(--color-danger)' }}>{t('确认风险并继续')}</button>
          </div>
        </div>}
      </div>}
      {expanded && (
        <div className="px-3 pb-2 pt-1 space-y-1 border-t border-scholar-700/40">
          <p className="text-[9px] text-scholar-500 font-mono break-all" title={run.runDir}>工作目录：{run.runDir}</p>
          {run.codeDir && <p className="text-[9px] text-accent/80 font-mono break-all" title={run.codeDir}>运行代码：{run.codeDir}</p>}
          {run.stale && (
            <p className="text-[10px] text-gray-400 flex items-center gap-1">
              <AlertTriangle className="w-3 h-3" />
              超过 10 分钟无状态更新，AI 可能已中断。
              {run.jobStates && Object.values(run.jobStates).every(s => s === 'GONE' || s === 'DONE' || s === 'EXIT')
                ? ' 作业均已结束（bjobs 核实）。' : ''}
            </p>
          )}
          {/* 流程图：整条步骤链一眼看清任务走到哪里 */}
          {(run.steps || []).length > 0 && (
            <WorkflowFlowGraph steps={run.steps || []} currentStep={run.currentStep} />
          )}
          {(run.steps || []).map(s => (
            <div key={s.n} className="text-[11px]">
              <div className="flex items-center gap-1.5">
                {s.status === 'done' ? <CheckCircle2 className="w-3 h-3 text-emerald-500 shrink-0" />
                  : s.status === 'failed' ? <XCircle className="w-3 h-3 text-red-400 shrink-0" />
                  : s.status === 'running' ? <Loader2 className="w-3 h-3 text-sky-500 animate-spin shrink-0" />
                  : <Circle className="w-3 h-3 text-scholar-600 shrink-0" />}
                <span className="flex-1 min-w-0 truncate text-scholar-300">{s.n}. <span>{s.title}</span></span>
                {(s.startedAt || s.finishedAt) && (
                  <span className="text-[9px] text-scholar-500 shrink-0">
                    {fmtTime(s.startedAt)}{s.finishedAt ? `–${fmtTime(s.finishedAt)}` : ''}
                    {fmtDur(s.startedAt, s.finishedAt) ? `（${fmtDur(s.startedAt, s.finishedAt)}）` : ''}
                  </span>
                )}
                {s.qc && (
                  <span className={`text-[9px] px-1 rounded shrink-0 ${(QC_BADGE[s.qc.status] || QC_BADGE.pass).cls}`}>
                    {(QC_BADGE[s.qc.status] || QC_BADGE.pass).label}
                  </span>
                )}
              </div>
              {s.jobIds && s.jobIds.length > 0 && (
                <div className="pl-4 flex flex-wrap gap-1 mt-0.5">
                  {s.jobIds.map(id => (
                    <span key={id} className="text-[9px] text-scholar-400 bg-scholar-800/70 rounded px-1 py-0.5">
                      #{id}{run.jobStates?.[id] ? ` · ${run.jobStates[id]}` : ''}
                    </span>
                  ))}
                </div>
              )}
              {s.summary && <p className="pl-4 text-[10px] text-scholar-500 leading-snug">{s.summary}</p>}
              {s.scriptPath && (
                <p className="pl-4 text-[9px] text-scholar-500 font-mono truncate" title={s.scriptPath}>
                  {s.scriptUserModified ? '用户已修改 · ' : ''}{s.scriptPath.split('/').pop()}
                </p>
              )}
            </div>
          ))}
          <div className="flex gap-2 pt-1">
            <button onClick={onOpenFolder} className="btn-ghost !text-[10px] !px-2">
              <FolderOpen className="w-3 h-3" /> 打开运行文件夹
            </button>
            {canResume && !qcBlocked && (
              <button onClick={() => onResume()} disabled={resuming} className="btn-primary !text-[10px] !px-2">
                {resuming ? <Loader2 className="w-3 h-3 animate-spin" /> : <Play className="w-3 h-3" />}
                {run.status === 'blocked_env' ? '处理并继续' : '从断点继续'}
              </button>
            )}
            {run.codeDir && (
              <button onClick={onShowCode} className="btn-ghost !text-[10px] !px-2">
                <Code2 className="w-3 h-3" /> 查看/修改代码
              </button>
            )}
            <button onClick={onShowLog} className="btn-ghost !text-[10px] !px-2">
              <Terminal className="w-3 h-3" /> 查看日志
            </button>
            {run.reportPath && (
              <button onClick={onShowReport} className="btn-ghost !text-[10px] !px-2">
                <FileText className="w-3 h-3" /> 查看报告
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** 按步骤查看/修改本次运行真正使用的脚本；只读取选中的精确文件，不扫描其他目录。 */
export function RunCodeDialog({ run, sessionId, onClose, onRunUpdated }: {
  run: WorkflowRun;
  sessionId: string;
  onClose: () => void;
  onRunUpdated: (run: WorkflowRun) => void;
}) {
  const firstStep = run.steps?.find(step => step.status === 'running')?.n
    || run.steps?.find(step => step.status === 'pending' || step.status === 'failed')?.n
    || run.steps?.[0]?.n
    || 1;
  const [selectedStep, setSelectedStep] = useState(firstStep);
  const [content, setContent] = useState('');
  const [scriptPath, setScriptPath] = useState('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  useEffect(() => {
    let stopped = false;
    setLoading(true);
    setError('');
    setNotice('');
    void fetchWorkflowStepCode(run.runDir, selectedStep, sessionId)
      .then(code => {
        if (stopped) return;
        setContent(code.content);
        setScriptPath(code.scriptPath);
        setDirty(false);
      })
      .catch(err => { if (!stopped) setError(err?.message || String(err)); })
      .finally(() => { if (!stopped) setLoading(false); });
    return () => { stopped = true; };
  }, [run.runDir, selectedStep, sessionId]);

  const selectStep = (step: number) => {
    if (dirty && !window.confirm('当前脚本尚未保存，确定切换步骤吗？')) return;
    setSelectedStep(step);
  };

  const save = async () => {
    setSaving(true);
    setError('');
    setNotice('');
    try {
      const saved = await saveWorkflowStepCode(run.runDir, selectedStep, content, sessionId);
      setContent(saved.content);
      setScriptPath(saved.scriptPath);
      setDirty(false);
      setNotice('已保存。尚未提交或重试的步骤会使用这份脚本。');
      onRunUpdated(saved.run);
    } catch (err: any) {
      setError(err?.message || String(err));
    } finally {
      setSaving(false);
    }
  };

  const close = () => {
    if (dirty && !window.confirm('脚本尚未保存，确定关闭吗？')) return;
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/65 flex items-center justify-center p-4" onClick={close}>
      <div className="w-full max-w-6xl h-[88vh] bg-scholar-900 rounded-lg border border-scholar-700 flex flex-col overflow-hidden shadow-lg"
        onClick={event => event.stopPropagation()}>
        <header className="px-4 py-2.5 border-b border-scholar-700 flex items-center gap-2 shrink-0">
          <Code2 className="w-4 h-4 text-accent" />
          <div className="min-w-0 flex-1">
            <h3 className="text-sm font-medium text-scholar-100">本次运行代码（按步骤）</h3>
            <p className="text-[10px] text-scholar-500 font-mono truncate" title={run.codeDir || `${run.runDir}/code`}>
              {run.codeDir || `${run.runDir}/code`}
            </p>
          </div>
          <button onClick={close} className="btn-icon" aria-label="关闭代码编辑器"><X className="w-4 h-4" /></button>
        </header>
        <div className="flex-1 min-h-0 flex">
          <aside className="w-56 shrink-0 border-r border-scholar-700 overflow-y-auto p-2 space-y-1">
            {(run.steps || []).map(step => (
              <button key={step.n} type="button" onClick={() => selectStep(step.n)}
                className={`w-full text-left rounded-lg px-2.5 py-2 border ${selectedStep === step.n
                  ? 'border-accent/60 bg-accent/10 text-scholar-100'
                  : 'border-transparent hover:bg-scholar-800 text-scholar-300'}`}>
                <span className="block text-[11px] font-medium"><span>步骤</span> {step.n} · <span>{step.title}</span></span>
                <span className="block mt-0.5 text-[9px] text-scholar-500 font-mono">
                  step-{String(step.n).padStart(2, '0')}.sh{step.scriptUserModified ? ' · 用户已修改' : ''}
                </span>
              </button>
            ))}
          </aside>
          <main className="flex-1 min-w-0 flex flex-col">
            <div className="px-3 py-2 border-b border-scholar-700/60 flex items-center gap-2 shrink-0">
              <span className="text-[10px] text-scholar-400 font-mono truncate flex-1" title={scriptPath}>{scriptPath || '正在读取脚本…'}</span>
              {dirty && <span className="text-[10px] text-amber-400">未保存</span>}
              <button type="button" onClick={() => void save()} disabled={loading || saving || !dirty}
                className="btn-primary !text-[11px] !px-3 !py-1.5">
                {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
                {saving ? '保存中…' : '保存脚本'}
              </button>
            </div>
            <div className="px-3 py-2 bg-amber-500/8 border-b border-amber-500/20 text-[10px] text-amber-300 shrink-0">
              保存会影响尚未提交的步骤或失败后的重试；已经提交到 LSF/Slurm 的作业不会被中途改写。
            </div>
            {error && <p className="px-3 py-2 text-xs text-red-400 border-b border-red-500/20">{error}</p>}
            {notice && <p className="px-3 py-2 text-xs text-emerald-400 border-b border-emerald-500/20">{notice}</p>}
            {loading ? (
              <div className="flex-1 flex items-center justify-center text-scholar-500"><Loader2 className="w-5 h-5 animate-spin" /></div>
            ) : (
              <textarea value={content} onChange={event => { setContent(event.target.value); setDirty(true); setNotice(''); }}
                spellCheck={false} aria-label="步骤运行脚本"
                className="flex-1 min-h-0 w-full resize-none bg-[#0b0f16] text-emerald-300 font-mono text-xs leading-relaxed p-4 outline-none" />
            )}
          </main>
        </div>
      </div>
    </div>
  );
}

/** 终端风格日志弹窗：5 秒轮询 tail，自动滚底，显示日志来源文件 */
export function LogDialog({ runDir, sessionId, onClose }: { runDir: string; sessionId: string; onClose: () => void }) {
  const [log, setLog] = useState('加载中…');
  const [files, setFiles] = useState<string[]>([]);
  const preRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    let stopped = false;
    const load = async () => {
      try {
        const result = await fetchRunLog(runDir, sessionId, 300);
        if (!stopped) {
          setLog(result.log || '(暂无日志输出)');
          setFiles(result.files);
        }
      } catch (e: any) {
        if (!stopped) setLog(`日志读取失败：${e.message || e}`);
      }
    };
    void load();
    const timer = setInterval(load, 5_000);
    return () => { stopped = true; clearInterval(timer); };
  }, [runDir, sessionId]);

  useEffect(() => {
    if (preRef.current) preRef.current.scrollTop = preRef.current.scrollHeight;
  }, [log]);

  return (
    <div className="fixed inset-0 z-40 bg-black/60 flex items-center justify-center p-6" onClick={onClose}>
      <div className="w-full max-w-3xl h-[70vh] bg-[#0b1220] rounded-lg border border-scholar-700 flex flex-col overflow-hidden"
        onClick={e => e.stopPropagation()}>
        <div className="px-3 py-2 border-b border-scholar-700/60 flex items-center gap-2 shrink-0">
          <Terminal className="w-3.5 h-3.5 text-emerald-400" />
          <span className="text-xs text-scholar-200 flex-1 truncate font-mono">{runDir}</span>
          <span className="text-[10px] text-scholar-500">5s 自动刷新</span>
          <button onClick={onClose} className="btn-icon" aria-label="关闭"><X className="w-4 h-4" /></button>
        </div>
        {files.length > 0 && (
          <div className="px-3 py-1.5 border-b border-scholar-700/40 text-[10px] text-scholar-500 truncate shrink-0" title={files.join('\n')}>
            日志来源：{files.slice(0, 3).join('，')}{files.length > 3 ? ` 等 ${files.length} 个文件` : ''}
          </div>
        )}
        <pre ref={preRef} className="flex-1 overflow-auto p-3 text-[11px] leading-relaxed text-emerald-300/90 font-mono whitespace-pre-wrap break-all">{log}</pre>
      </div>
    </div>
  );
}

/** 报告弹窗：iframe 渲染自包含 report.html */
export function ReportDialog({ reportPath, sessionId, onClose }: { reportPath: string; sessionId: string; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-40 bg-black/60 flex items-center justify-center p-4" onClick={onClose}>
      <div className="w-full max-w-5xl h-[86vh] bg-white rounded-lg border border-scholar-700 flex flex-col overflow-hidden"
        onClick={e => e.stopPropagation()}>
        <div className="px-3 py-2 border-b border-scholar-200 flex items-center gap-2 shrink-0 bg-scholar-50">
          <FileText className="w-3.5 h-3.5 text-accent" />
          <span className="text-xs text-scholar-700 flex-1 truncate font-mono">{reportPath}</span>
          <a href={`/api/files/download?path=${encodeURIComponent(reportPath)}&sessionId=${encodeURIComponent(sessionId)}`}
            download className="text-[11px] text-accent hover:underline flex items-center gap-0.5">
            <Download className="w-3 h-3" /> 下载
          </a>
          <button onClick={onClose} className="btn-icon" aria-label="关闭"><X className="w-4 h-4" /></button>
        </div>
        <HtmlReportFrame path={reportPath} sessionId={sessionId} title="分析报告" />
      </div>
    </div>
  );
}
