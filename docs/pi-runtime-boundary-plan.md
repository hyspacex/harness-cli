# Pi Runtime Boundary Plan

This plan keeps Harness CLI as one repo while drawing a hard internal boundary between:

- System A: the runtime harness that runs agents, manages sprint state, writes contracts/evals/verdicts, and resumes sessions.
- System B: the audit system that reads completed run artifacts, builds packets, runs objective checks, compares profiles, and writes release-gate evidence.

The original goal is not "use Pi" by itself. The goal is to test whether Pi can replace questionable System A runtime complexity while preserving the artifact/audit stack that makes Harness CLI measurable.

## Boundary Rule

Runtime code may write artifact schema objects. Audit code may read artifact schema objects. Audit code must not reach into `HarnessRunner`, prompt construction, runtime state-machine methods, or provider-specific task plumbing unless it is explicitly executing a matrix run or invoking a judge provider.

Allowed dependencies:

- runtime -> `src/artifacts/schema.ts`
- audit -> `src/artifacts/schema.ts`
- audit -> `src/artifacts/run-reader.ts`
- matrix execution -> runtime runner/provider registry
- matrix reporting -> audit packet/comparison APIs

Disallowed dependencies:

- packet building -> `src/harness.ts`
- packet building -> `src/prompts.ts`
- packet building -> `src/providers/*`
- matrix report mode -> `HarnessRunner`
- artifact schema/reader -> runtime types

## Phase 1: Artifact Boundary Foundation

Purpose: make the audit path consume a typed artifact contract instead of runtime internals.

Implementation steps:

1. Add `src/artifacts/schema.ts`.
   - Define externally consumed run-artifact types: run summary, role-provider summary, canonical contract, canonical evaluation, verdict, repair directive, frozen evidence manifest, benchmark artifact manifest, and metrics payload.
   - Keep this module free of imports from runtime modules.
   - Re-export canonical artifact types from `src/types.ts` only as a compatibility bridge for current runtime code.

2. Add `src/artifacts/run-reader.ts`.
   - Read `run.json` and `metrics.json` into a minimal `RunArtifactBundle`.
   - Validate required fields used by System B.
   - Expose a latest-run lookup for matrix report mode.
   - Do not import `src/harness.ts`, `src/prompts.ts`, `src/providers/*`, or `src/types.ts`.

3. Update `src/evals.ts`.
   - Replace direct `RunState` reads with `readRunArtifactBundle`.
   - Keep packet JSON/Markdown shape unchanged.
   - Keep secret redaction unchanged.

4. Add an import-boundary test.
   - Assert `src/artifacts/**` has no imports from runtime internals.
   - Assert `src/evals.ts` does not import runtime internals or `RunState`.

Deterministic verification:

```bash
npm run build:harness
node --test test/*.mjs
```

Additional targeted checks:

```bash
node --test test/artifact-boundary.test.mjs
node --test test/evals.test.mjs
```

Phase 1 is done when:

- All existing tests pass.
- The boundary test passes.
- `buildEvalRunPacket()` succeeds against the existing synthetic run fixtures.
- `src/evals.ts` no longer imports `RunState` from `src/types.ts`.
- No runtime behavior changes are required.

Stop condition:

- If packet building needs fields that are not stable artifacts, add them to `RunArtifactSummary` deliberately instead of importing `RunState`.

## Phase 2: Split Pure Matrix Reporting From Matrix Execution

Purpose: make `eval matrix report --from ...` a pure audit path while leaving `eval matrix --execute true` free to call the runtime.

Implementation steps:

1. Move shared matrix types into `src/matrix/schema.ts`.
2. Move report-mode logic, packetization of existing runs, ship-gate building, report Markdown rendering, and dry pairwise comparison writing into `src/matrix/report.ts`.
3. Move plan construction and fixture isolation into `src/matrix/plan.ts`.
4. Keep runtime execution in `src/matrix/execute.ts`.
5. Keep `src/eval-matrix.ts` as the CLI-facing wrapper that dispatches to plan/report/execute.

Deterministic verification:

```bash
npm run build:harness
node --test test/eval-matrix.test.mjs
node --test test/artifact-boundary.test.mjs
```

Add this boundary assertion:

- `src/matrix/report.ts` must not import `../harness.js`, `../prompts.js`, or `../providers/*`.
- `test/eval-matrix.test.mjs` must keep a report-mode test that builds a synthetic matrix plan and run roots in a temp directory, then runs report mode against those artifacts.

Phase 2 is done when:

- Report mode works against the synthetic matrix plan/run-root fixture created by `test/eval-matrix.test.mjs`.
- Existing matrix report tests still pass.
- Matrix execute still produces packets and matrix results.

Stop condition:

- If report mode needs runtime-only state, convert that state into an artifact-schema field or treat it as unavailable evidence.

## Phase 3: Pi Provider Spike

Purpose: test Pi as a runtime substrate without changing System B.

Implementation steps:

1. Add `pi` as an optional provider name only after deciding the concrete integration path.
2. Add `src/providers/pi.ts` behind the existing `ProviderRuntime` interface.
3. Support one task shape first: generator task in a controlled smoke fixture.
4. Return the existing `TaskResult` shape: raw text, parsed JSON, and session metadata.
5. Preserve canonical artifact expectations from runtime prompts.

