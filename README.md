# Harness CLI

A CLI harness for long-running app-development loops:

- a **researcher** turns a short ask into domain notes plus project-specific evaluation criteria
- a **planner** turns that into a durable spec + backlog
- a **contract** step narrows one sprint into an explicit done definition
- a **generator** implements that sprint
- an **evaluator** grades the result and sends back concrete defects
- the loop repeats until the sprint passes, then moves to the next backlog item

The harness owns the durable memory, not the model session. Every sprint leaves files under `.harness/runs/<run-id>/`, so you can resume interrupted runs, inspect failures, and keep the orchestration logic outside the coding agent.

## Supported backends

### 1. Claude Agent SDK

`claude-sdk` is the default provider. It uses `@anthropic-ai/claude-agent-sdk` directly, supports per-role system prompts, MCP servers, project settings, and generator session resume for repair rounds.

Good fit when you want:

- Claude Code behavior via the SDK
- project-local `CLAUDE.md` / settings support
- MCP-backed evaluation such as Playwright
- session reuse across repair rounds

### 2. Codex App Server

`codex` starts `codex app-server` and speaks the JSON-RPC protocol over stdio. The harness manages auth, thread resume, approval requests, and streamed turn results.

Good fit when you want:

- an official Codex integration surface instead of a custom adapter
- reusable Codex threads across repair rounds
- harness-controlled approvals and sandboxing
- existing Codex auth with ChatGPT browser login when needed

If no Codex account is active, the harness starts the ChatGPT login flow and waits for the browser callback before continuing.

## Quick start

Write a starter config:

```bash
npm run harness -- init
```

Then edit `harness.config.json` and run:

```bash
npm run harness -- run "Build a simple internal dashboard for tracking support tickets"
```

Resume a failed or interrupted run:

```bash
npm run harness -- resume <run-id>
```

Inspect recent runs:

```bash
npm run harness -- status
```

## Example config

There is a full example at `examples/harness.config.json`.

A typical Claude Agent SDK setup looks like this:

```json
{
  "provider": "claude-sdk",
  "workspace": ".",
  "runRoot": ".harness",
  "maxSprints": 8,
  "maxRepairRounds": 2,
  "maxNegotiationRounds": 3,
  "failFast": true,
  "approvalPolicy": "allow_once",
  "git": {
    "autoCommit": false
  },
  "smoke": {
    "install": "npm install",
    "start": "npm run dev -- --host 127.0.0.1 --port 3000",
    "test": "npm test",
    "stop": null,
    "startTimeout": 15000,
    "startReadyPattern": null
  },
  "claudeSdk": {
    "model": "claude-sonnet-4-6",
    "permissionMode": "bypassPermissions",
    "mcpServers": {},
    "allowedTools": [],
    "maxTurns": null,
    "env": {},
    "roleOverrides": {
      "generator": {
        "settingSources": ["project"],
        "allowedTools": ["Skill"]
      },
      "evaluator": {
        "settingSources": ["project"],
        "mcpServers": {
          "playwright": {
            "command": "npx",
            "args": ["-y", "@playwright/mcp@latest"]
          }
        }
      }
    }
  }
}
```

A typical Codex App Server setup looks like this:

```json
{
  "provider": "codex",
  "workspace": ".",
  "runRoot": ".harness",
  "maxSprints": 8,
  "maxRepairRounds": 2,
  "maxNegotiationRounds": 3,
  "failFast": true,
  "approvalPolicy": "allow_once",
  "codex": {
    "command": "codex",
    "args": ["app-server"],
    "env": {},
    "model": "gpt-5.4",
    "effort": "xhigh",
    "summary": "concise",
    "serviceTier": "fast",
    "sandboxMode": "workspaceWrite",
    "networkAccess": true,
    "approvalMode": "onRequest",
    "assumePlaywrightMcp": false,
    "roleOverrides": {
      "generator": {},
      "evaluator": {}
    }
  }
}
```

## CLI shape

```text
harness init [--config harness.config.json]
harness run "Build a ..." [--config file] [--provider claude-sdk|codex] [--workspace path]
harness resume <runId> [--config file]
harness status [runId] [--config file]

Flags:
  --config <path>                  Config file path (default: ./harness.config.json)
  --provider <name>                Override provider from config
  --workspace <path>               Override workspace from config
  --run-root <path>                Override run root from config
  --approval <policy>              allow_once | allow_always | reject_once | reject_always
  --max-negotiation-rounds <N>     Max contract negotiation rounds (default: 3)
```

## Current file protocol

### Researcher

Writes:

- `plan/research-brief.md`
- `plan/eval-criteria.json`

### Planner

Writes:

- `plan/spec.md`
- `plan/backlog.json`
- `plan/project-principles.md`

### Contract step

Writes:

- `contracts/contract-XX.md`
- `contracts/contract-XX-review-YY.md`

### Generator

Updates:

- your repository
- `progress.md`
- `handoff/next.md`
- optionally git, if `git.autoCommit` is `true`

### Evaluator

Writes:

- `evals/eval-XX-rYY.md`
- `logs/*.parsed.json`
- `logs/*.raw.txt`

## How to extend it

The scaffold is intentionally small. Useful next upgrades would be:

1. add a continuous-build mode that skips sprint contracts for simpler tasks
2. add a final regression sweep after the backlog is done
3. add branch-per-sprint isolation and auto-rollback on failed evaluation
4. make git actions harness-enforced instead of prompt-enforced
5. add budget controls and task-level timeouts
6. support mid-run replanning when the user changes direction

## Important caveats

- The harness expects the agent’s final response to be JSON-only. Raw outputs are still saved under `logs/` for debugging.
- Claude browser QA is only guaranteed if the evaluator has a Playwright MCP server configured.
- Codex browser QA is optional; set `codex.assumePlaywrightMcp` only if your Codex environment already provides that tooling.
- Codex auth is ChatGPT-login only in this scaffold. Keep the app-server process alive until the browser flow reaches the local callback.
- Codex fast mode is requested by the harness config and also pinned in `.codex/config.toml` for trusted Codex projects.
- If the workspace has `CLAUDE.md` but no `AGENTS.md`, the harness will copy `CLAUDE.md` to `AGENTS.md` for Codex runs so project instructions are visible to both providers.
