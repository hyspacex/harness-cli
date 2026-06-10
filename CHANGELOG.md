# Changelog

## [0.5.0] - 2026-06-10

### Added

- Added the ceremony ladder: `runtimeMode` now accepts `full | flat | minimal`, resolved into explicit dials (`ceremony.researcher`, `ceremony.planner`, `ceremony.negotiationRounds`) that can also be set individually in config or profiles. New built-in `flat` and `minimal` execution profiles cover the ladder alongside `full-harness`.
- Added harness-authored contracts: at `ceremony.negotiationRounds = 0` the harness deterministically writes the canonical sprint contract from the feature's acceptance criteria — no model calls, no `passBarOverrides` — so minimal-ceremony runs cannot weaken pass bars.
- Added evidence-based profile recommendation: `harness profiles --recommend "prompt"` and the matrix `adaptive` selector now aggregate run history (`src/core/history.ts`) and prefer the cheapest profile whose measured completion rate is within tolerance of the best, falling back to the keyword heuristic when history is thin.
- Added `harness eval roi`: a ceremony ROI report grouping run history by generator provider and ceremony level (completion rate, first-round pass rate, repair rounds, tasks/run, negotiation approval rate) with findings on whether ceremony pays for itself.
- Added the fixed benchmark suite (`lab/suites/ceremony-ladder-v1.json`, `harness lab matrix --suite`): 8 prompts across frontend, backend, and CLI — including three new greenfield `bench-*` cases on `lab/fixtures/greenfield` — run across the ceremony ladder, with suite results frozen under `lab/results/frozen/`.
- Added `--runtime-mode` CLI flag and a regression test proving minimal-ceremony runs still get independent verdicts, repair directives, and bootstrapped plan artifacts.
- Added `--blind-judge true` (redacts profile, provider, and model identifiers from pairwise judge prompts so judges cannot recognize which model produced a run) and `--judge-model <model>` (override the judge model, enabling non-participant judging in cross-model comparisons).
- Added deterministic behavior probes to the `bench-cli-task-tracker` and `bench-backend-notes-api` cases: prompts now pin the executable/server entry points, and objective checks invoke the real CLI and live HTTP endpoints so coverage gaps are caught by gates instead of judge taste.
- Added `bench-hard-ledger-undo`, a hard-tier discriminator case on a new `lab/fixtures/eventlog` fixture: an existing event-sourced codebase with two seeded bugs described only as symptoms (string-seq replay ordering, reducer resurrecting removed items), a compensating-event `undo` feature under an append-only invariant, golden-file v1 compatibility, and a designed ambiguity (consecutive-undo semantics) for judging judgment. Probes validated to fail on the shipped fixture and pass on a corrected reference implementation.

### Fixed (instruments)

- Fixed `resolveObjectiveWorkspace` to prefer the executed run's workspace over the case's `workspaceFixture` when building eval packets — previously `eval compare --objective-checks true` ran behavior probes against the pristine fixture template, reporting false failures for both runs in every judged pair.

### Fixed

- Fixed work categorization so prompts containing "build" are no longer classified as frontend (the old pattern matched the `ui` inside `build`).

### Changed

- Restructured the repo into two layers with a one-way dependency: `src/core/` (the product harness, including self-measurement: run history, profile recommendation, `eval roi`) and `src/lab/` (the model/provider characterization instrument: cases, packets, blinded judges, objective checks, matrix). `src/cli.ts` + `src/cli-flags.ts` stay at the root as the thin CLI layer. `test/boundary.test.mjs` enforces that core never imports lab.
- Moved the eval workbench CLI to a `harness lab` namespace: `harness lab <list|packet|compare|matrix>`. The old `harness eval <list|packet|compare|matrix>` forms remain as deprecated aliases that print a stderr notice; `harness eval roi` stays as product self-measurement.
- Moved lab assets: benchmark cases `evals/cases/bench-*.json` → `lab/cases/`, fixtures `evals/fixtures/{greenfield,eventlog}` → `lab/fixtures/`, benchmark suite `evals/benchmark-suite.json` → `lab/suites/ceremony-ladder-v1.json`, cross-model findings `docs/benchmark-findings-2026-06.md` → `lab/results/`, frozen comparison evidence `benchmarks/frozen/model-compare-2026-06-10/` → `lab/results/model-compare-2026-06-10/`. Suite freeze output now defaults to `lab/results/frozen/` instead of `benchmarks/frozen/` (per-run multi-provider freezing under each run's `benchmarks/frozen/` is unchanged). Product-facing example cases stay in `evals/cases/`; case discovery scans `lab/cases/` and `evals/cases/` with lab precedence on id collision.
- Reframed the README: the harness's premise is now "minimal ceremony, maximal verification, chosen by evidence" instead of bounded roles as a workaround for models losing the thread.

## [0.4.0] - 2026-05-09

### Added

- Added the adaptive agent workbench: named execution profiles (`balanced`, `claude-only`, `codex-only`, `visual-qa`, `codex-planner-builder`, `fast`, `safe-ci`, `full-harness`) that route harness roles to claude-sdk or codex, listed via `harness profiles`.
- Added `harness eval matrix` for running an eval case across one or more profiles in isolated workspaces and run roots, plus `harness eval matrix report --from <dir>` for regenerating packets and reports without rerunning agents.
- Added pairwise judge comparisons with locked judge rubrics and an `evaluationSpecHash`, so judges score against case-fixed criteria instead of run-generated criteria.
- Added eval matrix release gates through `matrix-result.json.shipGate` and the "Good Enough To Ship Gate" section in `matrix-result.md`.
- Added objective-check expectations for expected exit codes and required stdout, stderr, or combined output substrings.
- Added an `argv` form for objective checks that runs through `execFile` with no shell, alongside the existing `command` form.
- Added stricter CLI error-ergonomics objective checks for invalid commands, missing flag values, and malformed numeric flags.
- Added per-profile matrix workspace and run-root isolation by default.
- Added release-gate documentation for the current "good enough to ship" benchmark.

### Fixed

- Fixed Claude pairwise judge output-format selection for matrix and meta-judge tasks.
- Fixed `--max-sprints`, `--max-repair-rounds`, and `--max-negotiation-rounds` to reject non-numeric, fractional, zero, and negative values instead of silently coercing them.
- Fixed unknown top-level commands so `harness <unknown>` exits non-zero with a clear error instead of falling through to help.
- Fixed packet redaction to also scrub GitHub, GitLab, Slack, and AWS access-key tokens before artifacts are written or embedded in judge prompts.
- Fixed the catchall redaction pattern so prose containing the words `token`, `password`, `authorization`, or `secret` is no longer mangled when followed by an unrelated word. The pattern now requires a `:` or `=` separator and a structured value of 8+ chars.
- Fixed objective check `cwd` resolution to reject absolute paths and any relative path that escapes the workspace, so a case JSON cannot run commands in arbitrary directories.
- Fixed pairwise judge prompts to be scrubbed by `redactSensitiveText` before being sent to the model provider; previously redaction was only applied to the on-disk `judge-prompt.md` copy.

### Security

- Eval case files are trusted code: `objectiveChecks[].command` runs through a shell when the legacy `command` form is used. Only run `--objective-checks true` against eval cases you authored or have audited. Prefer the new `argv` form for new cases.
