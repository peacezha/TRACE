// 服务端落盘密钥的对称加密封装：AES-256-GCM，密文格式 enc:v1:<iv>:<tag>:<data>（base64）。
// 密钥由 Electron 主进程生成并经 TRACE_ENCRYPTION_KEY（hex，32 字节）注入；
// 未注入时（纯 tsx 开发模式）加解密均透传明文，保证 dev 模式无需密钥即可运行。
// 向后兼容：decryptSecret 对非 enc:v1: 前缀的历史明文原样返回，下次保存时自动加密。
import crypto from 'node:crypto';

const PREFIX = 'enc:v1:';
let warnedNoKey = false;
let warnedDecryptFailure = false;

function loadKey(): Buffer | null {
  const hex = (process.env.TRACE_ENCRYPTION_KEY || '').trim();
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) return null;
  return Buffer.from(hex, 'hex');
}

function warnNoKeyOnce(): void {
  if (warnedNoKey) return;
  warnedNoKey = true;
  console.warn('[secretBox] 未设置 TRACE_ENCRYPTION_KEY，落盘密钥按明文透传存储（开发模式行为）');
}

/** 加密落盘密钥；无密钥时透传明文（开发模式）。已是 enc:v1: 密文的值原样返回，避免二次加密。 */
export function encryptSecret(plain: string): string {
  if (!plain) return plain ?? '';
  if (plain.startsWith(PREFIX)) return plain;
  const key = loadKey();
  if (!key) {
    if (process.env.TRACE_DESKTOP_TOKEN) {
      throw new Error('桌面加密密钥不可用，已拒绝明文落盘');
    }
    warnNoKeyOnce();
    return plain;
  }
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + [iv, tag, data].map(b => b.toString('base64')).join(':');
}

/** 解密落盘密钥；非 enc:v1: 前缀的历史明文原样返回。解不开（无密钥/密钥不符/密文损坏）时返回空串。 */
export function decryptSecret(value: string): string {
  if (!value) return value ?? '';
  if (!value.startsWith(PREFIX)) return value;
  const key = loadKey();
  if (!key) {
    warnNoKeyOnce();
    return '';
  }
  try {
    const [iv, tag, data] = value.slice(PREFIX.length).split(':').map(part => Buffer.from(part, 'base64'));
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  } catch (err) {
    if (!warnedDecryptFailure) {
      warnedDecryptFailure = true;
      console.warn('[secretBox] 密钥解密失败（密钥不符或密文损坏），按未配置处理:', (err as Error)?.message || err);
    }
    return '';
  }
}
