// 集群会话淘汰决策：从 server.ts 抽出的纯函数，便于单测。

/**
 * 从最旧的会话开始，找第一个可以安全淘汰（没有活跃/暂停传输）的会话。
 * 全部会话都有传输在跑时返回 undefined——宁可暂时超过会话上限，也不淘汰
 * 正在传输的会话（淘汰会连 SSH 一起杀掉几个小时的大文件传输，只留下 .part）。
 */
export function pickSessionToEvict(
  sessionIds: Iterable<string>,
  hasActiveTransfers: (sessionId: string) => boolean,
): string | undefined {
  for (const id of sessionIds) {
    if (!hasActiveTransfers(id)) return id;
  }
  return undefined;
}
