# Changelog

## Unreleased

### Added

- Added eval matrix release gates through `matrix-result.json.shipGate` and the "Good Enough To Ship Gate" section in `matrix-result.md`.
- Added objective-check expectations for expected exit codes and required stdout, stderr, or combined output substrings.
- Added stricter CLI error-ergonomics objective checks for invalid commands, missing flag values, and malformed numeric flags.
- Added per-profile matrix workspace and run-root isolation by default.
- Added release-gate documentation for the current "good enough to ship" benchmark.

### Fixed

- Fixed Claude pairwise judge output-format selection for matrix and meta-judge tasks.
- Fixed `--max-sprints`, `--max-repair-rounds`, and `--max-negotiation-rounds` to reject non-numeric, fractional, zero, and negative values instead of silently coercing them.
- Fixed unknown top-level commands so `harness <unknown>` exits non-zero with a clear error instead of falling through to help.
- Fixed packet redaction to also scrub GitHub, GitLab, Slack, and AWS access-key tokens before artifacts are written or embedded in judge prompts.
- Fixed the catchall redaction pattern so prose containing the words `token`, `password`, `authorization`, or `secret` is no longer mangled when followed by an unrelated word (e.g. "the bad token as points to help"). The pattern now requires a `:` or `=` separator and a structured value of 8+ chars.
