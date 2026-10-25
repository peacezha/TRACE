// @vitest-environment jsdom
// 桌面端加密存储通道：aiProfile/totpStorage 的水合、迁移与 write-through 行为
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

function createDesktopSecrets(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    get: vi.fn(async (key: string) => map.get(key) ?? ''),
    set: vi.fn(async (key: string, value: string) => { map.set(key, value); }),
    delete: vi.fn(async (key: string) => { map.delete(key); }),
    has: (key: string) => map.has(key),
    value: (key: string) => map.get(key),
  };
}

async function loadModules() {
  vi.resetModules();
  const aiProfile = await import('./aiProfile');
  const totpStorage = await import('./totpStorage');
  return { aiProfile, totpStorage };
}

describe('桌面端加密存储：水合与迁移', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
    delete (window as any).traceDesktop;
  });

  it('aiProfile：localStorage 历史明文在水合时迁入加密存储并删除明文', async () => {
    localStorage.setItem('trace_ai_profile', JSON.stringify({ provider: 'deepseek', model: 'deepseek-chat', apiKey: 'sk-plain' }));
    localStorage.setItem('ai_api_key', 'sk-plain');
    const secrets = createDesktopSecrets();
    (window as any).traceDesktop = { secrets };
    const { aiProfile } = await loadModules();

    await aiProfile.hydrateAIProfile();

    expect(secrets.set).toHaveBeenCalledWith('aiProfile', expect.stringContaining('sk-plain'));
    expect(localStorage.getItem('trace_ai_profile')).toBeNull();
    expect(localStorage.getItem('ai_api_key')).toBeNull();
    expect(aiProfile.loadAIProfile().apiKey).toBe('sk-plain');
  });

  it('aiProfile：加密存储已有值时优先使用，保存走加密存储不写 localStorage', async () => {
    const stored = JSON.stringify({ provider: 'openai', model: 'gpt-4o', apiKey: 'sk-enc' });
    const secrets = createDesktopSecrets({ aiProfile: stored });
    (window as any).traceDesktop = { secrets };
    const { aiProfile } = await loadModules();

    await aiProfile.hydrateAIProfile();
    expect(aiProfile.loadAIProfile().apiKey).toBe('sk-enc');

    aiProfile.saveAIProfile({ provider: 'openai', model: 'gpt-4o-mini', apiKey: 'sk-new' });
    expect(secrets.set).toHaveBeenCalledWith('aiProfile', expect.stringContaining('sk-new'));
    expect(localStorage.getItem('ai_api_key')).toBeNull();
    expect(aiProfile.loadAIProfile().apiKey).toBe('sk-new');
  });

  it('totpStorage：TOTP 种子与记住密码在水合时迁入加密存储', async () => {
    localStorage.setItem('trace_totp_secret', 'JBSWY3DPEHPK3PXP');
    localStorage.setItem('trace_saved_password', 'pw-123');
    const secrets = createDesktopSecrets();
    (window as any).traceDesktop = { secrets };
    const { totpStorage } = await loadModules();

    await totpStorage.hydrateTotpStorage();

    expect(secrets.value('totpSecret')).toBe('JBSWY3DPEHPK3PXP');
    expect(secrets.value('clusterPassword')).toBe('pw-123');
    expect(localStorage.getItem('trace_totp_secret')).toBeNull();
    expect(localStorage.getItem('trace_saved_password')).toBeNull();
    expect(totpStorage.getStoredSecret()).toBe('JBSWY3DPEHPK3PXP');
    expect(totpStorage.getSavedPassword()).toBe('pw-123');
  });

  it('totpStorage：桌面端写入走加密存储，清除凭据走 delete', async () => {
    const secrets = createDesktopSecrets({ totpSecret: 'AAA', clusterPassword: 'pw' });
    (window as any).traceDesktop = { secrets };
    const { totpStorage } = await loadModules();
    await totpStorage.hydrateTotpStorage();

    totpStorage.storeSecret('BBB');
    expect(secrets.value('totpSecret')).toBe('BBB');
    expect(totpStorage.getStoredSecret()).toBe('BBB');
    expect(localStorage.getItem('trace_totp_secret')).toBeNull();

    totpStorage.clearSavedCredentials();
    expect(totpStorage.getSavedPassword()).toBe('');
    expect(secrets.has('clusterPassword')).toBe(false);
    // TOTP 种子是应用配置，clearSavedCredentials 不清
    expect(totpStorage.getStoredSecret()).toBe('BBB');
  });

  it('桌面加密写入失败：仅保留内存值并提示，不回退 localStorage 明文', async () => {
    localStorage.setItem('ai_api_key', 'sk-old');
    localStorage.setItem('trace_totp_secret', 'OLDSECRET');
    localStorage.setItem('trace_saved_password', 'old-pw');
    const secrets = {
      get: vi.fn(async () => { throw new Error('safeStorage unavailable'); }),
      set: vi.fn(async () => { throw new Error('safeStorage unavailable'); }),
      delete: vi.fn(async () => { throw new Error('safeStorage unavailable'); }),
    };
    (window as any).traceDesktop = { secrets };
    const persistenceError = vi.fn();
    window.addEventListener('trace-persistence-error', persistenceError);
    const { aiProfile, totpStorage } = await loadModules();

    await aiProfile.hydrateAIProfile();
    await totpStorage.hydrateTotpStorage();
    expect(aiProfile.loadAIProfile().apiKey).toBe('');
    expect(totpStorage.getStoredSecret()).toBe('');
    expect(totpStorage.getSavedPassword()).toBe('');

    aiProfile.saveAIProfile({ provider: 'openai', model: 'gpt-4o', apiKey: 'sk-memory' });
    totpStorage.storeSecret('MEMORYSECRET');
    totpStorage.savePassword('memory-pw');
    await vi.waitFor(() => expect(persistenceError).toHaveBeenCalled());
    expect(aiProfile.loadAIProfile().apiKey).toBe('sk-memory');
    expect(totpStorage.getStoredSecret()).toBe('MEMORYSECRET');
    expect(totpStorage.getSavedPassword()).toBe('memory-pw');
    expect(localStorage.getItem('ai_api_key')).toBe('sk-old');
    expect(localStorage.getItem('trace_totp_secret')).toBe('OLDSECRET');
    expect(localStorage.getItem('trace_saved_password')).toBe('old-pw');
    window.removeEventListener('trace-persistence-error', persistenceError);
  });

  it('浏览器开发模式：无桌面通道时维持 localStorage 现状行为', async () => {
    const { aiProfile, totpStorage } = await loadModules();

    await aiProfile.hydrateAIProfile(); // no-op
    await totpStorage.hydrateTotpStorage(); // no-op

    aiProfile.saveAIProfile({ provider: 'deepseek', model: 'deepseek-chat', apiKey: 'sk-dev' });
    expect(localStorage.getItem('ai_api_key')).toBe('sk-dev');

    totpStorage.storeSecret('DEVSECRET');
    totpStorage.savePassword('dev-pw');
    expect(localStorage.getItem('trace_totp_secret')).toBe('DEVSECRET');
    expect(localStorage.getItem('trace_saved_password')).toBe('dev-pw');
  });
});
