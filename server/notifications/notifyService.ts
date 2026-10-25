// 通知服务：作业完成时通过 Server酱 / PushPlus / 企业微信 / 邮件 提醒用户。
// sendKey/token/webhook/smtpPass 均落盘为 AES-256-GCM 密文（secretBox），历史明文读取后自动迁移。
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { dataPath } from '../paths';
import { decryptSecret, encryptSecret } from '../secretBox';
import { resolveClusterAddress } from '../publicWeb/network';

export type NotifyChannel = 'serverchan' | 'pushplus' | 'wecom' | 'feishu' | 'email';

export interface NotifyConfig {
  enabled: boolean;
  channel: NotifyChannel;
  // Server酱（sct.ftqq.com）
  sendKey?: string;
  // PushPlus（pushplus.plus）
  token?: string;
  // 企业微信群机器人
  webhook?: string;
  // 邮件（QQ/163 邮箱授权码）
  smtpHost?: string;
  smtpPort?: number;
  smtpUser?: string;
  smtpPass?: string;
  mailTo?: string;
}

const CONFIG_PATH = dataPath('notify-config.json');

export const DEFAULT_NOTIFY_CONFIG: NotifyConfig = {
  enabled: false,
  channel: 'serverchan',
};

const SECRET_FIELDS = ['sendKey', 'token', 'webhook', 'smtpPass'] as const;

export async function loadNotifyConfig(): Promise<NotifyConfig> {
  let stored: NotifyConfig;
  try {
    const raw = await fs.readFile(CONFIG_PATH, 'utf-8');
    stored = { ...DEFAULT_NOTIFY_CONFIG, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_NOTIFY_CONFIG };
  }

  const config = { ...stored };
  let needsMigration = false;
  for (const field of SECRET_FIELDS) {
    const value = stored[field];
    if (!value) continue;
    if (encryptSecret(value) !== value) needsMigration = true;
    config[field] = decryptSecret(value);
  }
  if (needsMigration) {
    try { await saveNotifyConfig(config); }
    catch (err) { console.warn('[notifyService] 历史明文密钥迁移失败:', err); }
  } else {
    await fs.chmod(CONFIG_PATH, 0o600).catch(() => { /* Windows/不支持 chmod 的文件系统 */ });
  }
  return config;
}

export async function saveNotifyConfig(config: NotifyConfig): Promise<void> {
  await fs.mkdir(path.dirname(CONFIG_PATH), { recursive: true, mode: 0o700 });
  const toWrite = { ...config };
  for (const field of SECRET_FIELDS) {
    if (toWrite[field]) toWrite[field] = encryptSecret(toWrite[field]);
  }
  const tmp = `${CONFIG_PATH}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(toWrite, null, 2), { encoding: 'utf-8', mode: 0o600 });
  await fs.rename(tmp, CONFIG_PATH);
  await fs.chmod(CONFIG_PATH, 0o600);
}

function formEncode(fields: Record<string, string>): string {
  return Object.entries(fields)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
}

async function postJson(url: string, body: unknown, timeoutMs = 15_000): Promise<{ ok: boolean; error?: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}: ${text.slice(0, 200)}` };
    // 飞书/企业微信等在 HTTP 200 里也可能返回业务错误码
    try {
      const parsed = JSON.parse(text);
      const code = parsed.code ?? parsed.errcode ?? 0;
      if (typeof code === 'number' && code !== 0 && code !== 200) {
        return { ok: false, error: text.slice(0, 200) };
      }
    } catch { /* 非 JSON 响应视为成功 */ }
    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) };
  } finally {
    clearTimeout(timer);
  }
}

async function postForm(url: string, fields: Record<string, string>, timeoutMs = 15_000): Promise<{ ok: boolean; error?: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: formEncode(fields),
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}: ${text.slice(0, 200)}` };
    // Server酱/PushPlus 在 200 里也可能返回错误码
    if (/"code"\s*:\s*0(?!\d)/.test(text) || /"code"\s*:\s*200(?!\d)/.test(text)) return { ok: true };
    try {
      const parsed = JSON.parse(text);
      if (parsed.code === 0 || parsed.code === 200 || parsed.errcode === 0 || parsed.errmsg === 'ok') return { ok: true };
      return { ok: false, error: text.slice(0, 200) };
    } catch {
      return { ok: true };
    }
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) };
  } finally {
    clearTimeout(timer);
  }
}

/** 发送通知。返回 { ok, error? }；配置不完整时报错说明缺什么。 */
export async function sendNotification(
  config: NotifyConfig,
  title: string,
  content: string,
): Promise<{ ok: boolean; error?: string }> {
  switch (config.channel) {
    case 'serverchan': {
      if (!config.sendKey) return { ok: false, error: '缺少 Server酱 SendKey' };
      const key = config.sendKey.trim();
      // 新版 sctp 密钥按分片号路由，老版 SCU 密钥走 sctapi
      const shard = key.match(/^sctp(\d+)t/i)?.[1];
      const base = shard ? `https://sctp${shard}-api.ftqq.com` : 'https://sctapi.ftqq.com';
      return postForm(`${base}/${key}.send`, { title, desp: content });
    }
    case 'pushplus': {
      if (!config.token) return { ok: false, error: '缺少 PushPlus token' };
      return postJson('https://www.pushplus.plus/send', {
        token: config.token.trim(),
        title,
        content,
        template: 'markdown',
      });
    }
    case 'wecom': {
      if (!config.webhook) return { ok: false, error: '缺少企业微信机器人 Webhook' };
      const result = await postJson(config.webhook.trim(), {
        msgtype: 'markdown',
        markdown: { content: `**${title}**\n${content}` },
      });
      return result;
    }
    case 'feishu': {
      if (!config.webhook) return { ok: false, error: '缺少飞书机器人 Webhook' };
      // 飞书自定义机器人：open.feishu.cn/open-apis/bot/v2/hook/{token}
      const result = await postJson(config.webhook.trim(), {
        msg_type: 'text',
        content: { text: `【${title}】\n${content}` },
      });
      return result;
    }
    case 'email': {
      if (!config.smtpHost || !config.smtpUser || !config.smtpPass || !config.mailTo) {
        return { ok: false, error: '缺少 SMTP 配置（服务器/账号/授权码/收件人）' };
      }
      try {
        // 懒加载 nodemailer，避免无邮件需求时加载
        const nodemailer = await import('nodemailer');
        const port = config.smtpPort || 465;
        const transporter = nodemailer.default.createTransport({
          host: process.env.TRACE_PUBLIC_WORKER === '1'
            ? await resolveClusterAddress(config.smtpHost.trim(), false) : config.smtpHost.trim(),
          port,
          secure: port === 465,
          ...(process.env.TRACE_PUBLIC_WORKER === '1' ? { requireTLS: true, tls: { servername: config.smtpHost.trim() } } : {}),
          auth: { user: config.smtpUser.trim(), pass: config.smtpPass.trim() },
        });
        await transporter.sendMail({
          from: `TRACE <${config.smtpUser.trim()}>`,
          to: config.mailTo.trim(),
          subject: title,
          text: content,
        });
        return { ok: true };
      } catch (err: any) {
        return { ok: false, error: err?.message || String(err) };
      }
    }
    default:
      return { ok: false, error: `未知通知渠道: ${config.channel}` };
  }
}
