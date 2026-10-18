import type { Express, Request, Response } from 'express';
import { loadWorkflows } from './workflowStore';
import { isPendingDisposal } from '../../shared/workflowCatalog';
import { readCachedPreflight, runPreflight } from './preflight';
import { runPreflightForConfig } from './preflightRun';
import {
  createWorkflowRun,
  readWorkflowStepCode,
  readWorkflowRun,
  sanitizeRunConfig,
  updateWorkflowRun,
  writeWorkflowStepCode,
  type RunExec,
} from './workflowRunService';
import type { WorkflowRunPatch } from '../../shared/workflowRun';
import type { WorkflowRun } from '../../shared/workflowRun';
import { qcPauseReason, unresolvedQcFailures } from '../../shared/workflowQc';

export interface WorkflowRunSession {
  sessionId: string;
  exec: RunExec;
  home: string;
  sftp?: { fastPut: (localPath: string, remotePath: string, cb: (err?: Error) => void) => void };
  /** 该集群登录探测到的调度器：步骤脚本的 #BSUB 指令按需翻译成 #SBATCH/#PBS（donau 暂按剥除处理） */
  scheduler?: 'lsf' | 'slurm' | 'pbs' | 'donau' | 'none';
}

export type WorkflowRunChanged = (sessionId: string, run: WorkflowRun) => void;

function sendError(res: Response, status: number, message: string): void {
  res.status(status).json({ success: false, error: message });
}

