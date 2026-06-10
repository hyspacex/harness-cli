# Adaptive Agent Workbench

The durable value of this project is not rigid scaffolding around today's model limitations. If models get dramatically better, many prompt handoffs, repair loops, and planning guardrails should shrink. The moat is the compounding system around the model:

- Eval cases with locked prompts, objective checks, and `judgeRubric` hashes that make before/after claims falsifiable.
- Run packets that preserve real artifacts, commands, metrics, and workspace evidence instead of relying on model self-report.
- Provider profiles that can route roles across Claude and Codex, or collapse to one model, without changing the eval target.
- Matrix runs that compare execution styles on the same task so the harness can learn which setup works for a category.
- Project-local configuration and fixtures that turn broad model capability into repeatable software delivery practice.

As models improve, the workbench should remove brittle ceremony and keep the parts that get stronger with better models: harder evals, richer traces, better routing, longer autonomous runs, and more reliable comparisons.

## Profiles

Profiles are named execution strategies. Built-ins include `fast`, `balanced`, `visual-qa`, `codex-planner-builder`, `claude-only`, `codex-only`, and `safe-ci`.

List them:

```bash
npm run harness -- profiles
```

Use one for a normal run:

```bash
npm run harness -- run "Build a small CRM dashboard" --profile balanced
```

Project profiles can be added under `profiles` in `harness.config.json`. Sparse profile overrides inherit the surrounding config, so a project can override only one role or budget.

## Eval Matrix

Matrix planning runs real eval cases through one or more profiles. It defaults to dry mode and writes a reproducible plan:

```bash
npm run harness -- eval matrix --case examples-adaptive-dashboard-filtering --profiles adaptive
```

Adaptive selection is evidence-first: when the run root holds enough history (at least two profiles with two or more finished runs, matching the case category first and any category second), it recommends the cheapest profile whose measured completion rate is within tolerance of the best, plus the best. Until that history exists it falls back to the category heuristic:

- frontend/UI/dashboard cases expand to `fast,visual-qa`
- CLI/backend/API cases expand to `fast,balanced`
- uncategorized cases expand to `fast,balanced`

The same recommendation is available directly:

```bash
npm run harness -- profiles --recommend "Build a small CRM dashboard"
```

Execute the plan when ready:

```bash
npm run harness -- eval matrix --case examples-adaptive-dashboard-filtering --profiles adaptive --execute true
```

Execution copies fixture workspaces by default, writes per-profile harness runs under the matrix output directory, emits eval packets, writes `matrix-result.md`, and creates locked-rubric pairwise comparison artifacts for packetized profile runs, including failed runs. Without `--judge-provider`, those comparisons are dry-mode prompts and inconclusive `judge-result.json` files ready for review. Add `--judge-provider claude-sdk` or `--judge-provider codex` to ask a model judge to score the profile pairs.

For release decisions, add `--objective-checks true` and inspect `matrix-result.json.shipGate`. A releasable run should be `pass`, or `warning` only when LLM judging was intentionally omitted and every required objective check passed.

Regenerate packets and reports from an existing matrix directory without rerunning agents:

```bash
npm run harness -- eval matrix report --from /tmp/harness-cli-live-matrix-fast
```

## Ceremony Ladder

`runtimeMode` is sugar for explicit ceremony dials (`ceremony.researcher`, `ceremony.planner`, `ceremony.negotiationRounds`):

- `full` — separate researcher and planner tasks; generator/evaluator negotiate the contract.
- `flat` — research and plan artifacts are bootstrapped deterministically; the generator drafts the contract with one evaluator review.
- `minimal` — bootstrapped artifacts plus a harness-authored contract with zero negotiation and no pass-bar overrides.

Verification gates — independent verdicts, frozen evidence manifests, dev-smoke gates, and the final regression sweep — run at every rung and are deliberately not configurable. Ceremony is the negotiable part; verification is the product.

## Benchmark Suite and Ceremony ROI

`evals/benchmark-suite.json` fixes 8 app prompts (frontend, backend, CLI) against the three ladder rungs so ceremony cost can be measured instead of assumed:

```bash
npm run harness -- eval matrix --suite                # dry-run plan (24 runs)
npm run harness -- eval matrix --suite --execute true # execute and freeze under benchmarks/frozen/
npm run harness -- eval roi                           # ceremony ROI report from accumulated run history
```

The ROI report groups run history by generator provider × ceremony level and reports completion rate, first-round pass rate, average repair rounds, average tasks per run (cost proxy), and negotiation approval rate — then states, per provider, whether the extra ceremony is buying enough pass-rate to justify its cost. Kill the rungs the data says are dead.
