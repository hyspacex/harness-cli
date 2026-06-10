# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A long-running harness CLI for app-development loops. The harness orchestrates up to four bounded agent roles — researcher, planner, generator, evaluator — in a sprint cycle. How many roles actually run is a measured dial, not a fixed pipeline: the **ceremony ladder** (`runtimeMode: full | flat | minimal`) collapses research/planning/negotiation for strong models while verification gates (independent verdicts, frozen evidence, smoke checks, final regression) stay mandatory at every rung. The harness owns all durable state, not the model session.

Routing is per-role: each role maps to a provider via `roleProviders`. A global `provider` sets the default; `roleProviders` only lists roles that differ.

The repo is split into two layers with a one-way dependency: `src/core/` (the product harness, including self-measurement: run history, profile recommendation, `eval roi`) and `src/lab/` (the model/provider characterization instrument: blinded pairwise judges, locked rubrics, behavior probes, benchmark suites). Lab imports core; core never imports lab. `src/cli.ts` + `src/cli-flags.ts` sit at the root as the thin CLI layer over both. See `ARCHITECTURE.md`.

## Commands

```bash
npm run build:harness    # Compile harness TypeScript to dist/
npm run build            # Build the app (vite build)
npm run harness -- init  # Write default harness.config.json
npm run harness -- run "Build a ..." [--provider claude-sdk|codex] [--runtime-mode full|flat|minimal] [--workspace path]
npm run harness -- resume <run-id>
npm run harness -- status [run-id]
npm run harness -- profiles [--recommend "prompt"]   # evidence-based profile recommendation
npm run harness -- eval roi  # ceremony ROI report from run history (product self-measurement)
npm run harness -- lab list  # list eval cases (lab/cases + evals/cases)
npm run harness -- lab packet <runDir> --case <id> [--objective-checks true]
npm run harness -- lab compare --case <id> --a <runDir> --b <runDir> [--blind-judge true] [--judge-provider claude-sdk|codex] [--judge-model m]
npm run harness -- lab matrix --suite [--execute true]  # fixed benchmark grid across the ceremony ladder
```

The old `harness eval <list|packet|compare|matrix>` subcommands are deprecated aliases for `harness lab <...>`; they still work but print a notice to stderr.

Tests: `node --test test/*.test.mjs`. Node.js >= 20. ESM-only (`"type": "module"` in package.json). The `npm run harness` script auto-runs `build:harness` before executing.

## Architecture

### State machine (`src/core/harness.ts`)

`HarnessRunner.execute()` drives the loop:

1. install configured skills into both `.claude/skills/` and `.agents/skills/`
2. for Codex runs, copy `CLAUDE.md` to `AGENTS.md` if `AGENTS.md` is missing
3. if `ceremony.researcher`, run the researcher when `plan/research-brief.md` or `plan/eval-criteria.json` are missing; otherwise bootstrap those artifacts deterministically (`flat-runtime.ts`)
4. if `ceremony.planner`, run the planner when `plan/spec.md`, `plan/backlog.json`, or `plan/project-principles.md` are missing; otherwise bootstrap them
5. for each pending feature: negotiate contract (or harness-author it when `ceremony.negotiationRounds` is 0), generate, evaluate, repair until pass or round cap
6. after the backlog completes, run a final regression sweep (dev smoke + smoke test)
7. persist `run.json` and `metrics.json` after every material state change so `resume` can continue safely

The harness keeps durable state under `<runRoot>/runs/<run-id>/`.

### Ceremony ladder (`src/core/ceremony.ts`)

`resolveCeremony()` turns `runtimeMode` + partial `ceremony` config into explicit dials: `researcher`, `planner`, `negotiationRounds`. `full` = all roles + negotiation; `flat` = bootstrapped plan artifacts, generator-drafted contract; `minimal` = bootstrapped artifacts + harness-authored contract (`src/core/contract-bootstrap.ts`, no model call, no `passBarOverrides`). `classifyCeremonyLevel()` maps dials back onto the ladder for reporting. Verification gates are not dials and run at every level.

### Run history & evidence (`src/core/history.ts`, `src/core/ceremony-roi.ts`)

`loadRunHistory()` aggregates `run.json`/metrics across `<runRoot>/runs/`. `recommendProfilesWithEvidence()` picks the cheapest profile (by measured avg tasks/run) whose completion rate is within tolerance (default 0.15) of the best, scoped to the prompt's category first, falling back to the keyword heuristic in `profiles.ts` when history is too thin (< 2 profiles with >= 2 runs). The matrix planner's `adaptive` selection and `harness profiles --recommend` both use it. `harness eval roi` renders per provider × ceremony level rows plus findings on whether negotiation/role ceremony pays for itself.

