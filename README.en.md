<p align="right">
  <a href="./README.md"><img src="https://img.shields.io/badge/语言-简体中文-lightgrey" alt="简体中文"></a>
  <a href="./README.en.md"><img src="https://img.shields.io/badge/Language-English-0969da" alt="English"></a>
</p>

<div align="center">

# TRACE

**A supervised HPC and bioinformatics workbench for research**

Bring AI agents, cluster jobs, file transfers and reusable analysis workflows into one workspace.

[![Version](https://img.shields.io/badge/version-v0.5.15-0969da)](https://github.com/peacezha/TRACE/releases/tag/v0.5.15)
[![Platforms](https://img.shields.io/badge/Windows%20%C2%B7%20macOS%20%C2%B7%20Linux%20%C2%B7%20Web-supported-2ea44f)](https://github.com/peacezha/TRACE/releases/tag/v0.5.15)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![Tests](https://github.com/peacezha/TRACE/actions/workflows/package-windows.yml/badge.svg)](https://github.com/peacezha/TRACE/actions/workflows/package-windows.yml)

**Ready-to-install desktop applications are available for both Windows and macOS. No development environment is required.**

[![Windows Installer](https://img.shields.io/badge/Windows_Installer-Download-0078D4?logo=windows&logoColor=white)](https://github.com/peacezha/TRACE/releases/download/v0.5.15/TRACE-Setup-0.5.15-x64.exe)
[![macOS Installer](https://img.shields.io/badge/macOS_Installer-Download-24292F?logo=apple&logoColor=white)](https://github.com/peacezha/TRACE/releases/tag/v0.5.15#desktop-installers-recommended)

**[All downloads](https://github.com/peacezha/TRACE/releases/tag/v0.5.15)** · [Features](#features) · [Quick start](#quick-start) · [Documentation](#development-and-documentation)

</div>

<p align="center">
  <img src="docs/figures/preset_and_custom_workflows_en.png" alt="TRACE preset and custom workflow workbench" width="960">
</p>

## Desktop Installers (Recommended)

Download and install or open TRACE like a regular desktop application. **No separate Node.js installation and no Git or npm development setup are required.**

| System | Supported devices | Direct download |
| --- | --- | --- |
| Windows 10/11 x64 | Standard Windows PCs; `.exe` installer | [Download Windows installer](https://github.com/peacezha/TRACE/releases/download/v0.5.15/TRACE-Setup-0.5.15-x64.exe) |
| macOS Apple silicon | M1, M2, M3, M4 and other ARM-based Macs; `.dmg` image | [Download for Apple silicon](https://github.com/peacezha/TRACE/releases/download/v0.5.15/TRACE-0.5.15-mac-arm64.dmg) |
| macOS Intel | Intel-based Macs; `.dmg` image | [Download for Intel](https://github.com/peacezha/TRACE/releases/download/v0.5.15/TRACE-0.5.15-mac-x64.dmg) |

The macOS packages are **not signed with an Apple Developer ID and are not notarized**. Confirm the system prompt when opening them for the first time. Updates are currently downloaded manually from Releases. See the [macOS and private web guide](docs/MAC_WEB_DEPLOYMENT.md).

## Web Deployment Packages

| Package | Intended use | Download |
| --- | --- | --- |
| Private web | Linux x64, Docker, one user in a trusted environment | [TRACE-0.5.15-web-linux-x64.tar.gz](https://github.com/peacezha/TRACE/releases/download/v0.5.15/TRACE-0.5.15-web-linux-x64.tar.gz) |
| Public web | Linux x64, Node.js/npm, multiple visitors | [TRACE-0.5.15-public-web-linux-x64-node20.tar.gz](https://github.com/peacezha/TRACE/releases/download/v0.5.15/TRACE-0.5.15-public-web-linux-x64-node20.tar.gz) |

These packages have different deployment models and security boundaries. Read the [private web](docs/MAC_WEB_DEPLOYMENT.md) and [public web](docs/PUBLIC_WEB_DEPLOYMENT.md) guides before deployment. Checksums and previous releases are available under [Releases](https://github.com/peacezha/TRACE/releases).

## Features

TRACE is designed for researchers working on academic computing clusters. It helps prepare, submit and monitor analyses through natural language while preserving command review, human approval, QC and reproducible execution records.

- **AI research assistant**: Conversational questions, commands and tool calls, result organization, job monitoring and checkpoint recovery. Critical actions require human approval; model output is not treated as a scientific conclusion.
- **Reusable analysis workflows**: Built-in ENCODE reference workflows and BioSkills, plus custom workflows, parameter validation, asset deployment, step status, executable run code and QC records.
- **Academic cluster jobs**: Connect over SSH and submit, monitor and inspect jobs on LSF, Slurm, PBS, Donau and similar scheduling environments, with host-fingerprint verification.
- **Transfers and remote editing**: Browse local and cluster files, transfer in both directions, resume interrupted transfers, edit remote text files and locate workflow outputs in the file workspace.
- **Research data and reports**: Query public biological data resources and review logs, QC metrics, figures, reports and traceable execution records in one place.
- **Desktop and web**: Native file and system capabilities on Windows/macOS, server-friendly web deployment, and per-visitor cluster-connection isolation on the public web.

## Quick Start

1. Download the Windows or macOS installer above, or start a web service using a deployment guide.
2. Connect with your own cluster SSH account, verify and accept the host fingerprint, then configure your model API endpoint and API key.
3. Select a workflow, review input data, software, reference data and parameters, then approve execution.
4. Supervise commands, jobs and resource usage. Review logs, QC and outputs when finished; `DONE` is not a substitute for scientific validation.

## Support Matrix

| Form | Platform and runtime | Usage boundary |
| --- | --- | --- |
| Windows desktop | Windows 10/11 x64 | Current system user; local files and commands have desktop-application permissions |
| macOS desktop | Apple silicon / Intel | Not Developer ID signed or notarized; manual updates |
| Private web | Linux x64; Docker Engine + Compose plugin | **Single user, single instance**; not for mutually untrusted users |
| Public web | Linux x64; Node.js 20.19.5+ and npm | Multiple visitors; users supply cluster accounts and API keys; no shared site password |

## Security Boundaries

TRACE is a **supervised research assistant**, not an unattended generator of scientific conclusions. Users must review commands, workflow sources, inputs, reference data, QC and final results.

- Cluster permissions come from each user's own SSH account. TRACE does not bypass cluster authorization or provide a general-purpose command sandbox.
- The private web package can perform local operations inside its deployment container and is limited to one trusted user. The public web package disables local files, local commands and DSH on the deployment host.
- The web backend must handle credentials when executing requests. Public-web personal state is stored on the user's cluster; its file permissions cannot protect it from cluster administrators or site operators.
- Public deployments must use HTTPS, restrict access to backend ports and maintain backups. Do not expose the service directly over plaintext HTTP.

## Development and Documentation

```bash
npm ci
npm run dev
npm run lint
npm test
```

CI builds desktop installers with Node.js 22.17.1. The application uses Electron, React, TypeScript and Express.

- [Development guide](docs/DEVELOPMENT_GUIDE.md)
- [macOS installation and private web Docker deployment](docs/MAC_WEB_DEPLOYMENT.md)
- [Public web npm deployment](docs/PUBLIC_WEB_DEPLOYMENT.md)
- [Workflow automation conventions](docs/FLOW_AUTOMATION.md)

## License

[MIT](LICENSE) © 2026 peacezha
