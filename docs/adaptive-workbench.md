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

For frontend cases, `adaptive` currently expands to a quick scout pass plus a visual-QA profile. Execute the plan when ready:

```bash
npm run harness -- eval matrix --case examples-adaptive-dashboard-filtering --profiles adaptive --execute true
```

Execution copies fixture workspaces by default, writes per-profile harness runs under the matrix output directory, emits eval packets, and creates locked-rubric pairwise comparison artifacts for successful profile runs. Without `--judge-provider`, those comparisons are dry-mode prompts and inconclusive `judge-result.json` files ready for review. Add `--judge-provider claude-sdk` or `--judge-provider codex` to ask a model judge to score the profile pairs.
