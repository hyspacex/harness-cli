# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A long-running harness CLI for app-development loops. The harness orchestrates four bounded agent roles — researcher, planner, generator, evaluator — in a sprint cycle. Contracts are negotiated bilaterally: the generator drafts, the evaluator reviews, and they iterate until agreement or the negotiation cap is hit. The harness owns all durable state, not the model session.

Routing is per-role: each role maps to a provider via `roleProviders`. A global `provider` sets the default; `roleProviders` only lists roles that differ.

## Commands

```bash
npm run build:harness    # Compile harness TypeScript to dist/
npm run build            # Build the app (vite build)
npm run harness -- init  # Write default harness.config.json
npm run harness -- run "Build a ..." [--provider claude-sdk|codex] [--workspace path]
npm run harness -- resume <run-id>
npm run harness -- status [run-id]
```

Tests: `node --test test/contract-pass-bars.test.mjs`. Node.js >= 20. ESM-only (`"type": "module"` in package.json). The `npm run harness` script auto-runs `build:harness` before executing.

## Architecture

### State machine (`src/harness.ts`)

`HarnessRunner.execute()` drives the loop:

1. install configured skills into both `.claude/skills/` and `.agents/skills/`
2. for Codex runs, copy `CLAUDE.md` to `AGENTS.md` if `AGENTS.md` is missing
3. run the researcher if `plan/research-brief.md` or `plan/eval-criteria.json` are missing
4. run the planner if `plan/spec.md`, `plan/backlog.json`, or `plan/project-principles.md` are missing
5. for each pending feature: negotiate contract, generate, evaluate, repair until pass or round cap
6. after the backlog completes, run a final regression sweep (dev smoke + smoke test)
7. persist `run.json` and `metrics.json` after every material state change so `resume` can continue safely

The harness keeps durable state under `<runRoot>/runs/<run-id>/`.

### Provider registry (`src/providers/index.ts`)

The `ProviderRegistry` replaces the old single-provider pattern. It:

- builds a `RoleProviderMap` from `config.roleProviders`
- lazily creates `ProviderRuntime` instances (one per unique provider name)
- routes `runTask()` calls to the correct runtime based on `task.kind`
- exposes `getTaskCapabilities(role)` so prompts know what each role can do (browser QA, session resume, etc.)
- tags every task result with the provider that executed it

### Config layering (`src/config.ts`)

Config is resolved as `DEFAULT_CONFIG -> harness.config.json -> CLI flag overrides`, all merged via `deepMerge`. `normalizeRoleProviders()` fills in the full four-role map from `provider` + any partial `roleProviders` overrides. Paths (`workspace`, `runRoot`) are resolved relative to the config file's directory, not `cwd`.

### Providers (`src/providers/`)

Every provider implements `ProviderRuntime.runTask(task) -> { rawText, parsed, meta }`.

- `claude-sdk.ts` — uses `@anthropic-ai/claude-agent-sdk` `query()` and supports per-role `systemPrompt`, `mcpServers`, `settingSources`, `allowedTools`, and `resume`
- `codex.ts` + `codex-client.ts` — starts `codex app-server`, manages ChatGPT login auth, threads, approvals, and streamed turn output
- `mock.ts` — deterministic mock provider for testing the harness loop (untracked)

System prompts from `SYSTEM_PROMPTS` in `prompts.ts` are injected into Claude SDK role overrides by `providers/index.ts` (`injectClaudeSystemPrompts`), merged with any user-configured system prompt via the `claude_code` preset.

### Contract negotiation

The generator drafts a contract (markdown + canonical JSON), the evaluator reviews it. If rejected, the generator revises using the review feedback. This repeats up to `maxNegotiationRounds` (default 3). State is tracked in `runState.currentNegotiation` with per-round draft/review paths, enabling resume mid-negotiation.

Contracts can propose `passBarOverrides` — adjusted pass bars for specific criteria. The harness extracts these from the canonical contract JSON via `deriveContractPassBarOverrides()` and applies them during verdict computation.

### Canonical JSON artifacts

Contracts and evaluations are written as both markdown (human-readable) and JSON (machine-validated):

- `contracts/contract-XX.json` — `CanonicalContract` with structured `doneMeans`, `verificationSteps`, `hardThresholds`, and optional `passBarOverrides`
- `evals/eval-XX-rYY.json` — `CanonicalEvaluation` with `confidence`, `evidenceQuality`, structured `scores`, `contractCriteria`, `projectPrinciples`, `bugs`, and `devSmoke`

The harness validates the structure of both on read via `readCanonicalContract()` and `readCanonicalEvaluation()`.

### Verdict and repair directive

After each evaluation, the harness writes:

- `verdicts/verdict-XX-rYY.json` — `HarnessVerdict` with `passed`, `reason`, `failingScores`, `passingScores`
- `repair-directives/repair-sXX-rYY.json` — `RepairDirective` with failing criteria + rubric descriptions, must-fix bugs, evidence paths, and remaining rounds

The generator receives the repair directive path rather than raw failing scores, giving it precise, structured repair guidance.

