# Harness Eval Cases

This directory contains lightweight meta-eval cases for comparing two complete harness runs.

Current commands:

```bash
npm run harness -- eval list
npm run harness -- eval packet .harness/runs/<run-id> --case examples-adaptive-dashboard-filtering --markdown
npm run harness -- eval compare --case examples-adaptive-dashboard-filtering --a <baseline-run-dir> --b <candidate-run-dir>
npm run harness -- eval compare --case examples-adaptive-dashboard-filtering --a <baseline-run-dir> --b <candidate-run-dir> --judge-provider claude-sdk
```

The first implementation compares existing run directories. The next layer should automate fixture copy/reset and baseline/candidate worktree execution.

Each case owns its locked judge rubric. Keep `prompt`, `objectiveChecks`, and `judgeRubric` unchanged when comparing a baseline harness run to a candidate run; the generated packets include an `evaluationSpecHash` so changed criteria are easy to detect.