Deterministic verification:

```bash
npm run build:harness
node --test test/*.mjs
npm run harness -- profiles
```

Add these deterministic checks before expanding usage:

- Add a unit-level Pi provider test with a fake Pi transport. It must assert that a generator task returns the existing `TaskResult` shape, including raw text, parsed JSON, and session metadata.
- Add a fixture-backed packet test using a static run directory that looks like a Pi-generated run. It must prove System B packetization needs no Pi-specific branch.
- Keep any live Pi run as optional exploratory evidence, not as the deterministic pass/fail check.

Phase 3 is done when:

- A Pi-backed generator task writes the same canonical artifacts expected by packet building.
- Existing Claude/Codex providers remain unchanged.
- A Pi run can be packetized without special cases.
- Tests prove the adapter contract with a fake transport, so CI does not require Pi auth or network access.

Stop condition:

- If Pi cannot produce deterministic artifact writes through the existing task contract, do not modify System B to accommodate it. Fix or abandon the provider adapter.

## Phase 4: Flattened Runtime Profile

Purpose: test whether researcher/planner/contract ceremony earns its keep against a stronger model/runtime.

Implementation steps:

1. Add a profile such as `pi-flat-generator`.
2. Fold research/planning instructions into a single generator-oriented runtime path for that profile.
3. Keep evaluator separate.
4. Keep canonical artifacts mandatory: prompt, spec/backlog equivalent, contract JSON, eval JSON, verdict, and repair directive.
5. Avoid deleting current role flow until matrix evidence supports it.

Deterministic verification:

```bash
npm run build:harness
node --test test/*.mjs
npm run harness -- eval matrix --case harness-cli-error-ergonomics --profiles balanced,pi-flat-generator --execute false --objective-checks true --out /tmp/harness-pi-flat-plan --force true
node -e "const fs=require('fs'); const plan=JSON.parse(fs.readFileSync('/tmp/harness-pi-flat-plan/matrix-plan.json','utf8')); const profiles=plan.runs.map(r=>r.profile).sort().join(','); if (profiles !== 'balanced,pi-flat-generator') throw new Error(profiles);"
```

Decision evidence command after deterministic profile-plan checks pass:

```bash
npm run harness -- eval matrix --case harness-cli-error-ergonomics --profiles balanced,pi-flat-generator --execute true --objective-checks true --continue-on-error true --max-sprints 2 --out /tmp/harness-pi-flat-cli --force true
npm run harness -- eval matrix report --from /tmp/harness-pi-flat-cli
```

Phase 4 is done when:

- The dry-run matrix plan deterministically includes `balanced` and `pi-flat-generator` with separate workspaces/run roots.
- The flattened profile completes at least one CLI eval case.
- The resulting run is packetized without special cases.
- `matrix-result.json.shipGate` is `pass` or `warning` only for intentionally omitted LLM judging.

Stop condition:

- If flattened runs produce weaker artifacts, false passes, or unrepairable scope drift, keep Pi as a provider backend but do not flatten System A.

## Phase 5: Evidence-Based Runtime Simplification

Purpose: delete or simplify System A complexity only after matrix evidence says it is safe.

Implementation steps:

1. Run profile comparisons:
   - `balanced` vs `pi-flat-generator`
   - `full-harness` vs `pi-flat-generator`
   - at least one CLI case and one frontend case
2. Inspect packet artifacts, objective checks, pairwise judge output, and ship gates.
3. Pick one simplification at a time:
   - merge researcher into planner/generator
   - reduce contract negotiation rounds
   - delegate session persistence to Pi
   - remove bespoke resume code only after Pi covers repair rounds

Deterministic verification:

```bash
npm run build:harness
node --test test/*.mjs
node -e "const fs=require('fs'); for (const dir of ['/tmp/harness-pi-decision-cli','/tmp/harness-pi-decision-frontend']) { const result=JSON.parse(fs.readFileSync(dir + '/matrix-result.json','utf8')); if (!['pass','warning'].includes(result.shipGate.status)) throw new Error(dir + ': ' + result.shipGate.status); if (!result.results.every(r => r.packetPath)) throw new Error(dir + ': missing packet'); }"
```

Decision evidence command before running that gate:

```bash
npm run harness -- eval matrix --case harness-cli-error-ergonomics --profiles full-harness,balanced,pi-flat-generator --execute true --objective-checks true --continue-on-error true --max-sprints 2 --out /tmp/harness-pi-decision-cli --force true
npm run harness -- eval matrix --case examples-adaptive-dashboard-filtering --profiles balanced,pi-flat-generator --execute true --objective-checks true --continue-on-error true --max-sprints 2 --out /tmp/harness-pi-decision-frontend --force true
```

Decision rule:

- If Pi-flat ties or wins on task fulfillment, correctness, harness process quality, and evaluation trustworthiness, simplify System A around it.
- If Pi-flat wins on speed/cost but loses on scope control or artifact quality, keep Pi as a backend profile only.
- If Pi-flat cannot produce clean packets and passing objective checks, stop the migration.

Phase 5 is done when:

- Any deleted runtime role/loop has before/after matrix evidence.
- Packet shape remains stable.
- System B needs no special handling for the simplified runtime path.
