# Eval Release Gates

These gates turn the profile-comparison lessons into a concrete "good enough to ship" benchmark for harness changes.

## Plan

1. Isolate each profile run.
   - Matrix execution should give every case/profile pair its own workspace and run root.
   - The plan should record the isolation root so reviewers can spot accidental shared artifacts.

2. Require deterministic objective checks.
   - Case checks should be able to expect non-zero exits and required output, not only successful commands.
   - CLI cases should probe bad commands, bad subcommands, missing values, and malformed numeric values.

3. Treat matrix results as release evidence, not only logs.
   - Reports should include a "Good Enough To Ship" gate.
   - The gate should fail on incomplete runs, missing packets, failed required objective checks, failed judges, or shared workspaces/run dirs.
   - The gate should warn when checks or judged comparisons are missing.

4. Keep model judgment separate from objective checks.
   - Pairwise judges can rank subjective product quality and process quality.
   - Objective checks are the final arbiter for deterministic behavior.

## Good Enough To Ship Benchmark

A harness feature branch is good enough to ship when all of these are true:

- `npm run typecheck` passes.
- `npm run build:harness` passes.
- `node --test test/*.mjs` passes.
- A minimal relevant matrix run writes `matrix-result.json` and `matrix-result.md`.
- `matrix-result.json.shipGate.status` is `pass`, or `warning` only because the run intentionally omitted an LLM judge for cost/speed.
- Every required objective check in the packetized run passes.
- No selected profile shares a workspace or run directory with another selected profile.
- Any failed or partial run is explicitly visible in the matrix result.

## Minimal Verification Commands

Use the CLI case for a cheap backend/eval smoke:

```bash
npm run harness -- lab matrix \
  --case harness-cli-error-ergonomics \
  --profiles balanced \
  --execute false \
  --objective-checks true \
  --out /tmp/harness-cli-release-gate-smoke \
  --force true
```

For a real release signal, run at least two profiles and include objective checks:

```bash
npm run harness -- lab matrix \
  --case harness-cli-error-ergonomics \
  --profiles balanced,codex-only \
  --execute true \
  --continue-on-error true \
  --max-sprints 2 \
  --objective-checks true \
  --out /tmp/harness-cli-release-gate \
  --force true
```

Use `--judge-provider claude-sdk` or `--judge-provider codex` when the release decision depends on the pairwise winner instead of only mechanical health.

For adaptive profile verification, replace the profile list with `--profiles adaptive`. The matrix will expand the selector based on the case category and record the concrete profile list in `matrix-plan.json`.
