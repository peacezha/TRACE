# TRACE — HPC 集群智能 Web 终端

## 项目概述

TRACE 是一个面向生物信息学科研人员的 **HPC 集群 Web 终端 + AI 智能助手** 一体化平台。用户通过浏览器即可 SSH 登录远程 HPC 集群（支持密码 + Google Authenticator 双因素认证），在 Web 终端中执行命令，同时由 AI Agent 自主完成生物信息学分析任务——包括环境探查、命令执行、文件管理、LSF 作业提交与监控、结果解读等全流程。

**技术栈：** TypeScript 全栈，Express + Socket.IO 后端，React 19 前端，xterm.js 终端模拟，Vite 构建，Vitest 测试。

---

## 项目结构

```
E:\0612trace\
├── server.ts                  # 主服务入口 (2374 行) — Express + Socket.IO + SSE
├── server/
│   ├── loginDiagnostics.ts    # 登录失败诊断格式化
│   ├── socketSession.ts       # Socket.IO 会话解析
│   └── ai/                    # AI 子系统
│       ├── types.ts           # 全部类型定义
│       ├── providerAdapters.ts # 多 AI 供应商适配器 (OpenAI/DeepSeek/Gemini 等)
│       ├── contextBuilder.ts  # AI 上下文构建器
│       ├── skillIndex.ts      # 技能知识库索引
│       ├── skillGraph.ts      # 技能关系图谱
│       ├── skillInstaller.ts  # 技能安装器
│       ├── skillOrchestrator.ts # 技能编排器
│       ├── clusterContext.ts  # 集群状态快照采集
│       ├── conversationMemory.ts # 对话记忆管理
│       ├── memoryCompressor.ts   # 记忆压缩
│       ├── memoryOrchestrator.ts # 记忆编排
│       ├── observationStore.ts   # 观察记录存储
│       ├── agentPlanner.ts    # Agent 任务规划器
│       ├── tokenBudget.ts     # Token 预算管理
│       ├── contextHelpers.ts  # 上下文辅助函数
│       └── fileRecognizer.ts  # 文件类型识别
├── src/                       # React 前端
│   ├── App.tsx                # 应用根组件
│   ├── main.tsx               # 入口
│   ├── components/
│   │   ├── Terminal.tsx       # xterm.js 终端组件
│   │   ├── TerminalAI.tsx     # 终端 AI 集成
│   │   ├── AIChat.tsx         # AI 聊天面板 (1559 行，核心组件)
│   │   ├── LoginForm.tsx      # SSH 登录表单
│   │   ├── FileManager.tsx    # 远程文件管理器
│   │   ├── SkillsPanel.tsx    # 技能知识库面板
│   │   ├── BioSkillPanel.tsx  # 生物信息学技能面板
│   │   ├── CommandSuggest.tsx # 命令自动补全建议
│   │   ├── ConversationList.tsx # 对话历史列表
│   │   ├── ResultsPanel.tsx   # 分析结果面板
│   │   ├── Header.tsx         # 顶部导航栏
│   │   ├── FloatingToolbar.tsx # 浮动工具栏
│   │   ├── SkillInstallDialog.tsx # 技能安装对话框
│   │   └── rich-content/      # 富内容卡片组件
│   │       ├── CodeCard.tsx
│   │       ├── FastaCard.tsx
│   │       ├── ImageCard.tsx
│   │       ├── TableCard.tsx
│   │       ├── GenericCard.tsx
│   │       └── RichContentMessage.tsx
│   ├── services/
│   │   ├── aiProfile.ts       # AI 配置持久化 (localStorage)
│   │   ├── aiGateway.ts       # AI 网关客户端
│   │   ├── aiTerminal.ts      # 终端 AI 集成服务
│   │   ├── commandIndex.ts    # 命令索引
│   │   └── skillCatalog.ts    # 技能目录
│   └── hooks/
│       ├── useAiProfile.ts    # AI 配置 Hook
│       └── useObservationLogger.ts # 观察日志 Hook
├── skills/                    # 技能知识库 (Markdown 文档)
│   ├── bio/                   # 生物信息学技能
│   ├── nature/                # 学术写作/出版技能
│   └── imported/              # 导入的第三方技能
├── conversations/             # 对话存档 (JSON)
├── dist/                      # 前端构建产物
├── docs/                      # 项目文档
├── lsf-ncpgr/                 # LSF 集群配置
├── package.json
├── tsconfig.json
└── vite.config.ts
```

---

## 核心功能模块

### 1. SSH 终端 (Terminal)

通过浏览器内的 xterm.js 终端模拟器，使用 OpenSSH 客户端在服务端建立到远程 HPC 集群的 SSH 连接。

- **双因素认证支持**：密码 + Google Authenticator 动态验证码
- **ssh2 会话**：基于 ssh2 库的统一集群会话管理
- **会话管理**：基于 `express-session` + Socket.IO 的持久化会话
- **实时双向通信**：终端输入/输出通过 Socket.IO 实时流转
- **Ctrl+C / Ctrl+D** 等控制信号透传

### 2. AI Agent 智能助手

核心差异化功能——AI 能够自主在集群上执行多步骤生物信息学任务。

