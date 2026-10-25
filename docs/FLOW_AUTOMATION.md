# 流程自动化：四板块专属文件夹 + 预检 + 跟踪 + 报告

本文档描述 TRACE 的流程自动化体系：每个分析流程在集群上拥有一个持久专属文件夹，
按"必要软件 / 必要参考数据 / 工作区 / 质控与结果"四个板块组织，运行前自动预检，
运行中逐步跟踪，收尾自动归档并生成图文并茂的报告。

## 可视化运行面板（Flow Runner）

在"流程"页签点击流程的"打开运行面板"，右侧滑出可视化抽屉（`src/components/FlowRunnerDrawer.tsx`），
卡片流布局（形态参考 HiDOG 管理台）：

1. **环境检查**：逐项列出必要软件/参考数据，每项一个"校验"按钮（单项预检，
   `POST /api/workflows/:id/preflight` body 带 `only: { software?: [...]; references?: [...] }`，
   结果与集群缓存合并）；缺失的必需项显示"安装部署"按钮，点击后发消息给 AI
   走 provision 技能补齐（登录节点操作、用户确认）。
2. **数据选择**：已选路径列表 + "选择文件夹"按钮 —— 打开文件传输工作区的选择器模式
   （`FileTransferWorkspace` 的 `pickFolder` prop，由 `App.tsx` 的 `requestRemoteFolder()` 驱动）；
   也可手动输入路径回车添加。
3. **参数配置**：按 `WorkflowParam` 渲染表单，`type` 支持 text/number/select/boolean/path，
   默认值预填，无默认值的参数为必填。
4. **任务监控**：运行记录按流程归属管理——每个流程卡片/运行面板只显示本流程的任务
   （归属判定三级匹配：run.json 的 workflowId → workflowName 的 slug → runDir 所在的流程家目录，
   见 `runBelongsToWorkflow()`）；无法归属到任何流程的运行单独归入流程列表顶部的"未归属流程的运行"。
   进度条 + 步骤时间线（QC 徽章）+ 日志弹窗（`GET /api/workflows/runs/log?dir=<runDir>&n=<行数>`，
   5s 轮询，路径限定 home 下 trace_flows/trace_runs 工作区内；日志文件在 run 目录内动态发现，
   返回内容同时带文件来源清单）。
5. **报告**：reportPath 存在时弹窗内 iframe 渲染自包含 report.html（srcDoc），可下载。

点"运行流程"后，面板把 预检结果 + 数据路径 + 参数取值 经 `composeRunMessage()` 组装成
结构化执行协议发给 AI agent（聊天页签可见执行过程）；AI 在集群上创建 run 目录并逐步执行，
面板通过 run.json 轮询实时监控。流程步骤为 prompt 模板，执行由 AI 驱动，面板不做代码级调度。

## 集群目录约定

```
~/trace_flows/<workflow-slug>/          # slug = 流程名（非法字符替换为 _，截断 40 字符）
├── flow.json                            # 流程清单快照（预检时同步）
├── 01_software/                         # 板块1：必要软件
│   ├── manifest.json                    #   软件清单（module 名、检查命令、是否必需）
│   └── env-check.json                   #   最近一次预检的完整结果
├── 02_reference/                        # 板块2：必要参考数据
│   ├── manifest.json                    #   参考数据清单（路径、类型、来源）
│   └── ref-check.json                   #   最近一次核查结果
├── 03_workspace/                        # 板块3：工作区
│   └── runs/<slug>-<YYYYMMDD-HHmm>/     #   每次运行一个子目录（runId = 目录名）
│       ├── run.json                     #   运行状态机（监控面板数据源）
│       ├── inputs.md                    #   本次输入数据记录（路径/文件数/md5 抽样）
│       ├── scripts/  logs/  results/
└── 04_results/                          # 板块4：质控和最终运行文件
    └── <runId>/
        ├── qc/                          #   质控报告、指标表、关卡判定记录
        ├── final/                       #   最终交付文件
        └── report/                      #   report.html（自包含嵌图）+ report.md + figures/
```

旧约定 `~/trace_runs/<run>/` 保留只读兼容（运行监控接口同时扫描两处）。

## Manifest（流程资源清单 / Workflow Contract v2）

`Workflow.manifest`（类型见 `shared/flowManifest.ts`）：

```ts
interface FlowManifest {
  software: SoftwareItem[];     // { name, module?, checkCmd?, versionCmd?, required }
  references: ReferenceItem[];  // { name, path, type, checkCmd?, source?, required }
  inputHint?: string;           // 询问用户数据位置的提示语
  qcGates: QcGate[];            // { afterStep, metric, pass, warn? }
}
```

- `path` 为 `{{参数名}}` 占位时表示运行时由用户指定，预检标记为"待用户指定路径"；
- `required: false` 的项缺失不阻断运行，仅在面板与协议中提示；
- 清单来源：内置流程（`workflowStore.ts`）、AI 起草流程（draft prompt 输出 manifest）、
  bioSkills 流水线（`scripts/seed-bioskills-flows.ts` 批量生成）。

## 预检

- API：`POST /api/workflows/:id/preflight`（执行） / `GET .../preflight`（读缓存）。
- 实现：`server/workflows/preflight.ts`。
  1. 幂等创建四板块目录并同步 flow.json / manifest.json；
  2. 一条组合 SSH 命令完成调度器探测（bsub/sbatch/qsub/dsub）+ 全部软件/参考数据检查；
  3. 解析为 `PreflightResult`，写回 `01_software/env-check.json` 与 `02_reference/ref-check.json`。
- 所有检查只读（`module av` / `command -v` / `test -e` / `du`），不 load、不安装；
- 前端：流程卡片的"检查环境"按钮触发；"使用流程"会先预检再把结果附进执行协议。

## 运行协议（AI 执行约定）

`src/features/workflows/compose.ts` 生成，要点：

1. 读家目录预检结果；必需项缺失 → run.json 置 `blocked_env`，ask_user 选择补齐/改路径/放弃；
   补齐只在登录节点进行且必须用户同意；
2. 按 `inputHint` 询问数据位置（候选列选项，禁止大面积 find），确认后写 `inputs.md`；
3. 逐步执行：每步使用 RUN/code 下的真实脚本，由当前调度器提交并串联依赖；资源指令按目标调度器转换，无法可靠转换时阻断而非静默丢弃。每步 summary
   判定 通过/警告/失败；命中 `qcGates` 的步骤把指标写入 run.json 的 `qc` 字段；
4. 收尾归档到 `04_results/<runId>/`，按 analysis-report 技能模板生成报告。

## run.json 扩展字段

- `status`：新增 `blocked_env`（环境未就绪）；
- `steps[].qc`：`{ status: pass|warn|fail, metrics: { 指标: 值 } }`；
- 监控接口 `/api/workflow-runs` 同时为每个 run 附带 `reportPath`（存在时）。

## bioSkills 流水线批量接入

```bash
# 在 源码/ 目录下；TRACE_DATA_ROOT 指向应用数据目录（默认 ./ ）
TRACE_DATA_ROOT=<数据目录> npx tsx scripts/seed-bioskills-flows.ts
```

- 扫描 `skills/bioSkills/workflows/*/SKILL.md`，解析 frontmatter
  （depends_on → 步骤链，qc_checkpoints → QC 关卡，Version Compatibility → 软件清单）；
- 软件名经 `MODULE_MAP` 映射到集群 module，映射不到的标 `required: false`（待确认）；
- 幂等：同 id 已存在时只更新 manifest 与 steps；
- 生成条目 `id` 前缀 `bioskills-`、`source: builtin`。
