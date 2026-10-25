import {
  DEFAULT_AGENT_COMMANDS,
  DEFAULT_AGENT_STEPS,
  MAX_AGENT_COMMANDS,
  MAX_AGENT_STEPS,
  MIN_AGENT_COMMANDS,
  MIN_AGENT_STEPS,
} from '../../shared/agentLimits';

import { isPublicWeb, readPublicPreference, savePublicPreference } from './publicWeb';
export type AgentPlanningPolicy = 'auto' | 'always';
export type AgentConfirmationPolicy = 'never' | 'dangerous' | 'state_changes' | 'every_command';
export type AgentPathPolicy = 'full_access' | 'scoped';
export type AgentEnginePreference = 'auto' | 'native' | 'dsh';
export type AgentPlanReviewPolicy = 'auto' | 'always';

export interface AgentSettings {
  engine: AgentEnginePreference;
  planningPolicy: AgentPlanningPolicy;
  confirmationPolicy: AgentConfirmationPolicy;
  pathPolicy: AgentPathPolicy;
  maxCommands: number;
  maxSteps: number;
  /** 计划审批：auto = 计划步数 ≥3 或含作业提交/写文件类步骤才审；always = 逢计划必审。 */
  planReview: AgentPlanReviewPolicy;
}

const STORAGE_KEY = 'trace_agent_settings';
const STORAGE_VERSION = 6;
const LEGACY_DEFAULT_MAX_STEPS = 50;

export function normalizeAgentSettings(value: unknown): AgentSettings {
  const raw = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  return {
    engine: raw.engine === 'native' || raw.engine === 'dsh' ? raw.engine : 'auto',
    planningPolicy: raw.planningPolicy === 'always' ? 'always' : 'auto',
    confirmationPolicy: raw.confirmationPolicy === 'never' || raw.confirmationPolicy === 'state_changes' || raw.confirmationPolicy === 'every_command'
      ? raw.confirmationPolicy
      : 'dangerous',
    pathPolicy: raw.pathPolicy === 'full_access' ? 'full_access' : 'scoped',
    maxCommands: Math.max(MIN_AGENT_COMMANDS, Math.min(MAX_AGENT_COMMANDS, Number(raw.maxCommands) || DEFAULT_AGENT_COMMANDS)),
    maxSteps: Math.max(MIN_AGENT_STEPS, Math.min(MAX_AGENT_STEPS, Number(raw.maxSteps) || DEFAULT_AGENT_STEPS)),
    planReview: raw.planReview === 'always' ? 'always' : 'auto',
  };
}

export function loadAgentSettings(): AgentSettings {
  try {
    const stored = JSON.parse((isPublicWeb() ? readPublicPreference(STORAGE_KEY) : localStorage.getItem(STORAGE_KEY)) || '{}');
    const migrated = stored && typeof stored === 'object' ? { ...stored } : {};
    // 旧版没有暴露 maxSteps 设置，并会把默认值 50 写进 localStorage。
    // 只迁移这个不可配置的旧默认值；新版中用户主动选择的 50 会保留。
    if (stored && typeof stored === 'object'
      && stored.version !== STORAGE_VERSION
      && Number(stored.maxSteps) === LEGACY_DEFAULT_MAX_STEPS) {
      migrated.maxSteps = DEFAULT_AGENT_STEPS;
    }
    // v0.4.57 起默认确认策略恢复为“仅危险操作确认”(dangerous)：0.4.16-0.4.56
    // 期间默认/迁移成的 never 让 Agent 不做任何确认就执行写操作与作业提交，
    // 用户反馈“一股脑干活不听指挥”。仅迁移旧版本存储；用户在本版主动选择
    // never 后会随 version=6 保留。
    // planReview 是 v6 新增字段：旧存储没有它，normalize 时落入默认 auto，无需额外迁移。
    if (stored && typeof stored === 'object'
      && stored.version !== STORAGE_VERSION
      && (stored.confirmationPolicy === undefined || stored.confirmationPolicy === 'never' || stored.confirmationPolicy === 'dangerous')) {
      migrated.confirmationPolicy = 'dangerous';
    }
    return normalizeAgentSettings(migrated);
  } catch {
    return normalizeAgentSettings({});
  }
}

export function saveAgentSettings(value: unknown): AgentSettings {
  const normalized = normalizeAgentSettings(value);
  const valueToSave = JSON.stringify({ version: STORAGE_VERSION, ...normalized });
  if (isPublicWeb()) savePublicPreference(STORAGE_KEY, valueToSave);
  else localStorage.setItem(STORAGE_KEY, valueToSave);
  return normalized;
}