**Agent 工作循环（最多 15 轮）：**
1. 接收用户任务描述
2. AI 分析当前状态（集群环境、文件、作业）
3. 输出 `<thought>` 思考过程
4. 选择动作：执行命令 / 搜索技能 / 保存知识 / 监控作业 / 标记完成
5. 执行命令并获取输出反馈
6. 根据结果迭代下一步，直到任务完成

**AI 供应商支持：**
- DeepSeek (deepseek-v4-pro, deepseek-chat, deepseek-reasoner)
- OpenAI (GPT-4o, GPT-4o-mini)
- Google Gemini
- Grok, Moonshot/Kimi
- 自定义 OpenAI 兼容 API

**流式响应 (SSE)**：AI 思考过程和回复通过 Server-Sent Events 实时流式传输。

### 3. 技能知识库系统

层次化的生物信息学知识管理系统，为 AI 提供领域知识。

- **三层架构**：系统技能 (`skills/bio/`) + 导入技能 (`skills/imported/`) + LSF 集群技能 (`lsf-ncpgr/`)
- **技能图谱 (SkillGraph)**：技能间关系建模（依赖、关联、组合使用、触发、解决）
- **语义搜索**：基于关键词 + 标签的全文检索
- **动态安装**：支持从 GitHub 仓库安装第三方技能包
- **集群圣经 (Bible)**：NCPGR 集群使用规范的完整手册，自动注入 AI 上下文

### 4. 远程文件管理

通过 SSH 协议在远程集群上管理文件。

- **目录浏览**：`ls -la` 输出解析，显示文件名、大小、修改时间、类型
- **文件类型识别**：自动识别 FASTA/FASTQ/VCF/BAM/SAM 等生物信息学格式
- **上传/下载**：通过 Base64 编码 + heredoc 机制传输文件
- **文件预览**：支持代码高亮、表格渲染、图像缩略图、FASTA 统计卡片

### 5. LSF 作业管理

IBM Spectrum LSF 集群作业调度系统的集成。

- **作业提交**：AI 自动生成 LSF 作业脚本并通过 `bsub` 提交
- **智能监控**：`bjobs` 轮询 + AI 驱动的状态解读
- **作业完成通知**：作业完成后 AI 自动分析结果并汇报
- **队列状态**：实时显示队列负载和可用槽位

### 6. 上下文与记忆管理

确保 AI 在长对话中保持连贯性。

- **Token 预算 (TokenBudget)**：动态分配上下文窗口空间
- **结构化记忆 (StructuredMemory)**：环境信息、关键事实、决策记录、错误历史
- **记忆编排 (MemoryOrchestrator)**：自动摘要 + 关键信息保留
- **观察存储 (ObservationStore)**：命令执行、输出、错误的历史记录
- **对话存档**：完整对话历史保存为 JSON，支持跨会话恢复

### 7. 富内容渲染

AI 产出物自动识别并以卡片形式美化展示。

- **代码卡片**：语法高亮 + 路径显示
- **表格卡片**：CSV/TSV 分页渲染
- **图像卡片**：PNG/JPG/SVG 缩略图预览
- **FASTA 卡片**：序列统计信息（长度、GC 含量等）

---

## API 路由总览

| 方法 | 路径 | 功能 |
|------|------|------|
| POST | `/api/login` | SSH 登录 |
| POST | `/api/logout` | 登出并清理会话 |
| POST | `/api/ai` | 非流式 AI 对话 |
| POST | `/api/ai/stream` | 流式 AI 对话 (SSE) |
| POST | `/api/ai/autocomplete` | 命令自动补全 |
| POST | `/api/ai/analyze-output` | 终端输出分析 |
| GET  | `/api/skills/search` | 技能搜索 |
| POST | `/api/skills/install` | 安装远程技能 |
| POST | `/api/files/list` | 列出远程目录 |
| POST | `/api/files/upload` | 上传文件到远程 |
| GET  | `/api/files/download` | 从远程下载文件 |
| POST | `/api/files/delete` | 删除远程文件/目录 |
| POST | `/api/files/mkdir` | 创建远程目录 |
| GET  | `/api/diag` | 会话诊断信息 |

---

## 部署与运行

```bash
# 开发模式 (启动 Vite + Express 一体化服务)
npm run dev

# 生产构建
npm run build

# 全量回归测试（单元、组件与故障注入用例）
npm test

# TypeScript 类型检查
npm run lint
```

服务默认监听 `http://localhost:3003`。

---

## 当前验证边界与已知限制

1. **调度器真机兼容**：LSF/Slurm/PBS/Donau 的提交、终态和资源映射有自动化测试，但不同站点的真实输出格式、资源单位和数组语义仍需逐站点验收。
2. **长传输真机验证**：断线重连、暂停/取消、源身份校验和断点续传有故障注入测试，数十 GB 数小时传输仍需真机验证。
3. **流程执行模型**：正式流程保留脚本、证据和断点，但仍由 Agent 驱动；确定性 DAG 并行执行器属于后续架构工作。
4. **服务入口规模**：`server.ts` 仍承担较多路由与生命周期编排，后续应继续按领域拆分。

---

## 总结

TRACE 是一个功能完整的 **HPC 生物信息学智能工作台**，将 SSH 终端、AI Agent、技能知识库、文件管理和作业调度深度整合。其核心价值在于让 AI 能够像人类研究人员一样在集群上自主工作——理解任务、探索环境、执行分析、处理错误、产出结果，显著降低生物信息学分析的门槛。
