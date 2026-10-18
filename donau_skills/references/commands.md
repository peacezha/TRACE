# 多瑙辅助命令

## 命令速查

| 命令 | 用途 |
|------|------|
| `dlogin` | 登录获取 token（首次使用必须） |
| `dsub` | 提交作业 |
| `djob` | 查看作业状态 |
| `dpeek` | 查看运行作业的输出 |
| `dkill` | 终止作业 |
| `djctl` | 作业控制（挂起/恢复/重启） |
| `dnode` | 查看节点信息 |
| `dqueue` | 查看队列信息 |
| `dmod` | 修改作业资源 |
| `drun` | 使用不同的 JobStep 提交不同的任务 |
| `dattach` | 直接连接作业执行节点或 Docker 容器 |
| `drespool` | 显示资源池信息 |
| `dacct` | 显示组织帐户作业统计和资源等信息 |
| `duser` | 显示用户作业统计等信息 |
| `dcluster` | 显示集群中节点、作业及队列等信息 |
| `dadmin label show` | 查看资源标签及对应的节点 |

## drun — 多步骤任务

用于在同一个作业中使用不同的 JobStep 提交不同的任务：

```bash
drun [options] <command>
```

## dattach — 连接作业节点

用于支持用户直接连接作业执行节点或 Docker 容器：

```bash
dattach <jobid>
```

## drespool — 资源池

显示资源池信息：

```bash
drespool
```

## dacct — 组织帐户

显示组织帐户作业统计和资源等信息：

```bash
dacct
```

## duser — 用户统计

显示用户作业统计等信息：

```bash
duser
```

## dcluster — 集群概览

显示集群中节点、作业及队列等信息：

```bash
dcluster
```
