# Harness CLI

**Let AI agents build entire applications — not just answer questions.**

Harness CLI orchestrates multiple AI agents in a structured sprint cycle to go from a one-line prompt to a working application. A researcher understands the domain, a planner breaks the work into features, a generator writes the code, and an evaluator tests the running app. When things fail, the loop repairs them automatically.

The harness — not the model — owns the state. Every decision, artifact, and evaluation is persisted to disk. Runs can be interrupted and resumed. You stay in control.

Inspired by Anthropic's ["Building effective agents"](https://www.anthropic.com/research/building-effective-agents) and their engineering post on [harness design for long-running apps](https://www.anthropic.com/engineering/harness-design-long-running-apps).

## Why this exists

Coding agents are powerful at single tasks: write a function, fix a bug, scaffold a component. But building a whole application requires *sustained multi-step reasoning* across many sessions — and that's where single-session agents lose the thread.

Harness CLI solves this with **separation of concerns**:

- **Bounded roles** — Each agent has a specific job (research, plan, generate, evaluate) with a clear contract. No single session needs to hold the whole problem in context.
- **Bilateral contracts** — Before writing code, the generator and evaluator negotiate an explicit "done" definition with negotiable pass bars. This prevents scope drift and makes evaluation objective.
- **Durable state** — Every sprint persists its plan, contract, code, and evaluation to disk. The harness can resume mid-sprint, mid-negotiation, or mid-repair — without asking the model to remember anything.
- **Harness-enforced quality** — The evaluator scores against anchored rubrics. The harness writes an independent verdict by checking every score against thresholds. No rubber-stamping.
- **Split routing** — Different roles can use different providers. Research with Claude, generate with Codex, evaluate with Claude — mix and match based on what works.

## How it works

```
You: "Build a project management app with Kanban boards"
                            |
                    +-------v-------+
                    |  Researcher   |  Analyzes domain, defines eval criteria
                    +-------+-------+
                    +-------v-------+
                    |    Planner    |  Creates spec, feature backlog, principles
                    +-------+-------+
                            |
              +-------------v-------------+
              |  For each feature (sprint) |
              |                           |
              |  +---------------------+  |
              |  | Contract negotiation|  |  Generator drafts, evaluator reviews
              |  +--------+-----------+  |
              |  +--------v-----------+  |
              |  |     Generator      |  |  Implements the feature
              |  +--------+-----------+  |
              |  +--------v-----------+  |
              |  |   Dev smoke check  |  |  HTTP check on running server
              |  +--------+-----------+  |
              |  +--------v-----------+  |
              |  |     Evaluator      |  |  Tests the running app, scores it
              |  +--------+-----------+  |
              |  +--------v-----------+  |
              |  |  Harness verdict   |  |  Independent pass/fail from scores
              |  +--------+-----------+  |
              |           |              |
              |     Pass? --- No --> Repair (with frozen evidence + directive)
              |       |              |
              |      Yes             +-- retry up to maxRepairRounds
              |       |                          |
              |       v                          |
              |  Next feature <------------------+
              +---------+------------------------+
                        |
              +---------v-----------+
              | Final regression    |  Dev smoke + smoke test on completed app
              +---------------------+
                        |
                    Done: working app
```

## Quick start

### Prerequisites

- Node.js >= 20
- An Anthropic API key (for the default Claude Agent SDK provider)

### Install and run

```bash
git clone https://github.com/hyspacex/harness-cli.git
cd harness-cli
npm install
npm run build:harness
```

Generate a starter config:

```bash
npm run harness -- init
```

This creates `harness.config.json` with all roles on the same provider. Then point it at a project:

```bash
# Create a new project directory
mkdir ../my-app && cd ../my-app

# Run the harness
npm run --prefix ../harness-cli harness -- run \
  "Build a personal finance tracker with expense categories, monthly budgets, and charts" \
  --workspace .
```

Or run it from the harness-cli directory with an explicit workspace:

```bash
npm run harness -- run \
  "Build a task management app with drag-and-drop Kanban boards" \
  --workspace /path/to/your/project
```

### Resume and inspect

```bash
# Resume an interrupted or failed run
npm run harness -- resume <run-id>

# See all runs and their status
npm run harness -- status

# See details for a specific run
npm run harness -- status <run-id>
```

## Providers

Harness CLI is provider-agnostic. You choose which AI backend builds your app — and you can use different providers for different roles.

### Claude Agent SDK (default)

Uses `@anthropic-ai/claude-agent-sdk` — the same engine behind Claude Code. Supports per-role system prompts, MCP servers, project settings, and session resume for repair rounds.

### Codex App Server

Uses OpenAI's `codex app-server` via JSON-RPC. The harness manages auth, thread resume, and approval requests. If no Codex account is active, the harness starts the ChatGPT login flow automatically.

## Role routing

`provider` sets the global default. `roleProviders` overrides specific roles:

```json
{
  "provider": "claude-sdk",
  "roleProviders": {
    "planner": "codex",
    "generator": "codex"
  }
}
```

In this example, `researcher` and `evaluator` use Claude while `planner` and `generator` route to Codex. The harness records per-role/provider performance metrics so you can compare routing strategies empirically.

When multiple providers are used, the harness freezes benchmark artifacts under `benchmarks/frozen/` so later comparisons use stable inputs.

## Configuration

Config is resolved as: **defaults** -> `harness.config.json` -> **CLI flags**. Key options:

