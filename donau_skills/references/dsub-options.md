# dsub 完整选项参考

## 作业提交选项

| 选项 | 说明 |
|------|------|
| `-n name` | 作业名称 |
| `-q queue` | 队列（arm/x86/AI/fat_arm/fat_x86/interactive） |
| `-aa` | 任意 CPU 架构（**必须与 `-q` 一起使用**） |
| `-R 'cpu=N'` | 申请 N 个 CPU 核 |
| `-R 'npu=N'` | 申请 NPU 资源 |
| `-R 'gpu=N'` | 申请 GPU 资源 |
| `-N N` | MPI 总进程数 |
| `-nn N` | MPI 节点数 |
| `-o file` | 标准输出日志（stdout+stderr合并，追加写入，支持 %J/%U/%G/%I/%A） |
| `-oo file` | 日志以覆盖方式写入 |
| `-nl 'node'` | 指定运行节点（如 `'agent-ARM-01'` 或范围 `'agent-ARM-0[1-9]'`） |
| `-w` | 阻塞式作业（等待作业结束） |
| `-I` | 交互模式 |
| `-D "key=value"` | 作业依赖 |
| `--mpi type` | MPI 类型（openmpi/intelmpi/hmpi/mpich） |
| `-s file` | 提交脚本文件 |

## 日志文件占位符

| 占位符 | 说明 |
|--------|------|
| `%J` | 作业ID |
| `%U` | 用户名 |
| `%G` | TaskGroupName |
| `%I` | Index |
| `%A` | UserName_JobID_TaskGroupName_Index |

## 作业依赖

`-D "key=value"` 格式说明：

- `key` 支持 jobid 和 JobName
- `value` 支持：`STARTED`、`RUNNING`、`SUCCEEDED`、`FAILED`、`ENDED`
- 支持通配符（`*`）模糊匹配
- 支持逻辑组合：`(1=RUNNING||2=SUCCEEDED)&&3=ENDED`
- 纯数字加单引号按 JobName 处理：`'12'=RUNNING`
