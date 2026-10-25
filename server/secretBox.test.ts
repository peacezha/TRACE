import { afterEach, describe, expect, it, vi } from 'vitest';
import { decryptSecret, encryptSecret } from './secretBox';

const KEY_A = 'a'.repeat(64); // 32 字节 hex
const KEY_B = 'b'.repeat(64);

describe('secretBox', () => {
  const originalKey = process.env.TRACE_ENCRYPTION_KEY;

  afterEach(() => {
    if (originalKey === undefined) delete process.env.TRACE_ENCRYPTION_KEY;
    else process.env.TRACE_ENCRYPTION_KEY = originalKey;
  });

  it('加解密往返：密文带 enc:v1: 前缀且不含明文', () => {
    process.env.TRACE_ENCRYPTION_KEY = KEY_A;
    const encrypted = encryptSecret('sk-secret-123');
    expect(encrypted.startsWith('enc:v1:')).toBe(true);
    expect(encrypted).not.toContain('sk-secret-123');
    expect(decryptSecret(encrypted)).toBe('sk-secret-123');
  });

  it('同一明文每次加密结果不同（随机 IV）', () => {
    process.env.TRACE_ENCRYPTION_KEY = KEY_A;
    expect(encryptSecret('same')).not.toBe(encryptSecret('same'));
  });

  it('历史明文（非 enc:v1: 前缀）解密时原样返回', () => {
    process.env.TRACE_ENCRYPTION_KEY = KEY_A;
    expect(decryptSecret('plain-api-key')).toBe('plain-api-key');
  });

  it('密钥不符或密文篡改：解密返回空串', () => {
    process.env.TRACE_ENCRYPTION_KEY = KEY_A;
    const encrypted = encryptSecret('value-1');

    process.env.TRACE_ENCRYPTION_KEY = KEY_B;
    expect(decryptSecret(encrypted)).toBe('');

    process.env.TRACE_ENCRYPTION_KEY = KEY_A;
    const tampered = `${encrypted.slice(0, -3)}AAA`;
    expect(decryptSecret(tampered)).toBe('');
    expect(decryptSecret('enc:v1:not-base64!!')).toBe('');
  });

  it('无密钥（开发模式）：加解密透传明文，且只告警一次', async () => {
    delete process.env.TRACE_ENCRYPTION_KEY;
    vi.resetModules(); // warn-once 是模块级状态，重新导入拿到干净模块
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const fresh = await import('./secretBox');
      expect(fresh.encryptSecret('abc')).toBe('abc');
      expect(fresh.encryptSecret('def')).toBe('def');
      expect(fresh.decryptSecret('plain-text')).toBe('plain-text');
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  it('无密钥时遇到 enc:v1: 密文返回空串（解不开按未配置处理）', async () => {
    delete process.env.TRACE_ENCRYPTION_KEY;
    vi.resetModules();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const fresh = await import('./secretBox');
      expect(fresh.decryptSecret('enc:v1:AAAA:BBBB:CCCC')).toBe('');
    } finally {
      warn.mockRestore();
    }
  });

  it('桌面模式缺少加密密钥时拒绝明文落盘，纯开发模式仍可透传', () => {
    delete process.env.TRACE_ENCRYPTION_KEY;
    process.env.TRACE_DESKTOP_TOKEN = 'desktop-test-token';
    try {
      expect(() => encryptSecret('must-not-be-plaintext')).toThrow('拒绝明文落盘');
    } finally {
      delete process.env.TRACE_DESKTOP_TOKEN;
    }
    expect(encryptSecret('development-only')).toBe('development-only');
  });

  it('空值与已加密值的幂等处理', () => {
    process.env.TRACE_ENCRYPTION_KEY = KEY_A;
    expect(encryptSecret('')).toBe('');
    expect(decryptSecret('')).toBe('');
    const encrypted = encryptSecret('x');
    expect(encryptSecret(encrypted)).toBe(encrypted); // 不二次加密
  });
});
