# jev-route agent runtime: one container per session, all harness CLIs + agentd.
# Build from the repo root:  pnpm build:image
FROM node:22-bookworm-slim

ARG CLAUDE_CODE_VERSION=2.1.283
ARG CODEX_VERSION=0.154.0
ARG OPENCODE_VERSION=1.18.33
ARG HERMES_VERSION=0.19.0

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl git jq less procps ripgrep tini \
      python3 python3-venv python3-pip build-essential \
 && rm -rf /var/lib/apt/lists/*

RUN npm install -g --omit=dev \
      "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
      "@openai/codex@${CODEX_VERSION}" \
      "opencode-ai@${OPENCODE_VERSION}" \
 && npm cache clean --force

RUN python3 -m venv /opt/hermes \
 && /opt/hermes/bin/pip install --no-cache-dir "hermes-agent==${HERMES_VERSION}" \
 && ln -s /opt/hermes/bin/hermes /usr/local/bin/hermes

COPY packages/agentd/dist/agentd.mjs /opt/agentd/agentd.mjs
RUN printf '#!/bin/sh\nexec node /opt/agentd/agentd.mjs "$@"\n' > /usr/local/bin/agentd \
 && chmod +x /usr/local/bin/agentd

RUN useradd --create-home --uid 1001 --shell /bin/bash agent \
 && mkdir -p /home/agent/workspace \
 && git config --system user.name "jev-route agent" \
 && git config --system user.email "agent@jev-route.local" \
 && git config --system init.defaultBranch main \
 && chown -R agent:agent /home/agent

USER agent
ENV HOME=/home/agent \
    DISABLE_AUTOUPDATER=1 \
    OPENCODE_DISABLE_AUTOUPDATE=1 \
    AGENTD_STATE_DIR=/tmp/agentd
WORKDIR /home/agent/workspace

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["sleep", "infinity"]
