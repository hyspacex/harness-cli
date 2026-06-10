# Harness Eval Cases

This directory contains lightweight meta-eval cases for comparing two complete harness runs. Use them when changing harness behavior and you need a stable signal on whether the candidate run is better or worse than a baseline run. Benchmark `bench-*` cases live in `lab/cases/`; case discovery scans both directories (lab wins on id collision). See [lab/README.md](../lab/README.md) for the characterization instrument.

## Commands

```bash
npm run harness -- lab list
npm run harness -- lab packet .harness/runs/<run-id> --case examples-adaptive-dashboard-filtering --markdown
npm run harness -- lab packet .harness/runs/<run-id> --case examples-adaptive-dashboard-filtering --objective-checks true
npm run harness -- lab compare --case examples-adaptive-dashboard-filtering --a <baseline-run-dir> --b <candidate-run-dir>
npm run harness -- lab compare --case examples-adaptive-dashboard-filtering --a <baseline-run-dir> --b <candidate-run-dir> --judge-provider claude-sdk --objective-checks true
```

(The old `harness eval <list|packet|compare|matrix>` forms are deprecated aliases for `harness lab <...>`.)

`compare` writes `packet-a.json`, `packet-a.md`, `packet-b.json`, `packet-b.md`, `judge-prompt.md`, and `judge-result.json`. If `--judge-provider` is omitted, it runs in dry mode and prepares the prompt/artifacts without calling an LLM judge.

## Case Contract

Each case owns the fixed evaluation spec for one prompt:

- `prompt`: the user request given to the harness.
- `workspaceFixture`: the fixture or repo root to copy/use for the run.
- `harnessConfig`: suggested run overrides for this case.
- `objectiveChecks`: deterministic commands to run while building packets.
- `judgeRubric`: the locked scoring rubric for pairwise judging.
- `judgeFocus`: short reminders for the judge; these do not replace the rubric.

Do not change `prompt`, `objectiveChecks`, or `judgeRubric` when comparing a baseline run to a candidate run. Packets include an `evaluationSpecHash` derived from those fields. A changed hash means the result is a different eval, not an apples-to-apples comparison.

Harness-generated research criteria, sprint contracts, and pass bars are included in packets as artifacts, but they are not the meta-eval rubric. The judge prompt explicitly tells the judge to score only against the case-level `judgeRubric`.

Objective checks can assert expected failures as well as successful commands:

```json
{
  "id": "unknown-eval-subcommand",
  "command": "node ./dist/cli.js eval frobnicate",
  "expectedExitCode": 1,
  "outputIncludes": ["frobnicate"],
  "timeoutMs": 5000
}
```

Supported expectation fields are `expectedExitCode`, `stdoutIncludes`, `stderrIncludes`, and `outputIncludes`. Required objective-check failures cause the matrix "Good Enough To Ship" gate to fail.

## Adding A Case

Start from an existing JSON file in `evals/cases/`. Keep cases small enough to run repeatedly, with a prompt that can complete in a bounded sprint count.

Good cases usually have:

- one clear user-facing outcome
- one or two important regression risks
- objective checks that are baseline-clean or intentionally scoped
- a rubric with stable dimensions and critical requirements
- enough expected evidence to distinguish a lucky implementation from a good harness process

Avoid cases where the desired behavior depends on current news, live third-party services, or a broad product redesign. Those make provider drift and environmental noise dominate the result.

## Interpreting Results

Treat pairwise `winner` as the primary signal. Dimension scores are supporting evidence, not a leaderboard. If objective checks fail because the fixture is already broken, either fix the fixture baseline or scope the check so it measures the case behavior directly.

Useful follow-up checks:

- Verify both packets have the same `evaluationSpecHash`.
- Inspect failed objective-check output before trusting judge rationale.
- Re-run with A/B order swapped if the result is close or low confidence.
- Treat `inconclusive`, low confidence, or order-flipped results as “needs another run,” not as a win.

The current implementation compares existing run directories. Future work can automate fixture copy/reset, baseline/candidate worktree execution, repeated runs, swapped judge prompts, and aggregate reports.

Matrix runs also write a `shipGate` block to `matrix-result.json` and a "Good Enough To Ship Gate" section to `matrix-result.md`. The gate fails on incomplete runs, missing packets, required objective-check failures, judge errors, or shared profile workspaces/run directories. It warns when objective checks or LLM judging were intentionally omitted.
