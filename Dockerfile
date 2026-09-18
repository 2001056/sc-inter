# syntax=docker/dockerfile:1

# ── 의존성 ─────────────────────────────────────────────
FROM node:22-alpine AS deps
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY app/api/package.json app/api/
COPY app/web/package.json app/web/
RUN pnpm install --frozen-lockfile

# ── 빌드 ──────────────────────────────────────────────
FROM deps AS build
WORKDIR /app
COPY . .
RUN pnpm build
# 서버 실행에 필요한 의존성만 추린다
RUN pnpm --filter @soccer/api deploy --prod --legacy /out/api

# ── 런타임 ────────────────────────────────────────────
FROM node:22-alpine AS runtime
ENV NODE_ENV=production
ENV PORT=8787
ENV HOST=0.0.0.0
WORKDIR /app

COPY --from=build /out/api/node_modules ./app/api/node_modules
COPY --from=build /out/api/package.json ./app/api/package.json
COPY --from=build /app/app/api/dist ./app/api/dist
COPY --from=build /app/app/web/dist ./app/web/dist

USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "app/api/dist/index.js"]
