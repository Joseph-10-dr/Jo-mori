# syntax=docker/dockerfile:1
FROM node:22.20-bookworm-slim AS build
WORKDIR /app
RUN corepack enable
ARG API_URL=http://api:4000
ENV API_URL=$API_URL NEXT_TELEMETRY_DISABLED=1
COPY . .
RUN pnpm install --frozen-lockfile \
 && pnpm --filter @tracevault/event-schema build \
 && pnpm --filter @tracevault/api-contracts build \
 && pnpm --filter @tracevault/web build

FROM node:22.20-bookworm-slim
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
WORKDIR /app
COPY --from=build /app /app
RUN useradd --system --uid 10001 tracevault
USER tracevault
EXPOSE 3000
CMD ["node_modules/.bin/pnpm", "--filter", "@tracevault/web", "start"]
