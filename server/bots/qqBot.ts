// QQ 官方机器人网关：把 QQ 私聊/群@消息映射为 TRACE AI agent 对话。
// 官方 WebSocket 出站连接（无需公网回调地址），复用 agentRunner 的全套能力。
// 文档：https://bot.q.qq.com/wiki/develop/api/
import WebSocket from 'ws';
import { runAgent, type AgentCtx } from '../ai/agentRunner';
import type { AIMessage, AIProfile } from '../ai/types';

export interface QQBotConfig {
  appId: string;
  appSecret: string;
  /** QQ openid 白名单；为空 = 不限制（建议生产环境配置） */
  allowlist?: string[];
  /** AI 配置（与 TRACE 应用内 AI 设置相同格式） */
  ai?: AIProfile;
}

export interface QQBotDeps {
  /** 取一个可用于执行集群命令的会话；无会话时返回 undefined */
  getClusterSession: () => { sid: string; home: string; exec: (cmd: string, to?: number) => Promise<string> } | undefined;
  /** 共享 AI 配置（与应用内 AI 设置同源）；config.ai 为空时回退到这里 */
  getAiProfile?: () => AIProfile | undefined;
  /** 把对话存档到集群 ~/trace_conversations（与应用对话记录同库） */
  saveConversation?: (record: {
    id: string;
    title: string;
    messages: AIMessage[];
    createdAt: number;
    updatedAt: number;
  }) => Promise<void>;
  skillsDir: string;
  lsfSkillDir: string;
  donauSkillDir?: string;
  userSkillsDir: string;
  /** Agent 提交作业后交给服务端 jobWatcher 跟踪（只监控不绑定不唤醒，防短作业漏检）。 */
  trackJobs?: (sid: string, jobIds: string[]) => void;
  log?: (msg: string) => void;
}

const API_BASE = 'https://api.sgroup.qq.com';
const TOKEN_URL = 'https://bots.qq.com/app/getAppAccessToken';
// intents: 1<<24 GROUP_AT_MESSAGE_CREATE | 1<<25 C2C_MESSAGE_CREATE
const INTENTS = (1 << 24) | (1 << 25);
const MAX_MSG_LEN = 1800;

interface ChatState {
  messages: AIMessage[];
  busy: boolean;
  createdAt: number;
  /** ask_user 反问的候选项，等待用户回复编号 */
  pendingOptions?: string[];
  /** 危险命令确认 */
  pendingConfirm?: (ok: boolean) => void;
}

export class QQBot {
  private token = '';
  private tokenExpiresAt = 0;
  private ws: WebSocket | null = null;
  private seq: number | null = null;
  private sessionId = '';
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private seenMsgIds = new Set<string>();
  private msgSeqByChat = new Map<string, number>();
  private chats = new Map<string, ChatState>();

  constructor(private config: QQBotConfig, private deps: QQBotDeps) {}

  private log(msg: string) {
    this.deps.log?.(`[QQBot] ${msg}`);
  }

  /** QQ 去重规则：同一 msg_id 的连续回复必须携带递增 msg_seq */
  private nextMsgSeq(chatKey: string): number {
    const n = (this.msgSeqByChat.get(chatKey) || 0) + 1;
    this.msgSeqByChat.set(chatKey, n);
    return n;
  }

