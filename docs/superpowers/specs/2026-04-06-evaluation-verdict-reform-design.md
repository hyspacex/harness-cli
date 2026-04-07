# Evaluation Verdict Reform

Holistic redesign of the harness's evaluation feedback loop. Four changes that fix the root cause of wasted repair rounds: the evaluator, harness, and generator disagree about what "passing" means and the repair loop has poor information flow.

## Problem Statement

In a test run (Seattle transit map), the generator exhausted all 3 repair rounds doing cosmetic fixes while `aiIntegrationDepth` scored 2/4. Root causes:

1. The evaluator writes `status: "pass"` but scores a criterion 2/4. The harness overrides via `resolvePass()` but nobody tells the generator why.
2. Eval criteria pass bars are set by the researcher and immutable — contract negotiation can't adjust them even when a sprint's scope doesn't cover a criterion.
3. The generator's only repair input is the evaluator's prose report, which says "pass." No structured signal about what specifically the harness rejected.
4. The evaluator is never told its verdict was overridden, so it keeps producing contradictory output.

## Change A: Harness-Computed Verdict (Remove `status` from Evaluator)

### Rationale

The evaluator currently serves two roles: evidence gatherer and judge. But the harness doesn't trust the judge — it recomputes the verdict from scores. This dual authority creates contradictory signals. Split the roles: evaluator gathers evidence and scores, harness computes the verdict.

### Design

**Remove from `CanonicalEvaluation` type** (`src/types.ts:339`):
- Delete the `status: 'pass' | 'fail'` field entirely.

**Add `HarnessVerdict` type** (`src/types.ts`):
```typescript
export interface HarnessVerdict {
  version: 1;
  sprint: number;
  evaluationRound: number;
  featureId: string;
  passed: boolean;
  /** Why the harness decided pass or fail. */
  reason: 'all_scores_met' | 'score_below_threshold' | 'missing_scores' | 'smoke_failure';
  failingScores: { criterion: string; score: number; passBar: number }[];
  passingScores: { criterion: string; score: number; passBar: number }[];
  evaluationJsonPath: string;
  /** Written to: {runDir}/verdicts/verdict-{sprint}-r{round}.json */
}
```

**Write verdict after every evaluation** (`src/harness.ts`, after evaluator task completes):
- Call `resolvePass()` as before.
- Build a `HarnessVerdict` from the result.
- Write to `{runDir}/verdicts/verdict-{sprint}-r{round}.json`.
- Store path in `runState.currentVerdictPath`.

**Update `resolvePass()`** (`src/utils.ts`):
- Remove the `status` field fast-fail check (lines 220-222). The evaluator no longer writes status.
- Keep the score-threshold logic unchanged.
- The no-criteria fallback (lines 244-247) should return false since there's no status to check. In practice this path shouldn't be hit because eval criteria are always present after the research phase.

**Update evaluator prompt** (`src/prompts.ts`):
- Remove `status` from the canonical JSON example.
- Remove the `## Verdict` section from the report format.
- Replace with: "Score each criterion honestly. Do NOT write a pass/fail verdict — the harness computes the verdict from your scores."
- Remove the "IMPORTANT: If ANY score is below its pass bar, status MUST be fail" note (added in the earlier patch) — it's no longer needed since the field is gone.

**Update `readCanonicalEvaluation()`** (`src/harness.ts`):
- Remove status field validation (line 1435).

**Update `writeSyntheticSmokeFailureEval()`** (`src/harness.ts`):
- Remove `status: 'fail'` from the synthetic evaluation object.
- The harness verdict will mark it as failed via `reason: 'smoke_failure'`.

**Update `buildCanonicalEvaluationExample()`** (`src/prompts.ts`):
- Remove `status` from the example object.

**Update `buildEvaluatorJsonExample()`** (`src/prompts.ts`):
- Remove `status` from the quick-reference example.

**Contract review is unaffected**: The contract review prompt uses its own `status: 'approved' | 'revise'` field which is separate from the evaluation status. No changes needed there.

### RunState addition

Add to `RunState` (`src/types.ts`):
```typescript
currentVerdictPath: string | null;
```

Initialize to `null` in `initRunState()`. Set after each verdict write.

## Change B: Negotiable Pass Bars

### Rationale

The researcher sets pass bars for the entire run. But individual sprints may not cover all criteria — e.g., sprint 1 builds the base map without AI integration, but `aiIntegrationDepth` still has passBar 4. The contract negotiation should be able to scope pass bars per-sprint.

