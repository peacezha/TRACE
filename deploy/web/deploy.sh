#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
command -v docker >/dev/null || { echo "请先安装 Docker Engine 和 Docker Compose 插件：https://docs.docker.com/engine/install/"; exit 1; }
docker compose version >/dev/null
case "${1:-}" in
  --url)
    public_url="${2:?需要 URL，例如 http://192.0.2.10:3003}"
    [[ "$public_url" =~ ^https?://[a-zA-Z0-9.:-]+/?$ ]] || { echo "URL 只能包含协议、主机和端口；不能包含路径或密码"; exit 1; }
    [[ ! -e .env ]] || { echo ".env 已存在；请手动编辑它或直接运行 ./deploy.sh，避免覆盖现有部署设置"; exit 1; }
    port="${3:-3003}"
    [[ "$port" =~ ^[0-9]+$ ]] && (( port >= 1024 && port <= 65535 )) || { echo "端口须为 1024–65535"; exit 1; }
    umask 077
    printf 'TRACE_WEB_ORIGIN=%s\nTRACE_BIND_IP=0.0.0.0\nTRACE_PORT=%s\n' "${public_url%/}" "$port" > .env
    ;;
  --password)
    docker compose exec -T hpclaw node -e "const f=require('fs');const c=JSON.parse(f.readFileSync('/data/web-access.json','utf8'));console.log('Username:',c.username);console.log('Password:',c.password)"
    exit
    ;;
  --status) docker compose ps; exit ;;
  --stop) docker compose stop; exit ;;
  --logs) docker compose logs --tail=100 hpclaw; exit ;;
  "")
    if [[ ! -e .env ]]; then
      umask 077
      printf 'TRACE_WEB_ORIGIN=http://127.0.0.1:3003\nTRACE_BIND_IP=127.0.0.1\nTRACE_PORT=3003\n' > .env
    fi
    ;;
  *) echo "用法: ./deploy.sh [--url http://服务器IP:3003 [端口] | --password | --status | --stop | --logs]"; exit 1 ;;
esac
docker compose up -d --build
echo "部署已启动。运行 ./deploy.sh --status 检查健康状态；运行 ./deploy.sh --password 查看访问账号。"
echo "这是单用户服务器工作台；请通过防火墙限制访问，公网使用 HTTPS。停止服务不会删除数据卷。"
