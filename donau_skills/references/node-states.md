# 队列与节点信息

## 可用队列

| 队列 | 节点 | CPU核数 | 内存(GB) | 每核内存限制 |
|------|------|---------|----------|-------------|
| `arm` | agent-ARM-{01-43} | 128 | 512 | 5GB |
| `x86` | agent-X86-{01-65} | 64 | 512 | 10GB |
| `AI` | AI-01 | 192 | 1024 | 10GB |
| `interactive` | - | - | - | - |
| `fat_arm` | fat-agent-ARM-{01-03} | 128 | 2048 | 16GB |
| `fat_x86` | fat-agent-X86-{01-03} | 64 | 2048 | 32GB |

## 队列选择指南

- **普通 arm 作业**：`-q arm -aa`
- **普通 x86 作业**：`-q x86 -aa`
- **AI/NPU 作业**：`-q AI -aa`
- **大内存 arm 作业 (>500GB)**：`-q fat_arm -aa`
- **大内存 x86 作业 (>500GB)**：`-q fat_x86 -aa`
- **交互调试**：`-q interactive -I`

## 节点状态

| 状态 | 说明 |
|------|------|
| OK | 正常 |
| CLOSE_ADMIN | 管理员关闭 |
| CLOSE_LOCK | 批量失败隔离 |
| CLOSE_BUSY | 繁忙 |
| CLOSE_FAULT | 局部故障 |
| CLOSE_FULL | 资源已分配完 |
| UNAVAILABLE | 无法连接/严重故障 |
| REGISTERING | 节点注册中 |
| UNLICENSED | License 不足（线下场景） |
| SUSPENDED_ADMIN | 管理员手动休眠 |
| SUSPENDED_AUTO | 节点自动休眠 |
| CLOSE_EXIT | 即将删除，运行中作业不受影响 |

## 节点查看命令

```bash
dnode           # 查看所有节点
dnode --npu     # 查看 NPU 节点使用情况
dqueue          # 查看队列负载
```

## 资源规划参考

| 场景 | 建议策略 |
|------|----------|
| 队列中 PENDING_JOBS 数量很大 | 申请较少核数（2-4核），提高调度优先级 |
| 队列中 RUNNING_JOBS 较少、节点空闲 | 可申请较多核数加速计算 |
| 急需作业跑上 | 申请1-2核，几乎可以立即调度 |

**警告**：盲目申请过多核心会导致作业长时间排队，且浪费集群资源。
