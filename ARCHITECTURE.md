# Architecture

One repo, two layers, one-way dependency.

## Core — the product

`src/core/` is the verification-first orchestration harness for long-running agent builds: state machine (`harness.ts`), ceremony ladder (`ceremony.ts`, `contract-bootstrap.ts`, `flat-runtime.ts`), config layering (`config.ts`, `profiles.ts`), providers (`providers/`), prompts, dev-server lifecycle, and the run-artifact reader (`artifacts/`).

Core includes its own self-measurement: run history aggregation (`history.ts`), evidence-based profile recommendation, and the ceremony ROI report (`ceremony-roi.ts`, `harness eval roi`). That is the product's feedback loop — "minimal ceremony, maximal verification, chosen by evidence" — not benchmarking.

## Lab — the instrument

`src/lab/` is the model/provider characterization rig: fixed eval cases (`cases.ts`), packetized run evidence (`packet.ts`), blinded pairwise judging with locked rubrics and an `evaluationSpecHash` (`judge.ts`), deterministic behavior probes (`objective-checks.ts`), and matrix/suite execution (`eval-matrix.ts`, `matrix/`). The lab uses Core as its test rig; Core never depends on it.

`src/cli.ts` + `src/cli-flags.ts` are a thin CLI layer at the root that imports both. Lab commands live under the `harness lab` namespace (`list | packet | compare | matrix`); the old `harness eval <list|packet|compare|matrix>` forms are deprecated aliases.

## Assets

| Path | Layer | What |
|---|---|---|
| `src/core/` | core | harness runtime + self-measurement |
| `src/lab/` | lab | characterization instrument |
| `lab/cases/` | lab | benchmark cases (`bench-*`), including the hard-tier discriminator |
| `lab/fixtures/` | lab | workspace fixtures (`greenfield`, `eventlog`) |
| `lab/suites/` | lab | fixed benchmark suites (`ceremony-ladder-v1.json`) |
| `lab/results/` | lab | frozen suite results and cross-model findings (e.g. `benchmark-findings-2026-06.md`) |
| `evals/cases/` | product-facing | example meta-eval cases for harness changes |

Case discovery scans `lab/cases/` and `evals/cases/` (lab wins on id collision).

## The one-way dependency rule

`src/core` never imports `src/lab`; lab imports core. `test/boundary.test.mjs` enforces this by scanning every import specifier in both trees and fails on any `core -> lab` edge. Keep it green.

The run-artifact format is the API between the layers. Lab code reads completed runs through `src/core/artifacts/` (`readRunArtifactBundle`), never through runtime internals — `test/artifact-boundary.test.mjs` asserts the packet builder and matrix report touch artifacts, not `RunState` or `harness.ts`.

Verification gates — independent verdicts, frozen evidence, smoke checks, final regression — are never dials, in either layer, at any ceremony rung.

## The flywheel

Lab evidence informs profile defaults → core runs real work → run history feeds `eval roi` and `profiles --recommend` → new questions become new lab cases.

## When to split into packages

Stay one repo until at least one of these is real:

- an external consumer wants core without the lab
- the lab needs its own release cadence
- cross-version evaluation (lab at version N judging core at version N-1)

Until then, the directory boundary plus the boundary test is the cheaper enforcement.