### Evaluation model

The evaluator scores two tiers:

- universal criteria: `conceptAlignment`, `completeness`, `craft`, `intentionality`
- project-specific criteria generated by the researcher in `plan/eval-criteria.json`

`resolvePass()` in `src/utils.ts` enforces pass bars for every required criterion, applying any `passBarOverrides` from the negotiated contract. The harness does **not** trust the evaluator's verdict — it independently checks all scores against thresholds. Missing scores are treated as a failure.

The evaluator also reports `confidence` (`low|medium|high`) and `evidenceQuality` (`weak|adequate|strong`), tracked in per-role metrics.

### Frozen evidence

After each evaluation, the harness copies the evaluator's evidence directory to `evals/evidence-frozen/sXX-rYY/` with a SHA256 manifest. Before the generator reads frozen evidence, the harness verifies the manifest — if any file was modified, the run throws. This prevents the generator from corrupting the evaluator's diagnostic artifacts.

### Generator session resume

On repair rounds (re-generation after a failed eval), the harness reuses the generator's SDK session via `generatorSessionIds[sprint]`. This sends the repair prompt into the existing session rather than starting fresh.

### Dev server lifecycle (`src/dev-server.ts`)

`DevServer` spawns the configured `smoke.start` command in a detached process group before evaluation. It watches stdout/stderr for a localhost URL (or a custom `startReadyPattern`). On stop, it sends SIGTERM to the process group (not just the child PID).

### Smoke test flow

When `smoke.start` is configured, the harness enforces a multi-layer smoke check:

1. **Dev server start** — if the server fails to start, a synthetic failure eval is written
2. **Dev-server HTTP smoke** — the harness GETs the server URL and checks for a 2xx/3xx response before the evaluator runs
3. **Smoke test command** — if `smoke.test` is configured, it runs before the evaluator
4. **Final regression** — after the entire backlog passes, the harness re-runs the dev smoke and smoke test to catch cross-feature regressions

If any smoke check fails, the evaluator is skipped entirely and a synthetic failure eval is recorded.

### Metrics (`metrics.json`)

The harness tracks per-role/provider performance in `metrics.json`:

- `tasksStarted` / `tasksFinished`
- `parseSuccesses` / `parseFailures`
- `contractApprovalAttempts` / `contractApprovalPasses`
- `repairRoundsToPass`
- `devSmokePassed` / `devSmokeFailed`
- `evaluatorConfidence` counts
- `evidenceQuality` counts
- `finalRegressionFailures`

When multiple providers are used, benchmark artifacts are frozen under `benchmarks/frozen/` for comparison.

### Prompt construction (`src/prompts.ts`)

Prompts are capability-aware:

- the researcher uses web tools when available, otherwise falls back to repo/local analysis
- the evaluator only assumes browser automation if the configured provider actually exposes it (via `TaskCapabilities.hasBrowserQa`)
- the generator receives a `RepairDirective` path on repair rounds rather than inline failing scores
- contract draft/review prompts include pass bar override instructions
- the evaluator prompt includes previous verdict feedback on repair rounds

### Key constraints

- Agents must return JSON-parseable output. Raw outputs are saved under `logs/` but the harness requires `extractJsonObject()` to succeed on every task result. Generators that return prose-only get a synthesized result.
- All `.ts` imports must use `.js` extensions (Node16 module resolution).
- The harness expects the provider to handle file creation for artifacts listed in `task.artifacts`. The harness only checks for their existence post-task.
- Canonical JSON artifacts (contract + eval) are validated on read. Invalid structures throw.

## Run artifact layout

All artifacts live under `<runRoot>/runs/<run-id>/`:

```
run.json                          # full run state, written after every transition
metrics.json                      # per-role/provider performance metrics
prompt.md                         # original user prompt
events.ndjson                     # append-only event log
progress.md / handoff/next.md     # cross-sprint context
plan/{research-brief,spec,project-principles}.md
plan/{eval-criteria,backlog}.json
contracts/contract-XX.md          # per-sprint contract (markdown)
contracts/contract-XX.json        # per-sprint contract (canonical JSON)
contracts/contract-XX-review-YY.md
evals/eval-XX-rYY.md             # per-round evaluation (markdown)
evals/eval-XX-rYY.json           # per-round evaluation (canonical JSON)
evals/evidence/sXX-rYY/          # live evaluator evidence
evals/evidence-frozen/sXX-rYY/   # frozen snapshot + SHA256 manifest
verdicts/verdict-XX-rYY.json     # harness-written pass/fail
repair-directives/repair-sXX-rYY.json  # structured repair guidance
benchmarks/frozen/manifest.json  # frozen benchmark artifacts (multi-provider)
logs/*.raw.txt / *.parsed.json   # per-task provider output
```

## Working rules for edits

Keep changes small and surgical. If you touch state transitions, verify resume behavior. If you touch provider behavior, make sure prompts still match actual provider capabilities. If you touch verdict/repair directive logic, run `node --test test/contract-pass-bars.test.mjs`. Prefer harness-enforced behavior over relying on the model to follow instructions in prose.
