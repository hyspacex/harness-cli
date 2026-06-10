# Ceremony ROI Report

Built at: 2026-06-10T07:29:25.375Z
Run root: /tmp/model-compare2/combined
Runs analyzed: 22

Measures whether role separation and contract negotiation ceremony pays for itself per generator provider.
Verification gates are mandatory at every ceremony level and are not part of this trade-off.

## Findings

- claude-sdk: only 1 ceremony level(s) have run history — run the benchmark suite across the ladder to compare.
- codex: full ceremony vs minimal — first-round pass -33pt at +15.6 tasks/run; the extra ceremony is NOT buying a 10pt pass-rate edge — prefer minimal.

## Per Provider × Ceremony Level

| Provider | Ceremony | Runs | Completion | First-round pass | Avg repair rounds | Avg tasks/run | Negotiation approval | Final regression failures | Profiles |
|---|---|---|---|---|---|---|---|---|---|
| claude-sdk | minimal | 12 | 100% | 100% | 0.00 | 2.7 | n/a | 0 | min-fable, min-opus |
| codex | minimal | 8 | 100% | 100% | 0.00 | 2.4 | n/a | 0 | min-gpt55, min-gpt55-xhigh |
| codex | full | 2 | 100% | 67% | 0.33 | 18.0 | 75% | 0 | full-gpt55 |
