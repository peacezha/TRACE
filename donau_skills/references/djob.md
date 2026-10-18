# djob 作业查询与监控

## 基本使用

```bash
djob              # 查看所有作业
djob <jobid>      # 查看指定作业
djob -l <jobid>   # 查看调度详情（排队原因、失败原因）
djob -ll <jobid>  # 查看完整运行时详情
```

## 作业状态说明

| 状态 | 含义 |
|------|------|
| WAITING | 等待调度 |
| PENDING | 排队等待资源 |
| RUNNING | 运行中 |
| STOPPED | 已停止 |
| SSTOPPED | 系统停止 |
| FAILED | 执行失败 |
| SUCCEEDED | 执行成功 |

## 排查作业问题

**查看排队/失败原因**：
```bash
djob -l <jobid>
```

常见排队原因：
- 队列资源已满（所有节点 CLOSE_FULL）
- 申请的核数超过单节点总核数
- 用户作业数已达上限

## 检查作业效率（重要）

当分析已完成或运行中作业时，使用 `djob -ll <jobid>` 查看 `cpuUtil` 字段，格式为 `avg/recent`：

| 字段 | 说明 |
|------|------|
| avg | 从作业开始到最近一次采样的平均CPU使用率 |
| recent | 最近一次上报的CPU使用率 |

**作业运行异常/资源不合理检查原则**：

当分析作业的 `djob -ll` 输出时，如果同时满足以下两个条件，必须提醒用户：

1. **cpuUtil 的 avg 值远小于申请的核数**
   - 例如：申请了 8 核，cpuUtil 显示 `80/800` → 说明只用到约 1 核

2. **单核实际内存使用 < 队列单核内存限制**

**提醒内容应包括**：
- 指出资源申请不合理：程序没有充分利用申请的所有核心
- 建议减少核数重新提交，这样排队更快且不浪费集群资源
- 可能原因：程序本身不支持多线程，或多线程参数配置不正确

**判断示例**：

| 申请核数 | cpuUtil (avg/total) | 实际内存 | 队列限制 | 结论 |
|---------|---------------------|---------|---------|------|
| 8核 | 80/800 | 2GB | 5GB (arm) | **提醒**：只用到1核，建议减少核数 |
| 8核 | 4200/8000 | 2GB | 5GB (arm) | 正常：有效利用了约5核 |
| 4核 | 40/400 | 1GB | 5GB (arm) | **提醒**：只用到1核，建议减少核数 |

## 查看作业日志

```bash
dpeek <jobid>   # 查看运行中作业的输出
```

作业结束后查看日志文件末尾关键字段：

| 字段 | 说明 |
|------|------|
| `EXEC_NODE` | 运行节点 |
| `EXIT_MESSAGE` | 退出信息 |
| `MRUN_TIME` | 运行时间（秒） |
| `MEM_MAX_SUM` | 最大内存使用 |

## 推荐别名

添加到 `~/.bashrc`：

```bash
alias dbs="djob --output 'jobId:8 name:8 user:8 state:8 queue:8 startTime:20 execNodes:15 totalMaxMem:15 totalUtime:15 totalStime:15'"
```

## 作业控制

```bash
dkill <jobid>           # 终止作业
dkill --force <jobid>   # 强制终止作业
djctl stop <jobid>      # 挂起作业
djctl resume <jobid>    # 恢复作业
djctl requeue <jobid>   # 重新排队
djctl resubmit <jobid>  # 重新提交作业
dmod                    # 修改作业资源
```
