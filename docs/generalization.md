# Generalizing beyond frontend apps

The orchestration engine is already mostly domain-agnostic:

- the sprint loop in `src/harness.ts`
- durable run state and resume support
- role-routed provider registry (`claude-sdk`, `codex`)
- researcher-generated evaluation criteria in `plan/eval-criteria.json`
- data-driven pass/fail enforcement in `resolvePass()`
- canonical contract and evaluation JSON artifacts alongside markdown

That means the harness is no longer locked to a single hardcoded UI rubric. A researcher can define project-specific criteria for a CLI, API, library, or workflow tool, and the harness will enforce those criteria the same way it enforces the universal ones.

It also no longer assumes one model should own the whole loop. Routing is per role:

- `researcher`
- `planner`
- `generator`
- `evaluator`

That makes it practical to keep planner/generator together while splitting evaluator early, or to compare role/provider pairs empirically instead of by intuition.

If you already set a global `provider`, `roleProviders` can stay sparse and only list the roles that differ. For example, a Claude-first setup can route only `planner` and `generator` to Codex without repeating `researcher` and `evaluator`.

## What is still frontend-skewed

Two things still tilt the defaults toward web apps:

### 1. Browser QA defaults

The default Claude evaluator configuration attaches Playwright MCP. That is great for browser apps, but not every project needs it.

The code now treats browser automation as optional:

- Claude uses browser QA only if the evaluator role actually has Playwright configured.
- Codex uses browser QA only if you explicitly declare that your Codex environment provides it via `codex.assumePlaywrightMcp`.
- Otherwise the evaluator is told to fall back to smoke tests, CLI checks, HTTP checks, and code review.

### 2. Default smoke lifecycle examples

The sample configs still look like app/server workflows because they include `npm run dev` and `npm test`. For non-web projects, those should be replaced with whatever your project needs:

- CLI tool: no dev server, smoke test is command invocation
- API service: dev server plus HTTP checks
- library: no dev server, smoke test is test runner + typecheck
- data pipeline: no dev server, smoke test is fixture execution

When a dev server exists, the harness now treats that as a truth boundary:

- starting the dev server is not enough
- the harness performs a mandatory dev-server smoke HTTP check before evaluator execution
- the run also performs a final regression smoke sweep after the backlog is complete

## What to change for a new project type

You usually only need to adjust configuration and prompt expectations:

1. Set `smoke.install`, `smoke.start`, `smoke.test`, and `smoke.stop` for the project’s real lifecycle.
2. Decide whether `roleProviders` should stay uniform or split by role.
3. Give the researcher enough context in the user prompt so it can produce useful project-specific criteria.
4. Configure provider tooling to match reality. Don’t tell the evaluator it has browser tooling unless it really does.
5. Add any project-specific skills under `skills` so they are installed into both Claude and Codex skill directories.

## Truth artifacts

The harness now keeps more of the evaluation surface in structured, durable artifacts:

- contracts are written as both `contracts/contract-XX.md` and `contracts/contract-XX.json`
- evals are written as both `evals/eval-XX-rYY.md` and `evals/eval-XX-rYY.json`
- evaluator evidence is frozen under `evals/evidence-frozen/` before the generator reads it
- mixed-provider runs freeze benchmark snapshots under `benchmarks/frozen/`

That matters for non-frontend work too. For a CLI or API project, "truth" may be logs, HTTP responses, fixture outputs, or schema diffs instead of screenshots, but the harness now treats those as benchmark artifacts rather than soft notes in model prose.

## Measuring routing quality

The harness now emits `metrics.json` with per-role/provider slices for:

- parse success
- contract approval attempts and passes
- repair rounds to pass
- final regression failures
- dev-smoke success
- evaluator confidence
- evidence quality

That gives you the basic feedback loop needed to choose routing empirically. A role split should only persist if the recorded outcomes improve.

## Good next improvements

If this repo needs to become truly profile-driven, the next useful layer would be explicit project profiles such as `webapp`, `api`, `cli`, and `library`. Those profiles could bundle:

- recommended smoke commands
- preferred evaluator tooling
- default research hints
- optional skill packs

But the important part is already done: pass/fail logic is criteria-driven instead of hardcoded to a visual-web rubric.
