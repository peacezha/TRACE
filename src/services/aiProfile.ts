import { desktopSecrets } from './desktopSecrets';
import { isPublicWeb, getPublicCluster } from './publicWeb';

export type AIProvider = 'gemini' | 'openai' | 'deepseek' | 'grok' | 'moonshot' | 'custom-openai';

export interface AIProfile {
  provider: AIProvider;
  baseUrl?: string;
  model: string;
  apiKey: string;
  name?: string;
  temperature?: number;
}

export type AIProfileInput = Omit<Partial<AIProfile>, 'provider'> & { provider?: string };

export const PROVIDER_MODELS: Record<AIProvider, string[]> = {
  deepseek: ['deepseek-flash', 'deepseek-v4-pro'],
  openai: ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo'],
  gemini: ['gemini-3.1-pro-preview', 'gemini-3.1-flash-preview', 'gemini-2.5-flash'],
  grok: ['grok-2', 'grok-2-latest'],
  moonshot: ['moonshot-v1-8k', 'moonshot-v1-32k', 'moonshot-v1-128k'],
  'custom-openai': ['custom-model'],
};

export const PROVIDER_LABELS: Record<AIProvider, string> = {
  deepseek: 'DeepSeek',
  openai: 'OpenAI',
  gemini: 'Gemini',
  grok: 'Grok',
  moonshot: 'Moonshot/Kimi',
  'custom-openai': 'Custom OpenAI-compatible',
};

const STORAGE_KEY = 'trace_ai_profile';
// 桌面端加密存储中本模块使用的 key（secret-store.cjs 白名单内）
const DESKTOP_SECRET_KEY = 'aiProfile';
const LEGACY_KEYS = ['ai_provider', 'ai_model', 'ai_api_key', 'ai_base_url'];

// 模块级内存缓存：AI 补全按键路径（aiTerminal.requestAutocomplete）每键都会调
// loadAIProfile，未命中时还要连读 4 个 legacy key；缓存后仅首次读存储。
// 一致性：仅本模块写这些 key，saveAIProfile 时同步缓存；另监听已有的
// trace-ai-profile-change 事件兜底，不引入跨窗口 storage 事件复杂度。
let profileCache: AIProfile | null = null;
const publicProfiles = new Map<string, AIProfile>();

if (typeof window !== 'undefined') {
  window.addEventListener('trace-ai-profile-change', (event) => {
    profileCache = (event as CustomEvent<AIProfile>).detail ?? null;
  });
}

function normalizeProvider(value: string | null | undefined): AIProvider {
  if (value === 'kimi') return 'moonshot';
  if (value === 'gemini' || value === 'openai' || value === 'deepseek' || value === 'grok' || value === 'moonshot' || value === 'custom-openai') {
    return value;
  }
  return 'deepseek';
}

export function normalizeAIProfile(input: AIProfileInput = {}): AIProfile {
  const provider = normalizeProvider(input.provider);
  const model = input.model?.trim() || PROVIDER_MODELS[provider][0];
  return {
    provider,
    baseUrl: input.baseUrl?.trim() || undefined,
    model,
    apiKey: input.apiKey?.trim() || '',
    name: input.name?.trim() || undefined,
    temperature: typeof input.temperature === 'number' ? input.temperature : 0.1,
  };
}

// 从 localStorage 读取（浏览器开发模式的回退路径，也是桌面端历史明文的迁移来源）
function loadFromLocalStorage(): AIProfile {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) return normalizeAIProfile(JSON.parse(stored));
  } catch {
    // Fall through to legacy keys.
  }
  return normalizeAIProfile({
    provider: localStorage.getItem('ai_provider') || undefined,
    model: localStorage.getItem('ai_model') || undefined,
    apiKey: localStorage.getItem('ai_api_key') || undefined,
    baseUrl: localStorage.getItem('ai_base_url') || undefined,
  });
}

