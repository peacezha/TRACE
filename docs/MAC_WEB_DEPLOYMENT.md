# TRACE v0.5.15：macOS 安装与私有网页部署

本文适用于 macOS 桌面版和 **单用户私有网页包**。面向多位访客的公共服务必须使用 [公共网页 npm 部署指南](PUBLIC_WEB_DEPLOYMENT.md)，不能将私有实例直接开放给不互信用户。

## macOS 安装

- Apple silicon：[下载 TRACE-0.5.15-mac-arm64.dmg](https://github.com/peacezha/TRACE/releases/download/v0.5.15/TRACE-0.5.15-mac-arm64.dmg)
- Intel Mac：[下载 TRACE-0.5.15-mac-x64.dmg](https://github.com/peacezha/TRACE/releases/download/v0.5.15/TRACE-0.5.15-mac-x64.dmg)

打开 DMG，将 TRACE 拖入 Applications，再从 Applications 启动，无需另装 Node.js。将 DMG 与平台合并校验清单下载到同一目录后核对：

```bash
curl -fLO https://github.com/peacezha/TRACE/releases/download/v0.5.15/TRACE-0.5.15-platforms-SHA256SUMS.txt
grep 'TRACE-0.5.15-mac-arm64.dmg$' TRACE-0.5.15-platforms-SHA256SUMS.txt | shasum -a 256 -c -
# Intel 包将两处 mac-arm64 改为 mac-x64
```

**这批 DMG 未使用 Apple Developer ID 签名，也未经过 Apple 公证。** Gatekeeper 可能阻止首次打开；确认下载来源和 SHA-256 后，按 [Apple 官方说明](https://support.apple.com/102445) 在“系统设置 → 隐私与安全性”中仅允许此应用打开。不要全局关闭 Gatekeeper，也不要绕过来源不明的安装包。

当前 macOS 版应手动下载更新，不承诺未签名包的自动更新。macOS 与 Windows 的配置和密钥保存在各自系统用户目录，不自动跨设备同步。

## 私有网页：Docker 部署

目标环境：Linux x86_64/amd64，已安装 [Docker Engine](https://docs.docker.com/engine/install/) 与 [Docker Compose 插件](https://docs.docker.com/compose/install/)。x86_64 包不能直接用于 ARM 服务器；脚本不会安装系统软件或修改防火墙。

```bash
curl -fLO https://github.com/peacezha/TRACE/releases/download/v0.5.15/TRACE-0.5.15-web-linux-x64.tar.gz
curl -fLO https://github.com/peacezha/TRACE/releases/download/v0.5.15/TRACE-0.5.15-web-linux-x64.tar.gz.sha256
sha256sum -c TRACE-0.5.15-web-linux-x64.tar.gz.sha256
tar -xzf TRACE-0.5.15-web-linux-x64.tar.gz
cd TRACE-0.5.15-web-linux-x64
./deploy.sh
./deploy.sh --password
```

默认仅发布 `127.0.0.1:3003`，适合先通过 SSH 隧道使用。在本地电脑执行：

```bash
ssh -L 3003:127.0.0.1:3003 用户名@服务器地址
```

然后访问 `http://127.0.0.1:3003`。网页工作台账号与进入应用后的集群 SSH 账号是两套凭据。首次启动自动生成访问账号，保存在数据卷的 `/data/web-access.json`，可用 `./deploy.sh --password` 查看。

受防火墙保护的内网测试可使用 `./deploy.sh --url http://服务器IP:3003`；**公网不可使用明文 HTTP 传输集群密码和 API Key**。已有 `.env` 时，`--url` 会拒绝覆盖，请手动编辑后运行 `./deploy.sh`。

## HTTPS 反向代理

先准备域名和有效证书。将部署目录中的 `.env` 设置为：

```dotenv
TRACE_WEB_ORIGIN=https://trace.example.org
TRACE_BIND_IP=127.0.0.1
TRACE_PORT=3003
TRACE_WEB_COOKIE_SECURE=1
TRACE_TRUST_PROXY=1
```

然后重新构建并启动：

```bash
./deploy.sh
```

在该域名的 HTTPS `server` 块中转发全部路径：

```nginx
location / {
    proxy_pass http://127.0.0.1:3003;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_buffering off;
    proxy_read_timeout 3600s;
}
```

保留 `/socket.io/`、HTML 和报告资源路径；WebSocket 用于终端，SSE 用于 AI 响应。仅允许可信反向代理访问 3003 端口，并按数据大小配置上传限制。`TRACE_TRUST_PROXY=1` 只应在这层可信代理存在时启用。证书申请、续期与 Nginx 重载由部署方负责，`deploy.sh` 不会自动完成。

## 运维与数据

```bash
./deploy.sh --status
./deploy.sh --logs
./deploy.sh --password
./deploy.sh --stop
./deploy.sh
```

停止或重建容器不会删除数据。Compose 项目名为 `hpclaw-web`，命名数据卷为 `hpclaw-web_hpclaw-data`；备份整个数据卷，其中包含对话、设置和加密主密钥。**不要执行 `docker compose down -v`**，否则会删除数据卷。启动时需要访问 Docker 镜像源和 npm 注册源。

## 权限与功能边界

- 这是单用户、单实例的可信工作台；同一实例内的配置、任务、对话和服务器本地文件共享，不是多用户 SaaS。
- “本地执行”和“本地文件”发生在 Linux 容器内，不是浏览器所在电脑。容器中的 Agent 拥有其容器用户权限，并非抵御恶意用户的沙箱。
- 主机目录默认不挂载；确有需要时只挂载明确批准的数据目录。服务器必须能访问目标集群 SSH 和模型 API。
- 浏览器不提供 Electron 的系统密钥库、原生路径选择、外部编辑器和桌面自动更新；不要把网页端视为所有原生功能的等价替代。
- 重启服务后需要重新连接 SSH。已提交的批处理不会自动取消，但监控与续跑需要恢复连接；所有命令、QC 和科研结果仍需人工监督与验收。
