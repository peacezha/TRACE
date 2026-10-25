<div align="center">

# TRACE

**有人监督的 HPC 与生物信息科研辅助工作台**

将 AI Agent、集群作业、文件传输与可复用分析流程集中在同一个工作台。

[![Version](https://img.shields.io/badge/version-v0.5.14-0969da)](https://github.com/peacezha/TRACE/releases/tag/v0.5.14)
[![Platforms](https://img.shields.io/badge/Windows%20%C2%B7%20macOS%20%C2%B7%20Linux%20%C2%B7%20Web-supported-2ea44f)](https://github.com/peacezha/TRACE/releases/tag/v0.5.14)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![Tests](https://github.com/peacezha/TRACE/actions/workflows/package-windows.yml/badge.svg)](https://github.com/peacezha/TRACE/actions/workflows/package-windows.yml)

**[下载 v0.5.14](https://github.com/peacezha/TRACE/releases/tag/v0.5.14)** · [快速开始](#快速开始) · [部署文档](#开发与文档)

</div>

<p align="center">
  <img src="docs/figures/preset_and_custom_workflows_en.png" alt="TRACE 预置流程与自定义流程工作台" width="960">
</p>

## 最新下载

| 版本 | 适用场景 | 下载 |
| --- | --- | --- |
| Windows x64 | Windows 10/11 桌面安装 | [TRACE-Setup-0.5.14-x64.exe](https://github.com/peacezha/TRACE/releases/download/v0.5.14/TRACE-Setup-0.5.14-x64.exe) |
| macOS Apple silicon | arm64 桌面版 | [TRACE-0.5.14-mac-arm64.dmg](https://github.com/peacezha/TRACE/releases/download/v0.5.14/TRACE-0.5.14-mac-arm64.dmg) |
| macOS Intel | x64 桌面版 | [TRACE-0.5.14-mac-x64.dmg](https://github.com/peacezha/TRACE/releases/download/v0.5.14/TRACE-0.5.14-mac-x64.dmg) |
| 私有网页 | Linux x64，Docker，单用户可信环境 | [TRACE-0.5.14-web-linux-x64.tar.gz](https://github.com/peacezha/TRACE/releases/download/v0.5.14/TRACE-0.5.14-web-linux-x64.tar.gz) |
| 公共网页 | Linux x64，Node.js/npm，多访客 | [TRACE-0.5.14-public-web-linux-x64-node20.tar.gz](https://github.com/peacezha/TRACE/releases/download/v0.5.14/TRACE-0.5.14-public-web-linux-x64-node20.tar.gz) |

桌面安装包无需另装 Node.js。SHA-256 校验文件与历史版本见 [Releases](https://github.com/peacezha/TRACE/releases)。macOS 包**未签名、未公证**；网页包的部署方式不同，请分别阅读 [macOS / 私有网页](docs/MAC_WEB_DEPLOYMENT.md) 与 [公共网页](docs/PUBLIC_WEB_DEPLOYMENT.md) 指南。

## 核心能力

- **AI 科研辅助**：对话、命令与工具调用、作业监控、断点恢复和结果整理；关键操作保留人工确认。
- **可复用流程**：预置 ENCODE 参考流程、BioSkills 与自定义流程，支持参数检查、资产部署、步骤状态和 QC 记录。
- **集群工作台**：SSH 终端、LSF 等调度环境的作业提交与监控，连接时校验主机指纹。
- **文件与数据**：本地/集群文件浏览与双向传输、远程编辑，以及公共生物数据资源查询。
- **桌面与网页**：桌面端提供原生文件和系统能力；公共网页按访客隔离集群连接，不开放部署机本地工作台。

## 快速开始

1. 根据上表安装桌面版，或按部署指南启动网页服务。
2. 使用自己的集群 SSH 账号连接，核对并接受主机指纹；配置自己的模型 API 地址与 API Key。
3. 从流程库选择流程，检查输入数据、软件、参考数据和参数，再确认执行。
4. 持续监督命令、作业与资源消耗；完成后检查日志、QC 和产物，不以 `DONE` 替代科学验收。

## 支持矩阵

| 形态 | 平台与运行时 | 使用边界 |
| --- | --- | --- |
| Windows 桌面 | Windows 10/11 x64 | 当前系统用户；本地文件与命令具有桌面应用权限 |
| macOS 桌面 | Apple silicon / Intel | 未签名、未公证；手动下载更新 |
| 私有网页 | Linux x64；Docker Engine + Compose 插件 | **单用户、单实例**；不可提供给不互信用户 |
| 公共网页 | Linux x64；Node.js 20.19.5+ 与 npm | 多访客；用户自带集群账号和 API Key，无统一网站口令 |

## 安全边界

TRACE 是**有人监督的科研辅助工具**，不是无人值守的科学结论生成器。用户须审查命令、流程来源、输入、参考数据、QC 与最终结果。

- 集群权限来自用户自己的 SSH 账号；TRACE 不绕过集群授权，也不提供通用命令沙箱。
- 私有网页可执行部署容器内的本地操作，仅限可信单用户；公共网页禁用部署机本地文件/命令和 DSH。
- 网页后端执行请求时需要接触凭据。公共网页的个人状态保存在用户集群中，其文件权限不能防住集群管理员或网站运维方。
- 公网部署必须使用 HTTPS、限制后端端口并妥善备份；不要把网页服务直接暴露为明文 HTTP。

## 开发与文档

```bash
npm ci
npm run dev
npm run lint
npm test
```

CI 使用 Node.js 22.17.1 构建桌面安装包。技术栈为 Electron、React、TypeScript 与 Express。

- [开发总说明](docs/DEVELOPMENT_GUIDE.md)
- [macOS 安装与私有网页 Docker 部署](docs/MAC_WEB_DEPLOYMENT.md)
- [公共网页 npm 部署](docs/PUBLIC_WEB_DEPLOYMENT.md)
- [流程自动化约定](docs/FLOW_AUTOMATION.md)

## License

[MIT](LICENSE) © 2026 peacezha
