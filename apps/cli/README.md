# relay

A terminal coding agent in the style of Claude Code and Codex CLI, where every request goes to
the agent, model and effort that fit it — Claude Code, Codex, OpenCode or Hermes — chosen with
TypeSafe's Jev model. Agents run in isolated sandboxes; their changes land in your repo as an
unstaged diff you review.

```
› Add apply_discount(items, pct) to prices.py, validating pct is between 0 and 100
  ⎿ opencode · deepseek-v4.1-flash  Jev 396ms · easy code change · est $0.0030
  ⏺ read /home/agent/workspace/prices.py
  ⏺ edit /home/agent/workspace/prices.py
  Added apply_discount(items, pct) to prices.py, raising ValueError outside 0–100.
  ✓ done · $0.0030 · 9.0s · turn 1 · 1 file +6 −0
```

## Install

Needs Docker and Node 22+.

```bash
npm install -g relaywise
relay up                      # asks for your keys once, pulls the images, starts the gateway
cd ~/code/your-repo && relay
```

`relay down` stops the gateway, `relay logs` follows it, `relay up --reconfigure` changes keys.

## Use

- `relay` — interactive session in the current directory. `/help` lists commands: `/route` shows
  where a task would go and why, `/harness` `/model` `/effort` `/objective` `/budget` steer
  routing, `/diff` and `/undo` review or revert the last change, `/memory` shows the project's
  ledger, `/new` starts a fresh session that is still briefed from it.
- `relay -p "task"` — one task, non-interactive (stdin works too); `--json` prints the result;
  exits non-zero on failure.
- `relay status`, `relay memory [turn]`.

Point it at a gateway with `RELAYWISE_URL` / `RELAYWISE_KEY` or `--url` / `--key`
(default `http://127.0.0.1:8420`).

Apache-2.0 · https://github.com/Sauhard74/relaywise
