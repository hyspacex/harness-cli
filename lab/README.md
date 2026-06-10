# The Lab

The lab is the model/provider characterization instrument: fixed eval cases with locked prompts and rubrics, blinded pairwise judging, deterministic behavior probes, and fixed benchmark suites. It answers questions like "which model, with how much harness ceremony, ships this kind of app" — with frozen evidence instead of vibes.

The lab uses the core harness as its test rig; core never depends on the lab (`test/boundary.test.mjs` enforces the direction). If you only want to build apps with the harness, you don't need anything in this directory — see the top-level [README](../README.md).

**Audience:** anyone characterizing models/providers — comparing a new model release, validating a routing decision, or checking whether a harness change made runs better or worse.

## Commands

```bash
# List eval cases (scans lab/cases/ and evals/cases/; lab wins on id collision)
npm run harness -- lab list [--cases dir]

# Packetize a completed run's artifacts for judging
npm run harness -- lab packet .harness/runs/<run-id> --case <id|path> [--out packet.json] [--markdown] [--objective-checks true]

# Pairwise comparison of two runs on one case
npm run harness -- lab compare --case <id|path> --a <runDir> --b <runDir> \
  [--judge-provider claude-sdk|codex] [--judge-model <model>] [--blind-judge true] [--objective-checks true]

# Run a case across execution profiles in isolated workspaces
npm run harness -- lab matrix --case <id|path|all> --profiles adaptive|name,name [--execute true] [--judge-provider claude-sdk|codex]

# Run the fixed benchmark suite (cases x ceremony-ladder profiles)
npm run harness -- lab matrix --suite [lab/suites/ceremony-ladder-v1.json] [--execute true]

# Rebuild packets/reports/comparisons from an existing matrix directory
npm run harness -- lab matrix report --from <matrixOutDir>
```

Key flags:

- `--objective-checks true` — run the case's deterministic behavior probes (real CLI invocations, live HTTP endpoints) while building packets. Probe results are facts the judge cannot argue with.
- `--blind-judge true` — redact profile/provider/model identifiers from judge prompts so the judge cannot recognize which model produced a run.
- `--judge-model <model>` — override the judge's model; use a non-participant model so no model judges a pair it competed in.
- Without `--judge-provider`, `compare` and matrix comparisons run in dry mode: the judge prompt is prepared but no LLM is called.

The old `harness eval <list|packet|compare|matrix>` forms still work as deprecated aliases that print a notice to stderr.

## Layout

```
lab/
├── cases/      # benchmark cases (bench-*): locked prompt, judgeRubric, objectiveChecks
├── fixtures/   # workspace fixtures: greenfield (empty scaffold), eventlog (seeded-bug hard case)
├── suites/     # fixed benchmark grids (ceremony-ladder-v1.json: 8 cases x 3 ladder rungs)
└── results/    # frozen evidence: suite results (results/frozen/), cross-model findings
```

Product-facing example cases live in `evals/cases/`; case discovery scans both directories. Suite executions are additionally frozen under `lab/results/frozen/<suiteId>/<builtAt>/`.

## Methodology lessons

Distilled from the June 2026 cross-model benchmark ([benchmark-findings-2026-06.md](results/benchmark-findings-2026-06.md), frozen evidence in [results/model-compare-2026-06-10/](results/model-compare-2026-06-10/)):

- **Judge blinded and non-participant.** Self-judging inflates: with one model as its own judge, it ranked itself ahead; blinded neutral judges flipped the result. `--blind-judge` and `--judge-model` exist because of this.
- **Validate probes in both directions before trusting them.** A probe must pass on a corrected reference implementation and fail on the shipped (buggy) fixture. A probe that has never been seen failing proves nothing.
- **Once tasks saturate, judges discriminate on evidence legibility, not correctness.** At ≤1-hour task scale all frontier models produced working code; pairwise verdicts tracked test coverage and evidence quality. Deterministic behavior probes are the floor that keeps verdicts from becoming taste-based.
- **Read judge rationales against directly observed facts.** An instrument bug (`resolveObjectiveWorkspace` running probes against the pristine fixture instead of the executed run's workspace) fed judges symmetric false failures — caught because a judge rationale contradicted probe results we had observed directly. Fixed with a regression test.
- **Don't buy ceremony to fix a model trait.** Where a model under-verifies, harness-enforced gates (probes, contract verification requirements) fixed it at a fraction of the cost of full ceremony.

## Adding cases

Start from an existing JSON in `lab/cases/` or `evals/cases/`. Keep the prompt, `objectiveChecks`, and `judgeRubric` frozen between compared runs — packets embed an `evaluationSpecHash` over those fields, and a changed hash means a different eval, not an apples-to-apples comparison. See [evals/README.md](../evals/README.md) for the full case contract and [docs/harness-evals.md](../docs/harness-evals.md) for packet/judging internals.
