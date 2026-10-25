FROM node:22.17.1-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates bash curl openssh-client procps \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund
COPY --chown=node:node . .
RUN mkdir -p /data && chown node:node /data
USER node
ENV NODE_ENV=production PORT=3003 TRACE_HOST=0.0.0.0 TRACE_DATA_ROOT=/data
EXPOSE 3003
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3003/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "scripts/start-web.mjs"]