### Lab (`src/lab/`)

The characterization instrument: `cases.ts` (case discovery: `lab/cases/` + `evals/cases/`, lab wins on id collision), `packet.ts` (packetizes run artifacts via `src/core/artifacts/`, with redaction), `judge.ts` (blinded pairwise judging, locked rubrics, `evaluationSpecHash`), `objective-checks.ts` (deterministic behavior probes), `eval-matrix.ts` + `matrix/` (plan/execute/report). Lab assets: `lab/cases/` (`bench-*` cases), `lab/fixtures/` (`greenfield`, `eventlog`), `lab/suites/`, `lab/results/` (frozen evidence + findings docs). Product-facing example cases stay in `evals/cases/`.

### Benchmark suite (`lab/suites/ceremony-ladder-v1.json`)

Fixed grid: 8 cases (frontend / backend / CLI, including three greenfield `bench-*` cases on `lab/fixtures/greenfield`) × the ceremony ladder profiles (`full-harness`, `flat`, `minimal`). `harness lab matrix --suite` plans/executes it; suite results are additionally frozen under `lab/results/frozen/<suiteId>/<builtAt>/`.

### Provider registry (`src/core/providers/index.ts`)

The `ProviderRegistry` replaces the old single-provider pattern. It:

- builds a `RoleProviderMap` from `config.roleProviders`
- lazily creates `ProviderRuntime` instances (one per unique provider name)
- routes `runTask()` calls to the correct runtime based on `task.kind`
- exposes `getTaskCapabilities(role)` so prompts know what each role can do (browser QA, session resume, etc.)
- tags every task result with the provider that executed it

### Config layering (`src/core/config.ts`)

Config is resolved as `DEFAULT_CONFIG -> harness.config.json -> CLI flag overrides`, all merged via `deepMerge`. `normalizeRoleProviders()` fills in the full four-role map from `provider` + any partial `roleProviders` overrides. Paths (`workspace`, `runRoot`) are resolved relative to the config file's directory, not `cwd`.

### Providers (`src/core/providers/`)

Every provider implements `ProviderRuntime.runTask(task) -> { rawText, parsed, meta }`.

- `claude-sdk.ts` — uses `@anthropic-ai/claude-agent-sdk` `query()` and supports per-role `systemPrompt`, `mcpServers`, `settingSources`, `allowedTools`, and `resume`
- `codex.ts` + `codex-client.ts` — starts `codex app-server`, manages ChatGPT login auth, threads, approvals, and streamed turn output
- `pi.ts` — runs the `pi` CLI per task via `execFile` (no shell), with per-role command/output-mode config and redacted transport error prompts
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

`resolvePass()` in `src/core/utils.ts` enforces pass bars for every required criterion, applying any `passBarOverrides` from the negotiated contract. The harness does **not** trust the evaluator's verdict — it independently checks all scores against thresholds. Missing scores are treated as a failure.

The evaluator also reports `confidence` (`low|medium|high`) and `evidenceQuality` (`weak|adequate|strong`), tracked in per-role metrics.

### Frozen evidence

After each evaluation, the harness copies the evaluator's evidence directory to `evals/evidence-frozen/sXX-rYY/` with a SHA256 manifest. Before the generator reads frozen evidence, the harness verifies the manifest — if any file was modified, the run throws. This prevents the generator from corrupting the evaluator's diagnostic artifacts.

### Generator session resume

On repair rounds (re-generation after a failed eval), the harness reuses the generator's SDK session via `generatorSessionIds[sprint]`. This sends the repair prompt into the existing session rather than starting fresh.

### Dev server lifecycle (`src/core/dev-server.ts`)

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

When multiple providers are used, benchmark artifacts are frozen under the run's `benchmarks/frozen/` directory for comparison.

### Prompt construction (`src/core/prompts.ts`)

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

Keep changes small and surgical. If you touch state transitions, verify resume behavior. If you touch provider behavior, make sure prompts still match actual provider capabilities. If you touch verdict/repair directive logic or the ceremony ladder, run `node --test test/*.test.mjs`. Never make verification gates (verdicts, frozen evidence, smoke, final regression) conditional on ceremony level. Prefer harness-enforced behavior over relying on the model to follow instructions in prose. `src/core` must never import `src/lab` — lab depends on core, never the reverse; `test/boundary.test.mjs` enforces this, keep it green. Lab code reads completed runs through `src/core/artifacts/`, not runtime internals (`test/artifact-boundary.test.mjs`).