| Option | Default | What it does |
|---|---|---|
| `provider` | `claude-sdk` | Global default backend |
| `roleProviders` | all roles use `provider` | Per-role provider overrides |
| `workspace` | `.` | Path to the project being built |
| `runRoot` | `.harness` | Where run artifacts are stored |
| `maxSprints` | `8` | Max features to implement |
| `maxRepairRounds` | `2` | Retries per feature on eval failure |
| `maxNegotiationRounds` | `3` | Contract negotiation rounds before accepting |
| `failFast` | `true` | Stop the run on first blocked feature |
| `smoke.install` | `null` | Install command (runs once per run) |
| `smoke.start` | `null` | Dev server start command |
| `smoke.test` | `null` | Smoke test command (runs before each eval) |

### Example configs

A typical Claude-only setup:

```json
{
  "provider": "claude-sdk",
  "workspace": ".",
  "runRoot": ".harness",
  "smoke": {
    "install": "npm install",
    "start": "npm run dev -- --host 127.0.0.1 --port 3000",
    "test": "npm test"
  },
  "claudeSdk": {
    "model": "claude-opus-4-7",
    "permissionMode": "bypassPermissions",
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

A mixed-provider setup (Claude for research/evaluation, Codex for planning/generation):

```json
{
  "provider": "claude-sdk",
  "roleProviders": {
    "planner": "codex",
    "generator": "codex"
  }
}
```

See `examples/harness.config.json` for a full config with all options.

## What the harness enforces

The harness does not trust model output at face value. It enforces:

- **Independent verdicts** — After each evaluation, the harness writes a `HarnessVerdict` JSON by checking every score against thresholds. The evaluator's opinion of pass/fail is advisory.
- **Repair directives** — On failure, the harness writes a structured `RepairDirective` with failing criteria, rubric descriptions, must-fix bugs, and remaining rounds — so the generator gets precise guidance, not prose.
- **Negotiable pass bars** — Contracts can propose pass bar overrides for specific criteria. The harness validates and applies them.
- **Dev-server smoke** — When `smoke.start` is configured, the harness performs an HTTP check on the running server before the evaluator executes.
- **Frozen evidence** — Evaluator screenshots and diagnostics are copied to `evidence-frozen/` with SHA256 manifests. If the generator tampers with them, the harness throws.
- **Final regression** — After the entire backlog passes, the harness runs a final smoke sweep to catch cross-feature regressions.
- **Canonical JSON** — Contracts and evaluations are written as both markdown (human-readable) and JSON (machine-validated). The harness validates the JSON structure.

## Run artifact layout

Every run produces a structured artifact tree:

```
.harness/runs/<run-id>/
├── run.json                            # Full state — enables resume
├── metrics.json                        # Per-role/provider performance
├── prompt.md                           # Your original request
├── events.ndjson                       # Append-only event log
├── progress.md                         # Cross-sprint context
├── handoff/next.md                     # What to work on next
├── plan/
│   ├── research-brief.md               # Domain analysis
│   ├── eval-criteria.json              # Scoring rubrics
│   ├── spec.md                         # Product spec
│   ├── backlog.json                    # Feature backlog
│   └── project-principles.md           # Quality principles
├── contracts/
│   ├── contract-01.md                  # Sprint 1 contract (markdown)
│   ├── contract-01.json                # Sprint 1 contract (canonical JSON)
│   └── contract-01-review-00.md        # Evaluator's review of contract
├── evals/
│   ├── eval-01-r00.md                  # Sprint 1 eval (markdown)
│   ├── eval-01-r00.json                # Sprint 1 eval (canonical JSON)
│   ├── evidence/s01-r00/               # Live evaluator evidence
│   └── evidence-frozen/s01-r00/        # Frozen snapshot + manifest
├── verdicts/
│   └── verdict-01-r00.json             # Harness-written pass/fail
├── repair-directives/
│   └── repair-s01-r00.json             # Structured repair guidance
├── benchmarks/frozen/                  # Frozen artifacts (multi-provider runs)
└── logs/
    ├── researcher.raw.txt              # Raw agent output
    └── researcher.parsed.json          # Parsed JSON result
```

## Works for any project type

The harness is not locked to web apps. The researcher generates project-specific evaluation criteria, so the same engine works for:

- **Frontend apps** — Playwright-powered visual QA, responsive layout checks
- **Backend APIs** — Schema validation, HTTP smoke tests, error handling
- **CLI tools** — Command invocation tests, help output, error messages
- **Libraries** — API ergonomics, test coverage, type safety
- **Full-stack apps** — Combine browser QA with API checks

Adjust `smoke.*` commands and evaluator tooling to match your project. See [docs/generalization.md](docs/generalization.md) for details.

## CLI reference

```
harness init   [--config path]                     Write default config
harness run    "prompt" [flags]                     Start a new run
harness resume <run-id> [--config path]             Resume interrupted run
harness status [run-id] [--config path]             Inspect runs

Flags:
  --config <path>                Config file (default: ./harness.config.json)
  --provider <name>              claude-sdk | codex
  --workspace <path>             Project directory
  --run-root <path>              Artifact storage directory
  --approval <policy>            allow_once | allow_always | reject_once | reject_always
  --max-negotiation-rounds <N>   Contract negotiation cap (default: 3)
```

## Contributing

The harness core is ~2000 lines of TypeScript. Some areas worth contributing to:

- **Branch-per-sprint isolation** — git branch before each sprint, auto-rollback on failure
- **Budget controls** — token tracking and cost limits per run
- **Project profiles** — preset configs for `webapp`, `api`, `cli`, `library`
- **Mid-run replanning** — let the user change direction without starting over
- **More providers** — Gemini, open-source models, or custom backends

## License

Apache 2.0