### Design

**Add to `NegotiationState`** (`src/types.ts`):
```typescript
export interface NegotiationState {
  featureId: string;
  sprint: number;
  rounds: NegotiationRound[];
  finalContractPath: string | null;
  status: 'drafting' | 'reviewing' | 'approved' | 'exhausted';
  /** Pass bar overrides negotiated for this sprint. Keyed by criterion id. */
  passBarOverrides: Record<string, number>;
}
```

Initialize `passBarOverrides` to `{}` when creating negotiation state.

**Add to `CanonicalContract`** (`src/types.ts`):
```typescript
export interface CanonicalContract {
  // ... existing fields ...
  /** Pass bar overrides negotiated for this sprint. */
  passBarOverrides?: Record<string, number>;
}
```

**Update contract draft prompt** (`src/prompts.ts`, `buildGeneratorDraftContractPrompt()`):
- Add instruction: "If this sprint's scope does not fully cover a scored criterion (e.g., AI integration is deferred to a later sprint), include a `passBarOverrides` section in the contract JSON with adjusted pass bars. Only lower bars for criteria genuinely out of scope — do not lower bars to make the sprint easier."

**Update contract review prompt** (`src/prompts.ts`, `buildEvaluatorReviewContractPrompt()`):
- Add instruction: "If the contract includes `passBarOverrides`, verify each override is justified by the sprint's scope. Reject overrides that lower bars for in-scope work. Approve overrides for criteria that are genuinely deferred."

**Parse overrides from approved contract** (`src/harness.ts`, `negotiateContract()`):
- After contract is approved (or exhausted), read the canonical contract JSON.
- Extract `passBarOverrides` and store in `negotiation.passBarOverrides`.
- Persist via `saveRunState()`.

**Apply overrides in `resolvePass()`** (`src/utils.ts`):
- Add optional parameter: `passBarOverrides?: Record<string, number>`.
- When checking each criterion's pass bar, use `overrides[key] ?? config.passBar`.

**Thread overrides through the evaluation loop** (`src/harness.ts`):
- Where `resolvePass(evalResult.parsed, evalCriteria)` is called, also pass `runState.currentNegotiation?.passBarOverrides ?? {}`.
- Same for `loadSprintProgress()`.

**Thread overrides into `getFailingScores()`** (`src/utils.ts`):
- Add same optional parameter so failing scores reflect the effective (possibly overridden) pass bar.

**Constraint**: Overrides can only lower pass bars, not raise them. Enforce in `resolvePass()` when applying overrides: `const effectiveBar = Math.min(overrides[key] ?? config.passBar, config.passBar)`. This prevents the generator from gaming the system by raising bars for criteria it excels at.

## Change C: Structured Repair Directive

### Rationale

When the harness verdict is "fail," the generator currently reads the evaluator's prose report (which may say "pass") plus a prepended note listing failing scores. This is bolted-on context, not a structured contract. The repair directive should be as structured as the sprint contract.

### Design

**New type** (`src/types.ts`):
```typescript
export interface RepairDirective {
  version: 1;
  sprint: number;
  evaluationRound: number;
  featureId: string;
  /** The harness verdict that triggered this repair. */
  verdictPath: string;
  /** Criteria that must improve for the sprint to pass. Ordered by gap size (largest first). */
  failingCriteria: {
    criterion: string;
    currentScore: number;
    effectivePassBar: number;
    /** Rubric description of the score level needed to pass. */
    targetLevelDescription: string;
    /** Rubric description of the current score level. */
    currentLevelDescription: string;
  }[];
  /** Criteria already meeting their pass bar — do not regress these. */
  passingCriteria: {
    criterion: string;
    currentScore: number;
    effectivePassBar: number;
  }[];
  /** High/critical severity bugs from the evaluator that must be fixed. */
  mustFixBugs: {
    severity: string;
    title: string;
    rootCause: string;
    evidence: string[];
  }[];
  /** Full eval and evidence paths for reference. */
  evaluationPath: string;
  evaluationJsonPath: string;
  evidenceDir: string | null;
  /** How many repair rounds remain after this one. */
  remainingRounds: number;
}
```

**Build the directive** (`src/harness.ts`):
- New method `buildRepairDirective()` that:
  1. Reads the harness verdict to get failing/passing scores.
  2. Reads the canonical evaluation to get bugs and evidence.
  3. Looks up rubric descriptions for current and target score levels from `evalCriteria`.
  4. Returns a `RepairDirective`.

