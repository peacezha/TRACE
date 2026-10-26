# TRACE v0.5.15 公共网页部署（Linux / npm）

公共网页包面向多位访客：每人使用自己的集群 SSH 账号和模型 API Key，无统一网站口令。它禁用部署服务器的本地文件、本地命令和 DSH，**不要改用私有网页包对外提供服务**。

## 1. 安装与启动

前提：Linux x64、正式版 Node.js **20.19.5+** 与 npm。生产环境还需要已配置证书的 HTTPS 域名和反向代理；长期运营请选择仍受官方维护的 Node.js LTS。

```bash
curl -fLO https://github.com/peacezha/TRACE/releases/download/v0.5.15/TRACE-0.5.15-public-web-linux-x64-node20.tar.gz
curl -fLO https://github.com/peacezha/TRACE/releases/download/v0.5.15/TRACE-0.5.15-public-web-linux-x64-node20.tar.gz.sha256
sha256sum -c TRACE-0.5.15-public-web-linux-x64-node20.tar.gz.sha256
tar -xzf TRACE-0.5.15-public-web-linux-x64-node20.tar.gz
cd TRACE-0.5.15-public-web-linux-x64-node20
npm ci --omit=dev --ignore-scripts --no-audit --no-fund
npm start -- --url https://trace.example.org
```

将 `trace.example.org` 换成实际域名。`npm start` 是前台进程，默认监听 `127.0.0.1:3003`；生产环境交给 systemd、PM2 等现有服务管理器保持运行。本机测试可运行 `npm start`，访问 `http://127.0.0.1:3003`。

```bash
# 可选：修改端口；仅在可信网关/容器网络要求时修改监听地址
npm start -- --url https://trace.example.org --port 3013
npm start -- --url https://trace.example.org --host 0.0.0.0
```

`--host 0.0.0.0` 会暴露端口，必须用防火墙或安全组限制为仅可信反向代理可达。暂不支持 `/trace/` 子路径部署，也不能只上传静态文件。npm 不会申请证书或自动配置 HTTPS。

## 2. HTTPS 反向代理

把以下配置放入该域名已有的 **HTTPS `server` 块**，保留证书配置，不要覆盖其他站点：

```nginx
location / {
    proxy_pass http://127.0.0.1:3003;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_buffering off;
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
    client_max_body_size 0;
}
```

WebSocket 用于终端，SSE 用于 AI 响应，因此需保留升级头并关闭代理缓冲。按站点资源策略调整上传限制和超时。仅当后端只能被这一层可信代理访问时，才启用真实访客 IP 限速：

```bash
TRACE_TRUST_PROXY=1 npm start -- --url https://trace.example.org
```

浏览器访问的 HTTPS origin 必须与 `--url` 完全一致。证书续期、Nginx 重载和端口策略由部署方负责。

## 3. 账号、数据与权限边界

- 用户输入自己的 SSH 地址、账号、密码/动态验证码并确认主机指纹；API Key、模型和 HTTPS API 地址也由用户配置。禁止使用 HTTP、内网 API、URL 内嵌密码和自动重定向。
- 对话保存在个人集群 `~/trace_conversations/`，配置与恢复状态保存在 `~/trace_web/state.json`。目录权限为 0700、文件为 0600；API Key 虽为加密字段，但解密密钥也在该账号状态文件中。
- 后端执行 AI 请求时必须接触 API Key；上述权限不能对集群管理员或网站运维方保密。仅使用可信部署方，不要把同一 SSH 账号当作不同人的隔离边界。
- SSH 密码/TOTP 种子不写入浏览器持久存储。临时设置缓存权限为 0700，正常退出清理；崩溃或强杀后仍须由运维管理临时目录和备份。
- 每个集群连接有独立工作进程，HTTP、终端与报告资源检查访客归属。报告使用限时只读令牌，不应分享其资源 URL，也不要把报告与凭据混放。
- 已提交的批处理作业不会因退出网页而取消，但 AI、监控与自动续跑不保证离线永久运行；重新登录后恢复并监督执行。

## 4. 网络与容量

默认仅允许公网 SSH 目标，并拒绝部署机 loopback、链路本地和云元数据地址。确需连接私网集群时，管理员可显式放开：

```bash
TRACE_ALLOW_PRIVATE_CLUSTERS=1 npm start -- --url https://trace.example.org
```

这会允许 RFC1918/ULA 等私网 SSH 地址，但仍拒绝本机与元数据地址。必须同时用防火墙限制服务可达的 SSH 网段和端口，并在隔离主机上运行，避免部署机成为敏感内网代理。

默认全站最多 16 个集群连接、每位访客最多 4 个；可用 `TRACE_MAX_CLUSTER_CONNECTIONS=32` 调整（1–256）。实际容量取决于 CPU、内存、连接数和 API 使用量，公开运营前应在真实域名、网络与资源限制下验收。

## 5. 升级与回滚

将新版解压到新目录，安装依赖后，以相同 origin、端口和环境变量启动；先停止旧 TRACE 进程，再切换服务管理器的工作目录。用户状态位于各自集群，不需要复制网页服务器用户数据库。回滚时仍须使用**公共网页包**，不要将私有包无口令公开。

自动化覆盖访问隔离、CSRF、目标路由、私网地址校验、持久化与打包运行时，并使用临时 SSH 账号做集成检查；这不替代实际生产集群、付费模型 API、HTTPS 配置或生信结果的人工验收。