  // ── access token（缓存，到期前刷新）──────────────────────────────
  private async getToken(): Promise<string> {
    if (this.token && Date.now() < this.tokenExpiresAt) return this.token;
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appId: this.config.appId, clientSecret: this.config.appSecret }),
    });
    const data: any = await res.json().catch(() => ({}));
    if (!res.ok || !data.access_token) {
      throw new Error(`获取 QQ access_token 失败: ${data?.message || res.status}`);
    }
    this.token = data.access_token;
    this.tokenExpiresAt = Date.now() + (Number(data.expires_in || 7000) * 1000 * 0.8);
    return this.token;
  }

  private async apiPost(path: string, body: unknown): Promise<void> {
    const token = await this.getToken();
    const res = await fetch(`${API_BASE}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `QQBot ${token}` },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      this.log(`API ${path} 失败 ${res.status}: ${text.slice(0, 200)}`);
    }
  }

  // ── 发送消息（分段，携带递增 msg_seq 防止被 QQ 去重）──────────
  private async sendText(chatKey: string, replyBase: string, msgId: string, text: string): Promise<void> {
    const chunks: string[] = [];
    for (let i = 0; i < text.length; i += MAX_MSG_LEN) chunks.push(text.slice(i, i + MAX_MSG_LEN));
    for (const chunk of chunks.slice(0, 4)) { // 被动回复有频控，最多 4 段
      await this.apiPost(replyBase, {
        content: chunk,
        msg_type: 0,
        msg_id: msgId,
        msg_seq: this.nextMsgSeq(chatKey),
      });
      await new Promise(r => setTimeout(r, 250));
    }
  }

  // ── WebSocket 生命周期 ───────────────────────────────────────────
  async start(): Promise<void> {
    this.stopped = false;
    await this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
  }

  private async connect(): Promise<void> {
    const token = await this.getToken();
    const gw: any = await (await fetch(`${API_BASE}/gateway`, {
      headers: { Authorization: `QQBot ${token}` },
    })).json();
    const url = gw?.url;
    if (!url) throw new Error('获取 QQ gateway 失败');
    this.log(`连接 ${url}`);
    const ws = new WebSocket(url);
    this.ws = ws;

    ws.on('message', (raw: WebSocket.RawData) => {
      let payload: any;
      try { payload = JSON.parse(String(raw)); } catch { return; }
      if (typeof payload.s === 'number') this.seq = payload.s;
      this.handlePayload(payload, ws);
    });
    ws.on('close', () => {
      if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
      if (!this.stopped) {
        this.log('连接断开，3s 后重连');
        this.reconnectTimer = setTimeout(() => void this.connect().catch(e => this.log(`重连失败: ${e.message}`)), 3000);
      }
    });
    ws.on('error', (err) => this.log(`WebSocket 错误: ${err.message}`));
  }

  private handlePayload(p: any, ws: WebSocket): void {
    switch (p.op) {
      case 10: { // Hello
        const interval = p.d?.heartbeat_interval || 30000;
        if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ op: 1, d: this.seq }));
        }, interval);
        const identify = this.sessionId
          ? { op: 6, d: { token: `QQBot ${this.token}`, session_id: this.sessionId, seq: this.seq ?? 0 } }
          : { op: 2, d: { token: `QQBot ${this.token}`, intents: INTENTS, shard: [0, 1], properties: {} } };
        ws.send(JSON.stringify(identify));
        break;
      }
      case 0: { // Dispatch
        if (p.t === 'READY') {
          this.sessionId = p.d?.session_id || '';
          this.log('就绪');
          return;
        }
        if (p.t === 'C2C_MESSAGE_CREATE' || p.t === 'GROUP_AT_MESSAGE_CREATE') {
          void this.onUserMessage(p.t, p.d);
        }
        break;
      }
      case 7: // 服务端要求重连
        ws.close();
        break;
      case 9: // invalid session → 重新 identify
        this.sessionId = '';
        break;
    }
  }

  /** 把当前 QQ 对话存档到集群 ~/trace_conversations（应用对话记录面板可见） */
  private async saveChat(chatKey: string, replyBase: string, msgId: string, chat: ChatState): Promise<void> {
    if (chat.messages.length === 0) {
      await this.sendText(chatKey, replyBase, msgId, '当前没有可保存的对话');
      return;
    }
    if (!this.deps.saveConversation) {
      await this.sendText(chatKey, replyBase, msgId, '⚠️ 存档功能不可用');
      return;
    }
    try {
      const firstUser = chat.messages.find(m => m.role === 'user')?.content || '对话';
      await this.deps.saveConversation({
        id: `qq-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        title: `[QQ] ${firstUser.slice(0, 30)}`,
        messages: chat.messages,
        createdAt: chat.createdAt,
        updatedAt: Date.now(),
      });
      await this.sendText(chatKey, replyBase, msgId, '💾 已保存到对话记录（TRACE 对话记录面板可查看）');
    } catch (err: any) {
      await this.sendText(chatKey, replyBase, msgId, `⚠️ 保存失败：${err?.message || String(err)}`);
    }
  }

  // ── 消息处理 ─────────────────────────────────────────────────────
  private async onUserMessage(eventType: string, d: any): Promise<void> {
    const msgId: string = d?.id || '';
    if (msgId && this.seenMsgIds.has(msgId)) return;
    if (msgId) {
      this.seenMsgIds.add(msgId);
      if (this.seenMsgIds.size > 500) this.seenMsgIds.clear();
    }

    const isGroup = eventType === 'GROUP_AT_MESSAGE_CREATE';
    const chatKey = isGroup ? String(d.group_openid || d.group_id || '') : String(d.author?.user_openid || d.author?.id || '');
    const authorId = String(isGroup ? (d.author?.member_openid || d.author?.id) : (d.author?.user_openid || d.author?.id) || '');
    const replyBase = isGroup ? `/v2/groups/${chatKey}/messages` : `/v2/users/${chatKey}/messages`;
    if (!chatKey) return;

    // 白名单
    const allow = this.config.allowlist;
    if (allow && allow.length > 0 && !allow.includes(authorId)) {
      await this.sendText(chatKey, replyBase, msgId, '⛔ 你没有使用本机器人的权限');
      return;
    }

    let text = String(d.content || '').trim();
    const chat = this.chats.get(chatKey) ?? { messages: [], busy: false, createdAt: Date.now() };
    this.chats.set(chatKey, chat);

    // 危险命令确认应答
    if (chat.pendingConfirm) {
      const resolve = chat.pendingConfirm;
      chat.pendingConfirm = undefined;
      const yes = /^[yY1确是执同]/.test(text);
      resolve(yes);
      await this.sendText(chatKey, replyBase, msgId, yes ? '✅ 已确认，继续执行' : '🚫 已取消该命令');
      return;
    }

    // 反问编号应答
    if (chat.pendingOptions && /^\d+$/.test(text)) {
      const idx = Number(text) - 1;
      if (idx >= 0 && idx < chat.pendingOptions.length) {
        text = chat.pendingOptions[idx];
        chat.pendingOptions = undefined;
      }
    }

    if (text === '/help' || text === '帮助') {
      await this.sendText(chatKey, replyBase, msgId,
        '📖 可用命令：\n/new — 保存当前对话并开始新对话\n/save — 保存当前对话到对话记录\n/help — 显示本帮助\n\n直接发消息即可与 AI 对话；AI 反问时回复选项编号作答。');
      return;
    }

    if (text === '/save' || text === '保存对话') {
      await this.saveChat(chatKey, replyBase, msgId, chat);
      return;
    }

    if (text === '/new' || text === '新对话') {
      // 先存档当前对话，再开新对话
      if (chat.messages.length > 0) await this.saveChat(chatKey, replyBase, msgId, chat);
      chat.messages = [];
      chat.createdAt = Date.now();
      chat.pendingOptions = undefined;
      await this.sendText(chatKey, replyBase, msgId, '🆕 已开始新对话');
      return;
    }
    if (!text) return;
    if (chat.busy) {
      await this.sendText(chatKey, replyBase, msgId, '⏳ 上一条还在处理中，请稍候…（回复 /new 可强制开新对话）');
      return;
    }

    // AI 配置：优先 qqbot.json 里的 ai 段，否则复用应用内 AI 设置（同源共享）
    const profile = this.config.ai?.apiKey ? this.config.ai : this.deps.getAiProfile?.();
    if (!profile?.apiKey) {
      await this.sendText(chatKey, replyBase, msgId, '⚠️ AI 未配置：请先在 TRACE 应用的 AI 设置里保存配置（或在 qqbot.json 中填写 ai 段）');
      return;
    }
    const session = this.deps.getClusterSession();
    if (!session) {
      await this.sendText(chatKey, replyBase, msgId, '⚠️ 当前没有已连接的集群，请先在 TRACE 里登录一个集群');
      return;
    }

    chat.busy = true;
    await this.sendText(chatKey, replyBase, msgId, '🤔 收到，正在处理…');

    const ctx: AgentCtx = {
      sid: session.sid,
      profile,
      run: async (_sid, cmd, to) => session.exec(cmd, to),
      skillsDir: this.deps.skillsDir,
      lsfSkillDir: this.deps.lsfSkillDir,
      donauSkillDir: this.deps.donauSkillDir,
      userSkillsDir: this.deps.userSkillsDir,
      // QQ 对话没有可回写的 TRACE 会话：只跟踪作业完成情况（通知/事件），不登记绑定不唤醒。
      onJobsSubmitted: jobIds => this.deps.trackJobs?.(session.sid, jobIds),
      confirmCommand: (command) => new Promise<boolean>(resolve => {
        chat.pendingConfirm = ok => {
          clearTimeout(timer);
          resolve(ok);
        };
        const timer = setTimeout(() => {
          chat.pendingConfirm = undefined;
          resolve(false);
        }, 60_000);
        void this.sendText(chatKey, replyBase, msgId, `⚠️ AI 请求执行危险命令：\n${command}\n\n回复 Y 确认执行 / N 取消（60s 超时自动取消）`);
      }),
    };

    const agentMessages: AIMessage[] = [...chat.messages, { role: 'user', content: text }];
    chat.messages = agentMessages;

    try {
      await runAgent(ctx, {
        onText: () => {},
        onReason: () => {},
        onToolCall: () => {},
        onToolResult: () => {},
        onStep: () => {},
        onAsk: (question, options) => {
          const opts = (options || []).filter(o => o && o.trim()).slice(0, 6);
          const numbered = opts.map((o, i) => `${i + 1}. ${o}`).join('\n');
          chat.pendingOptions = opts.length > 0 ? opts : undefined;
          void this.sendText(chatKey, replyBase, msgId, `❓ ${question}${numbered ? `\n\n${numbered}\n（可直接回复编号）` : ''}`);
        },
        onDone: (doneText) => {
          const finalText = doneText === '__ASK__' ? '' : (doneText || '(完成)');
          if (finalText.trim()) {
            chat.messages = [...agentMessages, { role: 'assistant', content: finalText }];
            void this.sendText(chatKey, replyBase, msgId, finalText);
          }
          // 只保留最近 20 条，避免上下文膨胀
          chat.messages = chat.messages.slice(-20);
          chat.busy = false;
        },
        onErr: (err) => {
          void this.sendText(chatKey, replyBase, msgId, `❌ 出错了：${String(err).slice(0, 300)}`);
          chat.busy = false;
        },
        sig: () => undefined,
      }, agentMessages);
    } catch (err: any) {
      await this.sendText(chatKey, replyBase, msgId, `❌ 出错了：${err?.message || String(err)}`);
      chat.busy = false;
    }
  }
}