**Write the directive** (`src/harness.ts`, in the repair loop):
- After `resolvePass()` returns false and before calling `runGenerator()`.
- Write to `{runDir}/repair-directives/repair-s{sprint}-r{round}.json`.

**Update `buildGeneratorPrompt()`** (`src/prompts.ts`):
- Replace the `failingScores` parameter (added in the earlier patch) with `repairDirectivePath: string | null`.
- Replace the `failingScoresNote` block with: "Read the repair directive at `{path}`. It lists every criterion that must improve, with rubric descriptions of your current level and the target level. Focus on the largest gaps first. Do not regress passing criteria."
- Remove the inline computation — the directive file has everything.

**Update `runGenerator()`** (`src/harness.ts`):
- Replace `failingScores` parameter with `repairDirectivePath`.
- Pass through to `buildGeneratorPrompt()`.

**Revert earlier patch**: The `failingScores` parameter added to `buildGeneratorPrompt` and the `getFailingScores()` call site in the repair loop are superseded by this change. `getFailingScores()` itself remains — it's used internally to build the verdict and directive.

## Change D: Evaluator Feedback Loop

### Rationale

When the evaluator's scores produce a harness-computed fail, the evaluator doesn't know. In the next round, it has no context about what the harness rejected. This leads to repeated contradictory scoring.

### Design

**Update `buildEvaluatorPrompt()`** (`src/prompts.ts`):
- Add optional parameter: `previousVerdictPath: string | null`.
- When non-null, prepend a section:

```
## Previous Harness Verdict
The harness computed a FAIL verdict for the previous evaluation round.
Read the full verdict at: {previousVerdictPath}

Key points:
- The harness checks every score against its pass bar independently.
- Your previous round's scores resulted in failure on: {list failing criteria with scores vs bars}.
- Grade this round independently — your previous scores may have been accurate. But ensure your
  scores reflect the CURRENT state of the code, not the previous round's state.
```

**Thread the verdict path** (`src/harness.ts`):
- In the evaluation loop, after writing a verdict, store `currentVerdictPath` in `runState`.
- On the next evaluation round, pass `previousVerdictPath` to `buildEvaluatorPrompt()`.
- For the first evaluation round (r0), pass `null`.

**Update `runEvaluator()`** (`src/harness.ts`):
- Add `previousVerdictPath` parameter.
- Pass through to `buildEvaluatorPrompt()`.

## Artifact Layout Changes

New files under `{runDir}/`:
```
verdicts/
  verdict-01-r00.json     # HarnessVerdict after each evaluation
  verdict-01-r01.json
  ...
repair-directives/
  repair-s01-r01.json     # RepairDirective before each repair generation
  repair-s01-r02.json
  ...
```

## Migration / Backward Compatibility

- Existing `eval-*.json` files in completed runs will have a `status` field that new code won't read. This is fine — `readCanonicalEvaluation()` becomes more permissive (ignores unknown fields).
- The `resume` path in `loadSprintProgress()` must handle runs started before this change. If `verdicts/` dir doesn't exist, skip verdict-related logic and fall back to current behavior.
- `passBarOverrides` defaults to `{}`, so existing negotiation state without overrides works unchanged.

## Interaction Between Changes

- **A enables D**: The evaluator no longer writes status, so the feedback loop (D) can reference the harness verdict without contradiction.
- **B feeds into C**: The repair directive uses effective pass bars (which may include overrides from B).
- **C supersedes the earlier `failingScores` patch**: The structured directive replaces the inline note.
- **A simplifies C**: The verdict is the single source of truth for pass/fail, so the directive can reference it cleanly.

## Files Modified

| File | Changes |
|------|---------|
| `src/types.ts` | Remove `status` from `CanonicalEvaluation`, add `HarnessVerdict`, `RepairDirective`, `passBarOverrides` to `NegotiationState` and `CanonicalContract`, `currentVerdictPath` to `RunState` |
| `src/utils.ts` | Update `resolvePass()` to remove status check and accept overrides, update `getFailingScores()` to accept overrides |
| `src/prompts.ts` | Update evaluator prompt (remove status, add verdict feedback), update generator prompt (use directive path), update contract draft/review prompts (pass bar overrides), update canonical examples |
| `src/harness.ts` | Write verdict after eval, build/write repair directive, parse pass bar overrides from contract, thread verdict path to evaluator, revert earlier patches |
