# Evaluation Verdict Reform Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign the evaluation feedback loop so the harness is the sole arbiter of pass/fail, repair directives are structured, pass bars are negotiable during contract negotiation, and the evaluator gets feedback when its scores trigger a harness override.

**Architecture:** Four changes to `src/types.ts`, `src/utils.ts`, `src/prompts.ts`, and `src/harness.ts`. The evaluator stops writing a `status` field; the harness writes a `HarnessVerdict` JSON after every evaluation. On failure, the harness writes a `RepairDirective` JSON that the generator reads instead of inline score notes. Contract negotiation can produce `passBarOverrides` that lower pass bars for criteria out of scope for a sprint. The evaluator is told about previous verdict overrides.

**Tech Stack:** TypeScript, Node.js ESM. No tests — validation is `npm run typecheck` (tsc). All `.ts` imports use `.js` extensions.

**Important codebase conventions:**
- No test files exist. Validation = typecheck only.
- All imports use `.js` extensions (Node16 module resolution).
- Run `npx tsc -p tsconfig.json --noEmit` to typecheck the harness code.
- There are earlier patches on the current branch (failingScores param, IMPORTANT note in rubric). Tasks revert/replace those inline.

---

### Task 1: Add new types and update existing types in `src/types.ts`

**Files:**
- Modify: `src/types.ts`

- [ ] **Step 1: Remove `status` from `CanonicalEvaluation` and add `HarnessVerdict`, `RepairDirective` types, update `NegotiationState`, `CanonicalContract`, `RunState`**

Apply these edits to `src/types.ts`:

1. Remove the `status` field from `CanonicalEvaluation` (line 339):

```typescript
// BEFORE (lines 331-339):
export interface CanonicalEvaluation {
  version: 1;
  sprint: number;
  evaluationRound: number;
  feature: {
    id: string;
    title: string;
  };
  status: 'pass' | 'fail';

// AFTER:
export interface CanonicalEvaluation {
  version: 1;
  sprint: number;
  evaluationRound: number;
  feature: {
    id: string;
    title: string;
  };
```

2. Add `passBarOverrides` to `NegotiationState` (after line 166):

```typescript
// BEFORE:
export interface NegotiationState {
  featureId: string;
  sprint: number;
  rounds: NegotiationRound[];
  finalContractPath: string | null;
  status: 'drafting' | 'reviewing' | 'approved' | 'exhausted';
}

// AFTER:
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

3. Add `passBarOverrides` to `CanonicalContract` (after line 310, before `sourceMarkdownPath`):

```typescript
// BEFORE:
  risksNotes: string[];
  sourceMarkdownPath: string;
}

// AFTER:
  risksNotes: string[];
  /** Pass bar overrides negotiated for this sprint. */
  passBarOverrides?: Record<string, number>;
  sourceMarkdownPath: string;
}
```

4. Add `currentVerdictPath` to `RunState` (after line 226, after `currentEvalJsonPath`):

```typescript
// BEFORE:
  currentEvalJsonPath: string | null;
  summary: string | null;

// AFTER:
  currentEvalJsonPath: string | null;
  currentVerdictPath: string | null;
  summary: string | null;
```

5. Add `HarnessVerdict` and `RepairDirective` types at the end of the file (after line 384):

```typescript
// ---- Harness verdict & repair directive ----

export interface HarnessVerdict {
  version: 1;
  sprint: number;
  evaluationRound: number;
  featureId: string;
  passed: boolean;
  reason: 'all_scores_met' | 'score_below_threshold' | 'missing_scores' | 'smoke_failure';
  failingScores: { criterion: string; score: number; passBar: number }[];
  passingScores: { criterion: string; score: number; passBar: number }[];
  evaluationJsonPath: string;
}

export interface RepairDirectiveCriterion {
  criterion: string;
  currentScore: number;
  effectivePassBar: number;
  targetLevelDescription: string;
  currentLevelDescription: string;
}

