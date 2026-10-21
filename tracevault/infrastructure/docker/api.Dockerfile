# syntax=docker/dockerfile:1
FROM node:22.20-bookworm-slim AS build
WORKDIR /app
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile \
 && pnpm --filter @tracevault/event-schema build \
 && pnpm --filter @tracevault/api-contracts build \
 && pnpm --filter @tracevault/api build \
 && pnpm deploy --filter @tracevault/api --prod --legacy /out \
 && cp -r apps/api/dist /out/dist \
 && mkdir -p /out/infrastructure && cp -r infrastructure/database /out/infrastructure/

FROM node:22.20-bookworm-slim
ENV NODE_ENV=production
WORKDIR /srv/apps/api
COPY --from=build /out /srv/apps/api
# migrate.ts resolves migrations relative to dist/: ../../../../infrastructure
RUN mkdir -p /srv/infrastructure && mv /srv/apps/api/infrastructure/database /srv/infrastructure/ \
 && useradd --system --uid 10001 tracevault && mkdir -p /srv/var && chown tracevault /srv/var
USER tracevault
ENV TV_VAR_DIR=/srv/var
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://localhost:4000/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--enable-source-maps", "dist/main.js"]
