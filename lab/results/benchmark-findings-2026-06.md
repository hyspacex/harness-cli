# Cross-Model Benchmark Findings — June 2026

Models: Claude Opus 4.8, Claude Fable 5, GPT-5.5 (Codex, effort `high` unless noted).
Raw evidence: `lab/results/model-compare-2026-06-10/` (deterministic aggregate,
28 blinded judge results, matrix results, ceremony ROI report).

## Setup

- 18 repeat runs: 3 models × 2 categories (`bench-cli-task-tracker`, `bench-backend-notes-api`) × 3 seeds, minimal ceremony, isolated matrix workspaces.
- 4 GPT-5.5 variants: `xhigh` effort and full ceremony, both categories.
- 3 hard-case runs: `bench-hard-ledger-undo` (existing codebase, two seeded bugs given as symptoms, append-only undo feature, designed ambiguity).
- All judging blinded (`--blind-judge`) and non-participant (`--judge-model`): no model judged a pair it competed in. Behavior probes validated against reference implementations in both directions.

## Findings

1. **All three models produce working code at this task scale.** Every behavior probe passed in every workspace (21 runs), including the hard case: all three models root-caused both seeded bugs at the mechanism level and built a working append-only undo, first round.
2. **GPT-5.5 systematically under-verifies.** Backend test coverage 2–3 tests across six independent runs vs 9–12 (Fable) and 11–12 (Opus); judges scored its evidence "claim-based" in every pairwise loss (0–14 across both rounds and the hard case, unanimous, two different neutral judges). More thinking budget (`xhigh`) did not change this; full ceremony tripled coverage at 9× task cost. The economical fix is harness-enforced verification (probes, contract verification requirements), not ceremony.
3. **Fable 5 vs Opus 4.8 is a statistical tie at ≤1-hour task scale.** 13 corrected blinded judgments (repeat grid + hard case): Opus 7, Fable 6, 1 tie; the two neutral judges lean opposite ways; hard-case confidences were 3 and 1. Both scored 5/5 on root-cause analysis from both judges. Real but small differences: Fable produced the most idiomatic event-sourcing design (self-contained compensating events capturing pre-state at undo time); Opus produced slightly more tests and evidence; GPT-5.5 was consistently ~1.5–2× faster.
4. **Benchmark "generational leads" do not manifest as outcome differences on small, well-specified tasks.** Saturation, not measurement error: two judges with corrected evidence still split. Where a gap could show: multi-hour multi-feature work, ambiguous product requirements, large legacy codebases — none of which fit in a ≤1-hour bench case.
5. **Reliability is a provider-transport property, not a model property.** Claude SDK transient process exits hit 7/12 grid runs (elevated under concurrency); Codex had zero transport failures but one quota exhaustion. All 12 crash/quota recoveries via `harness resume` succeeded with zero lost runs.

## Instrument lessons (encoded in the codebase)

- Self-judging inflates: Fable-as-judge had itself ahead of Opus; blinded neutral judges flipped it. `--blind-judge` + `--judge-model` now exist for this.
- Judges discriminate on evidence legibility once tasks saturate; deterministic behavior probes (now in all bench cases) are the floor that prevents taste-based verdicts.
- `resolveObjectiveWorkspace` previously ran probes against the pristine fixture in `eval compare`, feeding judges symmetric false failures — caught by reading a judge rationale that contradicted directly-observed probe results. Fixed with regression test.
- Validate probes both directions before trusting them: pass on a corrected reference implementation, fail on the shipped fixture.

## Routing guidance (n=3, two categories — defaults, not doctrine)

- Verification-critical work → either Claude model; choose on price/latency.
- Cost/speed-sensitive work → GPT-5.5 with harness-enforced coverage gates.
- Don't buy ceremony to fix a model trait; encode the requirement in the contract and probes.