export interface RepairDirective {
  version: 1;
  sprint: number;
  evaluationRound: number;
  featureId: string;
  verdictPath: string;
  failingCriteria: RepairDirectiveCriterion[];
  passingCriteria: { criterion: string; currentScore: number; effectivePassBar: number }[];
  mustFixBugs: { severity: string; title: string; rootCause: string; evidence: string[] }[];
  evaluationPath: string;
  evaluationJsonPath: string;
  evidenceDir: string | null;
  remainingRounds: number;
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc -p tsconfig.json --noEmit`
Expected: Errors in `src/harness.ts` and `src/prompts.ts` (they still reference `status` on `CanonicalEvaluation`, and `RunState` now requires `currentVerdictPath`). That's expected — we fix those in later tasks.

- [ ] **Step 3: Commit**

```bash
git add src/types.ts
git commit -m "types: add HarnessVerdict, RepairDirective, negotiable pass bars, remove status from CanonicalEvaluation"
```

---

### Task 2: Update `resolvePass()` and `getFailingScores()` in `src/utils.ts`

**Files:**
- Modify: `src/utils.ts`

- [ ] **Step 1: Update `resolvePass()` to remove status check and accept pass bar overrides**

```typescript
// BEFORE (lines 214-248):
export function resolvePass(
  parsedEval: Record<string, unknown> | null,
  criteria: EvalCriteria | null,
): boolean {
  if (!parsedEval) return false;

  if (typeof parsedEval.status === 'string' && parsedEval.status.toLowerCase() === 'fail') {
    return false;
  }

  const scores = isPlainObject(parsedEval.scores)
    ? (parsedEval.scores as Record<string, unknown>)
    : null;

  if (criteria) {
    if (!scores) return false;

    for (const [key, config] of Object.entries(criteria.universalCriteria)) {
      const score = typeof scores[key] === 'number' ? (scores[key] as number) : null;
      if (score === null || score < config.passBar) return false;
    }

    for (const pc of criteria.projectCriteria) {
      const score = typeof scores[pc.id] === 'number' ? (scores[pc.id] as number) : null;
      if (score === null || score < pc.passBar) return false;
    }

    return true;
  }

  if (typeof parsedEval.status === 'string') {
    return parsedEval.status.toLowerCase() === 'pass';
  }
  return false;
}

// AFTER:
export function resolvePass(
  parsedEval: Record<string, unknown> | null,
  criteria: EvalCriteria | null,
  passBarOverrides: Record<string, number> = {},
): boolean {
  if (!parsedEval) return false;
  if (!criteria) return false;

  const scores = isPlainObject(parsedEval.scores)
    ? (parsedEval.scores as Record<string, unknown>)
    : null;

  if (!scores) return false;

  for (const [key, config] of Object.entries(criteria.universalCriteria)) {
    const effectiveBar = Math.min(passBarOverrides[key] ?? config.passBar, config.passBar);
    const score = typeof scores[key] === 'number' ? (scores[key] as number) : null;
    if (score === null || score < effectiveBar) return false;
  }

  for (const pc of criteria.projectCriteria) {
    const effectiveBar = Math.min(passBarOverrides[pc.id] ?? pc.passBar, pc.passBar);
    const score = typeof scores[pc.id] === 'number' ? (scores[pc.id] as number) : null;
    if (score === null || score < effectiveBar) return false;
  }

  return true;
}
```

- [ ] **Step 2: Update `getFailingScores()` to accept pass bar overrides**

```typescript
// BEFORE (lines 250-278):
export function getFailingScores(
  parsedEval: Record<string, unknown> | null,
  criteria: EvalCriteria | null,
): { criterion: string; score: number; passBar: number }[] {
  if (!parsedEval || !criteria) return [];

  const scores = isPlainObject(parsedEval.scores)
    ? (parsedEval.scores as Record<string, unknown>)
    : null;
  if (!scores) return [];

  const failing: { criterion: string; score: number; passBar: number }[] = [];

  for (const [key, config] of Object.entries(criteria.universalCriteria)) {
    const score = typeof scores[key] === 'number' ? (scores[key] as number) : null;
    if (score === null || score < config.passBar) {
      failing.push({ criterion: key, score: score ?? 0, passBar: config.passBar });
    }
  }

  for (const pc of criteria.projectCriteria) {
    const score = typeof scores[pc.id] === 'number' ? (scores[pc.id] as number) : null;
    if (score === null || score < pc.passBar) {
      failing.push({ criterion: pc.id, score: score ?? 0, passBar: pc.passBar });
    }
  }

  return failing;
}

// AFTER:
export function getFailingScores(
  parsedEval: Record<string, unknown> | null,
  criteria: EvalCriteria | null,
  passBarOverrides: Record<string, number> = {},
): { criterion: string; score: number; passBar: number }[] {
  if (!parsedEval || !criteria) return [];

  const scores = isPlainObject(parsedEval.scores)
    ? (parsedEval.scores as Record<string, unknown>)
    : null;
  if (!scores) return [];

  const failing: { criterion: string; score: number; passBar: number }[] = [];

  for (const [key, config] of Object.entries(criteria.universalCriteria)) {
    const effectiveBar = Math.min(passBarOverrides[key] ?? config.passBar, config.passBar);
    const score = typeof scores[key] === 'number' ? (scores[key] as number) : null;
    if (score === null || score < effectiveBar) {
      failing.push({ criterion: key, score: score ?? 0, passBar: effectiveBar });
    }
  }

  for (const pc of criteria.projectCriteria) {
    const effectiveBar = Math.min(passBarOverrides[pc.id] ?? pc.passBar, pc.passBar);
    const score = typeof scores[pc.id] === 'number' ? (scores[pc.id] as number) : null;
    if (score === null || score < effectiveBar) {
      failing.push({ criterion: pc.id, score: score ?? 0, passBar: effectiveBar });
    }
  }

  return failing;
}
```

- [ ] **Step 3: Add `getPassingScores()` helper** (needed by verdict and directive builders)

Add after `getFailingScores()`:

```typescript
export function getPassingScores(
  parsedEval: Record<string, unknown> | null,
  criteria: EvalCriteria | null,
  passBarOverrides: Record<string, number> = {},
): { criterion: string; score: number; passBar: number }[] {
  if (!parsedEval || !criteria) return [];

  const scores = isPlainObject(parsedEval.scores)
    ? (parsedEval.scores as Record<string, unknown>)
    : null;
  if (!scores) return [];

  const passing: { criterion: string; score: number; passBar: number }[] = [];

  for (const [key, config] of Object.entries(criteria.universalCriteria)) {
    const effectiveBar = Math.min(passBarOverrides[key] ?? config.passBar, config.passBar);
    const score = typeof scores[key] === 'number' ? (scores[key] as number) : null;
    if (score !== null && score >= effectiveBar) {
      passing.push({ criterion: key, score, passBar: effectiveBar });
    }
  }

  for (const pc of criteria.projectCriteria) {
    const effectiveBar = Math.min(passBarOverrides[pc.id] ?? pc.passBar, pc.passBar);
    const score = typeof scores[pc.id] === 'number' ? (scores[pc.id] as number) : null;
    if (score !== null && score >= effectiveBar) {
      passing.push({ criterion: pc.id, score, passBar: effectiveBar });
    }
  }

  return passing;
}
```

- [ ] **Step 4: Typecheck**

Run: `npx tsc -p tsconfig.json --noEmit`
Expected: Still errors in harness.ts/prompts.ts from status removal — but no new errors from utils.ts changes (all callers pass fewer args, the new param is optional).

- [ ] **Step 5: Commit**

```bash
git add src/utils.ts
git commit -m "utils: update resolvePass/getFailingScores for pass bar overrides, add getPassingScores"
```

---

### Task 3: Update evaluator prompts in `src/prompts.ts`

**Files:**
- Modify: `src/prompts.ts`

- [ ] **Step 1: Remove `status` from `buildCanonicalEvaluationExample()`**

In `buildCanonicalEvaluationExample()` (around line 257), remove the `status: 'pass',` line from the example object. The example object is typed as `CanonicalEvaluation`, which no longer has `status`.

```typescript
// BEFORE (lines 257-265):
  const example: CanonicalEvaluation = {
    version: 1,
    sprint: sprintNumber,
    evaluationRound,
    feature: {
      id: feature.id,
      title: feature.title,
    },
    status: 'pass',

// AFTER:
  const example: CanonicalEvaluation = {
    version: 1,
    sprint: sprintNumber,
    evaluationRound,
    feature: {
      id: feature.id,
      title: feature.title,
    },
```

- [ ] **Step 2: Remove `status` from `buildEvaluatorJsonExample()`**

In `buildEvaluatorJsonExample()` (around line 205-213):

```typescript
// BEFORE:
  return JSON.stringify({
    status: 'pass',
    confidence: 'medium',
    evidenceQuality: 'adequate',
    summary: '...',
    scores,
    bugs: [],
    filesWritten: ['...'],
  });

// AFTER:
  return JSON.stringify({
    confidence: 'medium',
    evidenceQuality: 'adequate',
    summary: '...',
    scores,
    bugs: [],
    filesWritten: ['...'],
  });
```

- [ ] **Step 3: Update `buildRubricSection()` — remove the pass bar "IMPORTANT" note about status**

In `buildRubricSection()` (around line 172-173), replace the IMPORTANT note:

```typescript
// BEFORE (lines 170-173):
  sections.push('- Every contract criterion satisfied');
  sections.push('- No high-severity bugs');
  sections.push('');
  sections.push('IMPORTANT: If ANY score is below its pass bar, status MUST be "fail" — even if all contract criteria are satisfied. The harness independently checks every score against these thresholds and will reject a "pass" verdict when scores fall short. A contradictory verdict wastes repair rounds because the generator reads your report and sees "pass", so it only fixes cosmetic issues instead of addressing the real gap.');

// AFTER:
  sections.push('- Every contract criterion satisfied');
  sections.push('- No high-severity bugs');
  sections.push('');
  sections.push('NOTE: The harness computes the pass/fail verdict from your scores. You do not write a verdict. Score each criterion honestly — the harness will determine whether the sprint passes based on these thresholds.');
```

- [ ] **Step 4: Update `buildEvaluatorPrompt()` — remove verdict section, add previous verdict feedback (Change D)**

In `buildEvaluatorPrompt()` (around line 699), add `previousVerdictPath` parameter and update the prompt body:

```typescript
// BEFORE (line 699):
export function buildEvaluatorPrompt(
  context: PromptContext,
  feature: Feature,
  sprintNumber: number,
  evaluationRound: number,
  capabilities: TaskCapabilities,
  devSmoke: {
    required: boolean;
    ok: boolean;
    logPath: string | null;
    url: string | null;
  },
  devServerUrl?: string | null,
): string {

// AFTER:
export function buildEvaluatorPrompt(
  context: PromptContext,
  feature: Feature,
  sprintNumber: number,
  evaluationRound: number,
  capabilities: TaskCapabilities,
  devSmoke: {
    required: boolean;
    ok: boolean;
    logPath: string | null;
    url: string | null;
  },
  devServerUrl?: string | null,
  previousVerdictPath?: string | null,
): string {
```

Then add a previous verdict section block inside the function (after the `playwrightSection` variable, before the `rubricSection` line):

```typescript
  const previousVerdictSection = previousVerdictPath
    ? `
## Previous Harness Verdict
The harness computed a FAIL verdict for the previous evaluation round.
Read the full verdict at: ${previousVerdictPath}

The harness checks every score against its pass bar independently.
Grade this round based on the CURRENT state of the code — your previous scores may
have been accurate for the previous round. But be aware that scores below their pass
bars are the reason this repair round exists.
`
    : '';
```

Insert `${previousVerdictSection}` in the prompt body, right after `${playwrightSection}` and before `Read these files:`.

- [ ] **Step 5: Update report format in `buildEvaluatorPrompt()` — replace `## Verdict` with scoring-only instruction**

In the report format section (around lines 800-814):

```typescript
// BEFORE:
## Verdict
## Scorecard

// AFTER:
## Scorecard
(Score each criterion honestly. Do NOT write a pass/fail verdict — the harness computes the verdict from your scores.)
```

- [ ] **Step 6: Typecheck**

Run: `npx tsc -p tsconfig.json --noEmit`
Expected: Errors in `src/harness.ts` (still references `status` on `CanonicalEvaluation`, missing `currentVerdictPath` init). Prompts.ts should be clean now.

- [ ] **Step 7: Commit**

```bash
git add src/prompts.ts
git commit -m "prompts: remove status from evaluator output, add previous verdict feedback"
```

---

### Task 4: Update generator prompt in `src/prompts.ts` — use repair directive path (Change C)

**Files:**
- Modify: `src/prompts.ts`

- [ ] **Step 1: Replace `failingScores` parameter with `repairDirectivePath` in `buildGeneratorPrompt()`**

```typescript
// BEFORE (lines 606-615):
export function buildGeneratorPrompt(
  context: PromptContext,
  feature: Feature,
  sprintNumber: number,
  repairRound: number,
  previousEvalPath: string | null,
  allPriorEvalPaths: string[] = [],
  latestFrozenEvidenceDir: string | null = null,
  allPriorFrozenEvidenceDirs: string[] = [],
  failingScores: { criterion: string; score: number; passBar: number }[] = [],
): string {

// AFTER:
export function buildGeneratorPrompt(
  context: PromptContext,
  feature: Feature,
  sprintNumber: number,
  repairRound: number,
  previousEvalPath: string | null,
  allPriorEvalPaths: string[] = [],
  latestFrozenEvidenceDir: string | null = null,
  allPriorFrozenEvidenceDirs: string[] = [],
  repairDirectivePath: string | null = null,
): string {
```

- [ ] **Step 2: Replace the `failingScoresNote` block with a repair directive reference**

```typescript
// BEFORE (lines 623-633):
  const failingScoresNote = failingScores.length > 0
    ? `\nCRITICAL — The harness rejected the previous evaluation because these scores are below their pass bars:
${failingScores.map((f) => `- ${f.criterion}: scored ${f.score}, needs >= ${f.passBar}`).join('\n')}

This is the PRIMARY reason this repair round exists. The evaluator may have said "pass" in its report,
but the harness independently checks all scores against thresholds. You MUST focus on raising these
scores above their pass bars. Cosmetic fixes will not help if these criteria remain unmet.
Read the rubric for each failing criterion in the contract JSON to understand what the next score
level requires, then implement those specific capabilities.
`
    : '';

// AFTER:
  const repairDirectiveNote = repairDirectivePath
    ? `\nCRITICAL — Read the repair directive: ${repairDirectivePath}
It lists every criterion that must improve, with rubric descriptions of your current
level and the target level. Focus on the largest gaps first. Do not regress passing criteria.
The repair directive is the authoritative source for why this repair round exists.
`
    : '';
```

- [ ] **Step 3: Replace `${failingScoresNote}` with `${repairDirectiveNote}` in the repairNote template**

```typescript
// BEFORE:
  const repairNote = repairRound > 0
    ? `\nThis is repair round ${repairRound}. Read the previous evaluation report carefully and fix every issue it identified.
${failingScoresNote}
IMPORTANT — Evidence-based repair:

// AFTER:
  const repairNote = repairRound > 0
    ? `\nThis is repair round ${repairRound}. Read the previous evaluation report carefully and fix every issue it identified.
${repairDirectiveNote}
IMPORTANT — Evidence-based repair:
```

- [ ] **Step 4: Typecheck**

Run: `npx tsc -p tsconfig.json --noEmit`
Expected: Errors in `src/harness.ts` only (still passes `failingScores` to this function, `status` references, etc).

- [ ] **Step 5: Commit**

```bash
git add src/prompts.ts
git commit -m "prompts: replace failingScores with repairDirectivePath in generator prompt"
```

---

### Task 5: Update contract prompts for negotiable pass bars (Change B) in `src/prompts.ts`

**Files:**
- Modify: `src/prompts.ts`

- [ ] **Step 1: Update `buildCanonicalContractExample()` to include `passBarOverrides`**

In `buildCanonicalContractExample()` (around line 216-241), add `passBarOverrides` to the example:

```typescript
// BEFORE (around line 238):
    risksNotes: ['Known implementation risk or constraint'],
    sourceMarkdownPath: markdownPath,
  };

// AFTER:
    risksNotes: ['Known implementation risk or constraint'],
    passBarOverrides: {},
    sourceMarkdownPath: markdownPath,
  };
```

- [ ] **Step 2: Add pass bar override instruction to `buildGeneratorDraftContractPrompt()`**

Add the instruction after the criteria summary and before the "Keep the scope narrow" line (around line 543-545):

```typescript
// BEFORE:
${criteriaSummary}

Keep the scope narrow enough for a single sprint.

// AFTER:
${criteriaSummary}

If this sprint's scope does not fully cover a scored criterion (e.g., AI integration is
deferred to a later sprint), include a \`passBarOverrides\` field in the contract JSON with
adjusted pass bars for those criteria. Only lower bars for criteria genuinely out of scope —
do not lower bars to make the sprint easier. Example: \`"passBarOverrides": {"aiIntegrationDepth": 2}\`

Keep the scope narrow enough for a single sprint.
```

- [ ] **Step 3: Add pass bar override review instruction to `buildEvaluatorReviewContractPrompt()`**

Add after the review checklist (around line 590, before `Write your review to:`):

```typescript
// BEFORE:
Flag any acceptance criterion that is NOT covered by a "Done Means" entry.

Write your review to: ${reviewPath}

// AFTER:
Flag any acceptance criterion that is NOT covered by a "Done Means" entry.

If the contract includes \`passBarOverrides\` in the JSON, verify each override is justified
by the sprint's scope. Reject overrides that lower bars for work that IS in scope for this sprint.
Approve overrides for criteria that are genuinely deferred to a later sprint.

Write your review to: ${reviewPath}
```

- [ ] **Step 4: Typecheck**

Run: `npx tsc -p tsconfig.json --noEmit`
Expected: Still errors in `src/harness.ts` only.

- [ ] **Step 5: Commit**

```bash
git add src/prompts.ts
git commit -m "prompts: add passBarOverrides to contract draft/review prompts"
```

---

### Task 6: Update `src/harness.ts` — fix all type errors, write verdict and repair directive

This is the largest task. It updates the harness state machine to:
1. Initialize `currentVerdictPath` in run state
2. Remove `status` from `readCanonicalEvaluation()` validation
3. Remove `status` from `writeSyntheticSmokeFailureEval()`
4. Write `HarnessVerdict` after every evaluation
5. Write `RepairDirective` before repair rounds
6. Parse `passBarOverrides` from approved contracts
7. Thread overrides through `resolvePass()` and `getFailingScores()`
8. Thread `previousVerdictPath` through evaluator calls
9. Update `runGenerator()` to pass `repairDirectivePath` instead of `failingScores`
10. Fix the `runTask()` contract-review guard from the earlier patch

**Files:**
- Modify: `src/harness.ts`

- [ ] **Step 1: Update imports**

```typescript
// BEFORE (around line 35-36):
  getFailingScores,
  resolvePass,

// AFTER:
  getFailingScores,
  getPassingScores,
  isPlainObject,
  resolvePass,
```

Also add the new types to the type import at the top of the file. Find the existing import from `'./types.js'` and add `HarnessVerdict`, `RepairDirective`, `RepairDirectiveCriterion`:

```typescript
// Add to the import from './types.js':
import type {
  // ... existing imports ...
  HarnessVerdict,
  RepairDirective,
  RepairDirectiveCriterion,
  // ... existing imports ...
} from './types.js';
```

- [ ] **Step 2: Add `currentVerdictPath: null` to `initRunState()`**

In the `initRunState()` method (around line 131-154), add `currentVerdictPath`:

```typescript
// BEFORE:
      currentEvalJsonPath: null,
      summary: null,

// AFTER:
      currentEvalJsonPath: null,
      currentVerdictPath: null,
      summary: null,
```

- [ ] **Step 3: Add `currentVerdictPath: null` to `clearActiveSprintState()`**

```typescript
// BEFORE (around line 697-705):
  private clearActiveSprintState(runState: RunState): void {
    runState.currentFeatureId = null;
    runState.currentContractPath = null;
    runState.currentContractJsonPath = null;
    runState.currentEvalPath = null;
    runState.currentEvalJsonPath = null;
    runState.currentNegotiation = null;
    runState.repairRound = 0;
  }

// AFTER:
  private clearActiveSprintState(runState: RunState): void {
    runState.currentFeatureId = null;
    runState.currentContractPath = null;
    runState.currentContractJsonPath = null;
    runState.currentEvalPath = null;
    runState.currentEvalJsonPath = null;
    runState.currentVerdictPath = null;
    runState.currentNegotiation = null;
    runState.repairRound = 0;
  }
```

- [ ] **Step 4: Add `passBarOverrides: {}` to negotiation state init in `negotiateContract()`**

In `negotiateContract()` (around line 877-883):

```typescript
// BEFORE:
      runState.currentNegotiation = {
        featureId: feature.id,
        sprint: runState.sprint,
        rounds: [],
        finalContractPath: null,
        status: 'drafting',
      };

// AFTER:
      runState.currentNegotiation = {
        featureId: feature.id,
        sprint: runState.sprint,
        rounds: [],
        finalContractPath: null,
        status: 'drafting',
        passBarOverrides: {},
      };
```

- [ ] **Step 5: Parse `passBarOverrides` from approved/exhausted contract in `negotiateContract()`**

After the contract is approved (around line 986-998, after the `✓ Contract approved` log line), and also after exhausted (around line 1003-1011, after the `⚠ Contract negotiation exhausted` log line), add logic to read pass bar overrides from the canonical contract JSON.

Add a new private helper method to the class:

```typescript
  private async extractPassBarOverrides(runState: RunState): Promise<Record<string, number>> {
    if (!runState.currentContractJsonPath) return {};
    try {
      const contract = await this.readCanonicalContract(runState.currentContractJsonPath);
      return contract.passBarOverrides ?? {};
    } catch {
      return {};
    }
  }
```

Then in the approved block (after line 997 `this.output.log(...)`):

```typescript
          negotiation.passBarOverrides = await this.extractPassBarOverrides(runState);
          await this.saveRunState(runState);
```

And in the exhausted block (after line 1011 `this.output.log(...)`):

```typescript
    negotiation.passBarOverrides = await this.extractPassBarOverrides(runState);
    await this.saveRunState(runState);
```

- [ ] **Step 6: Remove `status` validation from `readCanonicalEvaluation()`**

```typescript
// BEFORE (around line 1432-1435):
    if (
      !value ||
      value.version !== 1 ||
      (value.status !== 'pass' && value.status !== 'fail') ||
      !isConfidenceLevel(value.confidence) ||

// AFTER:
    if (
      !value ||
      value.version !== 1 ||
      !isConfidenceLevel(value.confidence) ||
```

- [ ] **Step 7: Remove `status: 'fail'` from `writeSyntheticSmokeFailureEval()`**

In the `canonicalEval` object inside `writeSyntheticSmokeFailureEval()` (around line 1168-1204), remove the `status: 'fail',` line:

```typescript
// BEFORE (around line 1168-1176):
    const canonicalEval: CanonicalEvaluation = {
      version: 1,
      sprint: runState.sprint,
      evaluationRound,
      feature: {
        id: feature.id,
        title: feature.title,
      },
      status: 'fail',
      confidence: 'high',

// AFTER:
    const canonicalEval: CanonicalEvaluation = {
      version: 1,
      sprint: runState.sprint,
      evaluationRound,
      feature: {
        id: feature.id,
        title: feature.title,
      },
      confidence: 'high',
```

Also remove `status: 'fail',` from the `parsed` object above it (around line 1153):

```typescript
// BEFORE:
    const parsed = {
      status: 'fail',
      confidence: 'high',

// AFTER:
    const parsed = {
      confidence: 'high',
```

Also remove `'## Verdict',` and `'fail',` and the empty string after from the `report` array (around line 1123-1125):

```typescript
// BEFORE:
      '## Verdict',
      'fail',
      '',
      '## Scorecard',

// AFTER:
      '## Scorecard',
```

- [ ] **Step 8: Add verdict and repair directive builder methods**

Add these new private methods to the `HarnessRunner` class:

```typescript
  private getEffectivePassBarOverrides(runState: RunState): Record<string, number> {
    return runState.currentNegotiation?.passBarOverrides ?? {};
  }

  private verdictPath(sprint: number, evaluationRound: number, runDir: string): string {
    return path.join(
      runDir,
      'verdicts',
      `verdict-${String(sprint).padStart(2, '0')}-r${String(evaluationRound).padStart(2, '0')}.json`,
    );
  }

  private repairDirectivePath(sprint: number, evaluationRound: number, runDir: string): string {
    return path.join(
      runDir,
      'repair-directives',
      `repair-s${String(sprint).padStart(2, '0')}-r${String(evaluationRound).padStart(2, '0')}.json`,
    );
  }

  private async writeVerdict(
    runState: RunState,
    evaluationRound: number,
    evalParsed: Record<string, unknown> | null,
    evalCriteria: EvalCriteria | null,
    isSmokeFailure: boolean,
  ): Promise<HarnessVerdict> {
    const overrides = this.getEffectivePassBarOverrides(runState);
    const passed = resolvePass(evalParsed, evalCriteria, overrides);
    const failing = getFailingScores(evalParsed, evalCriteria, overrides);
    const passing = getPassingScores(evalParsed, evalCriteria, overrides);

    let reason: HarnessVerdict['reason'];
    if (isSmokeFailure) {
      reason = 'smoke_failure';
    } else if (passed) {
      reason = 'all_scores_met';
    } else if (!evalParsed || !isPlainObject(evalParsed.scores)) {
      reason = 'missing_scores';
    } else {
      reason = 'score_below_threshold';
    }

    const verdict: HarnessVerdict = {
      version: 1,
      sprint: runState.sprint,
      evaluationRound,
      featureId: runState.currentFeatureId!,
      passed,
      reason,
      failingScores: failing,
      passingScores: passing,
      evaluationJsonPath: runState.currentEvalJsonPath!,
    };

    const verdictFilePath = this.verdictPath(runState.sprint, evaluationRound, runState.runDir);
    await writeJson(verdictFilePath, verdict);
    runState.currentVerdictPath = verdictFilePath;
    await this.saveRunState(runState);
    return verdict;
  }

  private lookupRubricDescription(
    criterion: string,
    scoreLevel: number,
    evalCriteria: EvalCriteria | null,
  ): string {
    if (!evalCriteria) return '';
    const pc = evalCriteria.projectCriteria.find((c) => c.id === criterion);
    if (pc) {
      return pc.rubric[String(scoreLevel)] || '';
    }
    const universal = UNIVERSAL_RUBRICS[criterion];
    if (universal) {
      return universal.anchors[String(scoreLevel)] || '';
    }
    return '';
  }

  private async writeRepairDirective(
    runState: RunState,
    evaluationRound: number,
    verdict: HarnessVerdict,
    evalCriteria: EvalCriteria | null,
    evidenceDir: string | null,
  ): Promise<string> {
    const canonicalEval = await this.readCanonicalEvaluation(runState.currentEvalJsonPath!);

    const failingCriteria: RepairDirectiveCriterion[] = verdict.failingScores.map((f) => ({
      criterion: f.criterion,
      currentScore: f.score,
      effectivePassBar: f.passBar,
      targetLevelDescription: this.lookupRubricDescription(f.criterion, f.passBar, evalCriteria),
      currentLevelDescription: this.lookupRubricDescription(f.criterion, f.score, evalCriteria),
    }));
    // Sort by gap size descending
    failingCriteria.sort((a, b) => (b.effectivePassBar - b.currentScore) - (a.effectivePassBar - a.currentScore));

    const mustFixBugs = canonicalEval.bugs
      .filter((b) => b.severity === 'high' || b.severity === 'critical')
      .map((b) => ({
        severity: b.severity,
        title: b.title,
        rootCause: b.rootCause,
        evidence: b.evidence,
      }));

    const directive: RepairDirective = {
      version: 1,
      sprint: runState.sprint,
      evaluationRound,
      featureId: runState.currentFeatureId!,
      verdictPath: runState.currentVerdictPath!,
      failingCriteria,
      passingCriteria: verdict.passingScores.map((p) => ({
        criterion: p.criterion,
        currentScore: p.score,
        effectivePassBar: p.passBar,
      })),
      mustFixBugs,
      evaluationPath: runState.currentEvalPath!,
      evaluationJsonPath: runState.currentEvalJsonPath!,
      evidenceDir,
      remainingRounds: this.config.maxRepairRounds - evaluationRound,
    };

    const directivePath = this.repairDirectivePath(runState.sprint, evaluationRound, runState.runDir);
    await writeJson(directivePath, directive);
    return directivePath;
  }
```

Note: `UNIVERSAL_RUBRICS` is defined in `prompts.ts` but not exported. You need to either export it or move `lookupRubricDescription` to prompts.ts. The simpler approach: export `UNIVERSAL_RUBRICS` from `prompts.ts`.

In `src/prompts.ts`, change:

```typescript
// BEFORE (line 54):
const UNIVERSAL_RUBRICS: Record<string, { label: string; description: string; anchors: Record<string, string> }> = {

// AFTER:
export const UNIVERSAL_RUBRICS: Record<string, { label: string; description: string; anchors: Record<string, string> }> = {
```

And in `src/harness.ts`, add to the prompts import:

```typescript
// Add UNIVERSAL_RUBRICS to the import from './prompts.js'
import {
  // ... existing imports ...
  UNIVERSAL_RUBRICS,
} from './prompts.js';
```

- [ ] **Step 9: Update the evaluation loop to write verdict and repair directive**

In the evaluation loop (around lines 553-578), replace the `resolvePass` call with verdict writing and add repair directive:

```typescript
// BEFORE (around lines 557-578):
            latestFrozenEvidenceDir = await this.freezeEvaluatorEvidence(runState, evaluationRound);
            latestEvalPath = runState.currentEvalPath;
            latestEvalParsed = evalResult.parsed;
            allEvalPaths.push(runState.currentEvalPath);
            if (latestFrozenEvidenceDir) {
              allFrozenEvidenceDirs.push(latestFrozenEvidenceDir);
            }

            await this.freezeBenchmarkArtifacts(
              runState,
              `eval-s${this.sprintPad(runState.sprint)}-r${this.roundPad(evaluationRound)}`,
              [
                runState.currentEvalPath!,
                runState.currentEvalJsonPath!,
                ...(latestFrozenEvidenceDir ? [latestFrozenEvidenceDir] : []),
              ],
            );

            if (resolvePass(evalResult.parsed, evalCriteria)) {
              this.recordRepairRoundsToPass('generator', evaluationRound, runState);
              passed = true;
              break;
            }

// AFTER:
            latestFrozenEvidenceDir = await this.freezeEvaluatorEvidence(runState, evaluationRound);
            latestEvalPath = runState.currentEvalPath;
            latestEvalParsed = evalResult.parsed;
            allEvalPaths.push(runState.currentEvalPath);
            if (latestFrozenEvidenceDir) {
              allFrozenEvidenceDirs.push(latestFrozenEvidenceDir);
            }

            await this.freezeBenchmarkArtifacts(
              runState,
              `eval-s${this.sprintPad(runState.sprint)}-r${this.roundPad(evaluationRound)}`,
              [
                runState.currentEvalPath!,
                runState.currentEvalJsonPath!,
                ...(latestFrozenEvidenceDir ? [latestFrozenEvidenceDir] : []),
              ],
            );

            const isSmokeFailure = false;
            const verdict = await this.writeVerdict(runState, evaluationRound, evalResult.parsed, evalCriteria, isSmokeFailure);

            if (verdict.passed) {
              this.recordRepairRoundsToPass('generator', evaluationRound, runState);
              passed = true;
              break;
            }

            // Write repair directive for the next generator round
            latestRepairDirectivePath = await this.writeRepairDirective(
              runState, evaluationRound, verdict, evalCriteria, latestFrozenEvidenceDir,
            );
```

You also need to declare `latestRepairDirectivePath` at the top of the repair loop block. Find where `latestEvalPath` is declared (around line 450-454) and add:

```typescript
        let latestEvalPath = progress.latestEvalPath;
        let latestEvalParsed = progress.latestEvalParsed;
        const allEvalPaths = [...progress.allEvalPaths];
        let latestFrozenEvidenceDir = progress.allFrozenEvidenceDirs.at(-1) || null;
        const allFrozenEvidenceDirs = [...progress.allFrozenEvidenceDirs];
        let latestRepairDirectivePath: string | null = null;
```

- [ ] **Step 10: Handle smoke failure verdicts**

For `writeSyntheticSmokeFailureEval` call sites (there are two — dev-smoke at ~line 495-502 and smoke-test at ~line 524-531), add verdict writing after each. After each `evalResult = await this.writeSyntheticSmokeFailureEval(...)` call, add:

```typescript
                await this.writeVerdict(runState, evaluationRound, evalResult.parsed, evalCriteria, true);
```

- [ ] **Step 11: Update `runGenerator()` to accept `repairDirectivePath` instead of `failingScores`**

```typescript
// BEFORE:
  private async runGenerator(
    runState: RunState,
    feature: Feature,
    previousEvalPath: string | null,
    allPriorEvalPaths: string[] = [],
    evalCriteria: EvalCriteria | null = null,
    latestFrozenEvidenceDir: string | null = null,
    allPriorFrozenEvidenceDirs: string[] = [],
    failingScores: { criterion: string; score: number; passBar: number }[] = [],
  ): Promise<{ parsed: Record<string, unknown> | null; meta: { sessionId?: string } }> {
    await this.assertFrozenEvidenceIntact(runState, latestFrozenEvidenceDir);

    const context = createPromptContext(this.config, runState, this.capabilities, evalCriteria);
    const prompt = buildGeneratorPrompt(
      context,
      feature,
      runState.sprint,
      runState.repairRound,
      previousEvalPath,
      allPriorEvalPaths,
      latestFrozenEvidenceDir,
      allPriorFrozenEvidenceDirs,
      failingScores,
    );

// AFTER:
  private async runGenerator(
    runState: RunState,
    feature: Feature,
    previousEvalPath: string | null,
    allPriorEvalPaths: string[] = [],
    evalCriteria: EvalCriteria | null = null,
    latestFrozenEvidenceDir: string | null = null,
    allPriorFrozenEvidenceDirs: string[] = [],
    repairDirectivePath: string | null = null,
  ): Promise<{ parsed: Record<string, unknown> | null; meta: { sessionId?: string } }> {
    await this.assertFrozenEvidenceIntact(runState, latestFrozenEvidenceDir);

    const context = createPromptContext(this.config, runState, this.capabilities, evalCriteria);
    const prompt = buildGeneratorPrompt(
      context,
      feature,
      runState.sprint,
      runState.repairRound,
      previousEvalPath,
      allPriorEvalPaths,
      latestFrozenEvidenceDir,
      allPriorFrozenEvidenceDirs,
      repairDirectivePath,
    );
```

- [ ] **Step 12: Update the `runGenerator()` call site in the repair loop**

```typescript
// BEFORE:
            const genResult = await this.runGenerator(
              runState,
              feature,
              latestEvalPath,
              allEvalPaths,
              evalCriteria,
              latestFrozenEvidenceDir,
              allFrozenEvidenceDirs,
              getFailingScores(latestEvalParsed, evalCriteria),
            );

// AFTER:
            const genResult = await this.runGenerator(
              runState,
              feature,
              latestEvalPath,
              allEvalPaths,
              evalCriteria,
              latestFrozenEvidenceDir,
              allFrozenEvidenceDirs,
              latestRepairDirectivePath,
            );
```

- [ ] **Step 13: Thread `previousVerdictPath` to evaluator**

Update `runEvaluator()` to accept and pass `previousVerdictPath`:

```typescript
// BEFORE:
  private async runEvaluator(
    runState: RunState,
    feature: Feature,
    evaluationRound: number,
    evalCriteria: EvalCriteria | null,
    devSmoke: {
      required: boolean;
      ok: boolean;
      logPath: string | null;
      url: string | null;
    },
    devServerUrl?: string | null,
  ): Promise<{ parsed: Record<string, unknown> | null }> {
    await ensureDir(this.evidenceDir(runState.sprint, evaluationRound, runState.runDir));
    const context = createPromptContext(this.config, runState, this.capabilities, evalCriteria);
    const prompt = buildEvaluatorPrompt(
      context,
      feature,
      runState.sprint,
      evaluationRound,
      this.capabilities.evaluator,
      devSmoke,
      devServerUrl,
    );

// AFTER:
  private async runEvaluator(
    runState: RunState,
    feature: Feature,
    evaluationRound: number,
    evalCriteria: EvalCriteria | null,
    devSmoke: {
      required: boolean;
      ok: boolean;
      logPath: string | null;
      url: string | null;
    },
    devServerUrl?: string | null,
    previousVerdictPath?: string | null,
  ): Promise<{ parsed: Record<string, unknown> | null }> {
    await ensureDir(this.evidenceDir(runState.sprint, evaluationRound, runState.runDir));
    const context = createPromptContext(this.config, runState, this.capabilities, evalCriteria);
    const prompt = buildEvaluatorPrompt(
      context,
      feature,
      runState.sprint,
      evaluationRound,
      this.capabilities.evaluator,
      devSmoke,
      devServerUrl,
      previousVerdictPath,
    );
```

Then update the `runEvaluator` call site in the eval loop (around line 533) to pass `runState.currentVerdictPath`:

```typescript
// BEFORE:
                    evalResult = await this.runEvaluator(
                      runState,
                      feature,
                      evaluationRound,
                      evalCriteria,
                      {
                        required: !!devServer?.getUrl(),
                        ok: devSmoke ? devSmoke.ok : !this.config.smoke.start,
                        logPath: devSmoke?.logPath || null,
                        url: devSmoke?.url || devServer?.getUrl() || null,
                      },
                      devServer?.getUrl(),
                    );

// AFTER:
                    evalResult = await this.runEvaluator(
                      runState,
                      feature,
                      evaluationRound,
                      evalCriteria,
                      {
                        required: !!devServer?.getUrl(),
                        ok: devSmoke ? devSmoke.ok : !this.config.smoke.start,
                        logPath: devSmoke?.logPath || null,
                        url: devSmoke?.url || devServer?.getUrl() || null,
                      },
                      devServer?.getUrl(),
                      runState.currentVerdictPath,
                    );
```

- [ ] **Step 14: Update `loadSprintProgress()` to pass overrides to `resolvePass()`**

```typescript
// BEFORE (around line 778-779):
    return {
      passed: resolvePass(latestEvalParsed, evalCriteria),

// AFTER:
    return {
      passed: resolvePass(latestEvalParsed, evalCriteria, runState.currentNegotiation?.passBarOverrides ?? {}),
```

The method signature needs `runState` — it already receives it as the first parameter, so this works.

- [ ] **Step 15: Typecheck**

Run: `npx tsc -p tsconfig.json --noEmit`
Expected: PASS — all type errors should be resolved.

- [ ] **Step 16: Commit**

```bash
git add src/harness.ts src/prompts.ts
git commit -m "harness: write verdict/repair directive, negotiable pass bars, evaluator feedback loop"
```

---

### Task 7: Build verification

**Files:**
- None (verification only)

- [ ] **Step 1: Full typecheck**

Run: `npx tsc -p tsconfig.json --noEmit`
Expected: PASS with zero errors.

- [ ] **Step 2: Build**

Run: `npm run build 2>&1 | tail -5`
Expected: Build succeeds.

- [ ] **Step 3: Verify the harness can start**

Run: `npm run harness -- status 2>&1 | head -10`
Expected: No crash. May show "no runs found" or similar.

- [ ] **Step 4: Commit (if any fixups were needed)**

Only commit if steps 1-3 required fixes. Otherwise skip.
