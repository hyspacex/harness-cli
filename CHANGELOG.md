# Changelog

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