export function registerWorkflowRunRoutes(
  app: Express,
  resolveSession: (req: Request) => WorkflowRunSession | undefined,
  onRunChanged?: WorkflowRunChanged,
): void {
  // 启动前整体检查：按本次运行配置一次性扫描软件/参考数据/输入数据/参数/脚本占位符，
  // 返回集中问题清单供前端一次解答；body 与创建运行的 config 同形。
  app.post('/api/workflows/:id/preflight-run', async (req, res) => {
    try {
      const session = resolveSession(req);
      if (!session) return sendError(res, 401, '需要活跃的 SSH 会话');
      const workflow = (await loadWorkflows()).find(w => w.id === String(req.params.id));
      if (!workflow) return sendError(res, 404, '流程不存在');
      const report = await runPreflightForConfig(session.exec, workflow, req.body);
      res.json({ success: true, report });
    } catch (err: any) {
      sendError(res, 500, err?.message || String(err));
    }
  });

  app.post('/api/workflows/:id/runs', async (req, res) => {
    try {
      const session = resolveSession(req);
      if (!session) return sendError(res, 401, '需要活跃的 SSH 会话');
      const workflow = (await loadWorkflows()).find(w => w.id === String(req.params.id));
      if (!workflow) return sendError(res, 404, '流程不存在');
      if (isPendingDisposal(workflow)) return sendError(res, 409, '流程在待弃置中，请先恢复到正式流程再发起新运行；已有任务不受影响。');
      const hasRequiredEnvironment = !!workflow.manifest && [
        ...workflow.manifest.software,
        ...workflow.manifest.references,
      ].some(item => item.required);
      let preflight = await readCachedPreflight(session.exec, workflow);
      let preflightError = '';
      if (hasRequiredEnvironment && !preflight) {
        try {
          // 正式流程不再在环境未知时直接进入 running。缓存缺失或流程版本变化时，
          // 创建运行前自动执行一次当前版本预检。
          preflight = await runPreflight(session.exec, workflow);
        } catch (err) {
          preflightError = err instanceof Error ? err.message : String(err);
        }
      }
      const ready = hasRequiredEnvironment ? preflight?.ready === true : true;
      let run = await createWorkflowRun(session.exec, session.home, workflow, sanitizeRunConfig(req.body), ready, { sftp: session.sftp, scheduler: session.scheduler });
      if (!ready) {
        const error = preflightError
          ? `自动预检失败：${preflightError}`
          : '必要软件或参考数据未通过当前流程版本的预检。';
        run = await updateWorkflowRun(session.exec, session.home, run.runDir, { status: 'blocked_env', error });
      }
      onRunChanged?.(session.sessionId, run);
      res.status(201).json({ success: true, run });
    } catch (err: any) {
      sendError(res, 500, err?.message || String(err));
    }
  });

  app.get('/api/workflow-runs/item', async (req, res) => {
    try {
      const session = resolveSession(req);
      if (!session) return sendError(res, 401, '需要活跃的 SSH 会话');
      const run = await readWorkflowRun(session.exec, session.home, String(req.query.dir || ''));
      res.json({ success: true, run });
    } catch (err: any) {
      sendError(res, 400, err?.message || String(err));
    }
  });

  app.patch('/api/workflow-runs/item', async (req, res) => {
    try {
      const session = resolveSession(req);
      if (!session) return sendError(res, 401, '需要活跃的 SSH 会话');
      const runDir = String(req.body?.runDir || '');
      const patch = (req.body?.patch || {}) as WorkflowRunPatch;
      const run = await updateWorkflowRun(session.exec, session.home, runDir, patch);
      onRunChanged?.(session.sessionId, run);
      res.json({ success: true, run });
    } catch (err: any) {
      sendError(res, 400, err?.message || String(err));
    }
  });

  app.post('/api/workflow-runs/resume', async (req, res) => {
    try {
      const session = resolveSession(req);
      if (!session) return sendError(res, 401, '需要活跃的 SSH 会话');
      const runDir = String(req.body?.runDir || '');
      const current = await readWorkflowRun(session.exec, session.home, runDir);
      if (unresolvedQcFailures(current).length && req.body?.acknowledgeFailedQc !== true) {
        return sendError(res, 409, qcPauseReason(current));
      }
      if (current.status === 'done' || current.status === 'cancelled') {
        return sendError(res, 409, '已完成或已取消的流程不能继续；请新建一次运行');
      }
      if (current.status === 'waiting_jobs' && current.jobStates
        && Object.values(current.jobStates).some(state => !['DONE', 'EXIT', 'GONE'].includes(state))) {
        return sendError(res, 409, '后台作业仍在运行，监控器会自动继续，无需重复触发');
      }
      const expectedRevision = Number(req.body?.expectedRevision);
      const run = await updateWorkflowRun(session.exec, session.home, runDir, {
        expectedRevision: Number.isInteger(expectedRevision) ? expectedRevision : undefined,
        // 环境阻断仍保留阻断态，让 Agent 先完成环境修复；其余状态重新激活。
        status: current.status === 'blocked_env' ? 'blocked_env' : 'running',
        error: current.status === 'failed' || req.body?.acknowledgeFailedQc === true ? '' : current.error,
      }, { acknowledgeFailedQc: req.body?.acknowledgeFailedQc === true });
      onRunChanged?.(session.sessionId, run);
      res.json({ success: true, run });
    } catch (err: any) {
      sendError(res, 409, err?.message || String(err));
    }
  });

  app.get('/api/workflow-runs/code', async (req, res) => {
    try {
      const session = resolveSession(req);
      if (!session) return sendError(res, 401, '需要活跃的 SSH 会话');
      const runDir = String(req.query.dir || '');
      const stepNumber = Number(req.query.step);
      if (!Number.isInteger(stepNumber) || stepNumber < 1) return sendError(res, 400, '步骤编号无效');
      const code = await readWorkflowStepCode(session.exec, session.home, runDir, stepNumber);
      res.json({ success: true, code });
    } catch (err: any) {
      sendError(res, 400, err?.message || String(err));
    }
  });

  app.put('/api/workflow-runs/code', async (req, res) => {
    try {
      const session = resolveSession(req);
      if (!session) return sendError(res, 401, '需要活跃的 SSH 会话');
      const runDir = String(req.body?.runDir || '');
      const stepNumber = Number(req.body?.step);
      if (!Number.isInteger(stepNumber) || stepNumber < 1) return sendError(res, 400, '步骤编号无效');
      const code = await writeWorkflowStepCode(session.exec, session.home, runDir, stepNumber, req.body?.content);
      onRunChanged?.(session.sessionId, code.run);
      res.json({ success: true, code });
    } catch (err: any) {
      sendError(res, 400, err?.message || String(err));
    }
  });
}