function writeToLocalStorage(profile: AIProfile): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(profile));
  localStorage.setItem('ai_provider', profile.provider);
  localStorage.setItem('ai_model', profile.model);
  localStorage.setItem('ai_api_key', profile.apiKey);
  if (profile.baseUrl) localStorage.setItem('ai_base_url', profile.baseUrl);
  else localStorage.removeItem('ai_base_url');
}

// 密钥已入桌面端加密存储后，清掉 localStorage 里的历史明文
function clearPlaintextStorage(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
    for (const key of LEGACY_KEYS) localStorage.removeItem(key);
  } catch { /* localStorage unavailable */ }
}

/**
 * 启动时水合（main.tsx 首帧渲染前调用）：桌面端从 safeStorage 加密存储读取
 * AI 配置填充缓存；localStorage 里的历史明文自动搬迁到加密存储并删除明文。
 * 浏览器开发模式（无桌面通道）为 no-op，loadAIProfile 继续走 localStorage。
 */
export async function hydrateAIProfile(): Promise<void> {
  if (isPublicWeb()) { clearPlaintextStorage(); profileCache = normalizeAIProfile(); return; }
  const desktop = desktopSecrets();
  if (!desktop) return;
  try {
    const stored = await desktop.get(DESKTOP_SECRET_KEY);
    if (stored) {
      profileCache = normalizeAIProfile(JSON.parse(stored));
      clearPlaintextStorage();
      return;
    }
    const legacy = loadFromLocalStorage();
    if (legacy.apiKey) {
      await desktop.set(DESKTOP_SECRET_KEY, JSON.stringify(legacy));
      clearPlaintextStorage();
    }
    profileCache = legacy;
  } catch (err) {
    // 生产桌面端不得因 safeStorage 故障回退到 localStorage 明文。
    profileCache = normalizeAIProfile();
    console.warn('[aiProfile] 加密存储水合失败，仅使用内存配置:', err);
    window.dispatchEvent(new CustomEvent('trace-persistence-error', {
      detail: '桌面加密存储不可用，AI 密钥仅保留在当前内存中，不会写入明文存储。',
    }));
  }
}

export function loadAIProfile(sessionId = getPublicCluster()): AIProfile {
  if (isPublicWeb()) return sessionId ? publicProfiles.get(sessionId) || normalizeAIProfile() : normalizeAIProfile();
  if (profileCache) return profileCache;
  // legacy key 派生的结果同样缓存——未命中时连读 4 次正是要消除的开销
  profileCache = desktopSecrets() ? normalizeAIProfile() : loadFromLocalStorage();
  return profileCache;
}

export function saveAIProfile(profile: AIProfileInput, sessionId = getPublicCluster()): AIProfile {
  const normalized = normalizeAIProfile(profile);
  if (isPublicWeb()) {
    if (sessionId) publicProfiles.set(sessionId, normalized);
    return normalized;
  }
  profileCache = normalized; // 本模块写入即同步缓存
  const desktop = desktopSecrets();
  if (desktop) {
    // 桌面端：密文写 safeStorage 存储（同步 API 下 IPC 为异步 fire-and-forget），
    // 成功后清掉历史明文；失败时保留内存值并提示，绝不写入 localStorage 明文。
    desktop.set(DESKTOP_SECRET_KEY, JSON.stringify(normalized))
      .then(() => clearPlaintextStorage())
      .catch(err => {
        console.warn('[aiProfile] 加密存储写入失败，仅保留内存配置:', err);
        window.dispatchEvent(new CustomEvent('trace-persistence-error', {
          detail: 'AI 密钥保存到桌面加密存储失败，当前仅在内存中生效，重启后需重新配置。',
        }));
      });
  } else if (!isPublicWeb()) {
    writeToLocalStorage(normalized);
  }
  window.dispatchEvent(new CustomEvent('trace-ai-profile-change', { detail: normalized }));
  return normalized;
}

export function isAIProfileConfigured(profile: AIProfile): boolean {
  return !!profile.apiKey && !!profile.model;
}
