# Architecture and development

```
relay CLI / your app ──HTTP──▶ gateway ─▶ router (Jev → scoring, or keyword fallback) ─▶ budget check
                                  │
                                  ├─▶ Docker: one sandbox per session ─▶ agentd ─▶ claude · codex · opencode · hermes
                                  ◀── Responses stream ◀── normalizer ◀── agent events
                                  └─▶ SQLite: runs · sessions · projects · routing decisions · outcomes
```

| Path | What's in it |
|---|---|
| `apps/cli` | The `relay` terminal agent (Ink) and `relay up / down / logs` |
| `apps/gateway` | HTTP API, streaming, sessions and projects, SQLite store, Docker and local executors, dashboard |
| `packages/router` | Jev client, question set, scoring, keyword fallback, cache, evaluation |
| `packages/agentd` | Runs inside the sandbox: starts an agent's CLI headless and normalizes its output; session ledger |
| `packages/core` | Shared types, the catalog and cost model, secret redaction |
| `docker/` | The agent sandbox image (all four agent CLIs + agentd) and the gateway image |

## Isolation and security

- One container per session: non-root, all Linux capabilities dropped, `no-new-privileges`,
  CPU/memory/process limits, and a configurable network (`RELAYWISE_CONTAINER_NETWORK=none` for
  offline work). Idle containers are removed after `RELAYWISE_CONTAINER_IDLE_MS`; the session's
  files survive on a volume until `RELAYWISE_SESSION_RETENTION_MS`.
- Provider keys go to each run over stdin, never into container settings, so they don't appear in
  `docker inspect`. Each agent only receives its own provider's keys, and key values are redacted
  from all output.
- Agents run with their permission prompts turned off because the container is the boundary; the
  `local` executor has no isolation and is for development only.
- API access: bearer tokens from `RELAYWISE_API_KEYS`, compared in constant time.

## Development

```bash
corepack enable && pnpm install
pnpm test                 # unit and integration tests; no keys or Docker needed
pnpm typecheck
pnpm eval:router          # routing quality (uses Jev if TYPESAFE_API_KEY is set)
pnpm build:cli            # apps/cli/dist/relay.mjs
```

Run the stack from source with `cp .env.example .env && docker compose up --build`, or without
containers (agents run on your machine and reuse your CLI logins) with
`RELAYWISE_EXECUTOR=local pnpm start`. `RELAYWISE_ENABLE_MOCK=1` adds a deterministic `mock`
agent for demos and tests without provider keys.

Docker end-to-end tests: `pnpm build:image && RELAYWISE_DOCKER_E2E=1 pnpm test apps/gateway/test/docker.e2e.test.ts`.

Protocol conformance, with HarnessRouter's suite:

```bash
pip install -e <harnessrouter>/protocol/conformance
uhp-conformance --base-url http://127.0.0.1:8420 --class core --harness-id chrn_auto
```

The demo GIF is recorded with [VHS](https://github.com/charmbracelet/vhs): `vhs docs/demo.tape`.

## Releasing

Bump the version in `apps/cli/package.json` and `VERSION` in `apps/cli/src/index.tsx`, commit,
and push a `v<version>` tag. The release workflow builds both images for amd64 and arm64, pushes
them to `ghcr.io/sauhard74`, publishes the CLI to npm with provenance, and creates the GitHub
release.
