# jev-route gateway. Talks to the host Docker daemon (socket mount) to start one
# agent-runtime container per session.
FROM node:22-bookworm-slim
COPY --from=docker:27-cli /usr/local/bin/docker /usr/local/bin/docker
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.json ./
COPY packages ./packages
COPY apps ./apps
RUN pnpm install --frozen-lockfile && pnpm store prune
ENV HOST=0.0.0.0 \
    PORT=8420 \
    JEV_ROUTE_EXECUTOR=docker \
    JEV_ROUTE_DB=/app/data/jev-route.db
EXPOSE 8420
CMD ["pnpm", "start"]
