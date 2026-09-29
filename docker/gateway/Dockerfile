# relaywise gateway. Talks to the host Docker daemon (socket mount) to start one
# agent-runtime container per session.
FROM node:22-bookworm-slim
LABEL org.opencontainers.image.source="https://github.com/Sauhard74/relaywise" \
      org.opencontainers.image.description="relaywise gateway: HarnessRouter/UHP-compatible API that routes tasks to coding agents" \
      org.opencontainers.image.licenses="Apache-2.0"
COPY --from=docker:27-cli /usr/local/bin/docker /usr/local/bin/docker
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.json ./
COPY packages ./packages
COPY apps ./apps
RUN pnpm install --frozen-lockfile && pnpm store prune
ENV HOST=0.0.0.0 \
    PORT=8420 \
    RELAYWISE_EXECUTOR=docker \
    RELAYWISE_DB=/app/data/relaywise.db
EXPOSE 8420
CMD ["pnpm", "start"]
