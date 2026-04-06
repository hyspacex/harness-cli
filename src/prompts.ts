import path from 'node:path';
import type {
  CanonicalContract,
  CanonicalEvaluation,
  EvalCriteria,
  Feature,
  HarnessConfig,
  PromptContext,
  RunState,
  SmokeConfig,
  TaskCapabilities,
} from './types.js';

// ---------------------------------------------------------------------------
// Role system prompts — injected via the SDK systemPrompt option, separate
// from the user-facing task prompt.
// ---------------------------------------------------------------------------

export const SYSTEM_PROMPTS = {
  researcher:
    'You are the researcher in a long-running application harness. You deeply analyze ' +
    'the user\'s request to understand domain-specific concepts, terminology, and intent. ' +
    'You produce a research brief and structured evaluation criteria. You never write ' +
    'implementation code.',

  planner:
    'You are the planner in a long-running application harness. You create durable planning ' +
    'artifacts: a product spec, a feature backlog, and project principles. You never write ' +
    'implementation code. You think in terms of user-visible increments, not implementation steps.',

  generator:
    'You are the implementation agent in a long-running harness. You write production-grade ' +
    'code that fulfills the contract. Stay scoped to the current contract. Self-verify your ' +
    'work against every contract criterion before handing off. If relevant skills are ' +
    'available, invoke them to guide your choices.',

  evaluator:
    'You are a skeptical QA engineer. You test the running application, not just the code. ' +
    'You grade against anchored rubrics and never give inflated scores. A score of 3 means ' +
    '"competent but unremarkable." A 4 means genuinely good. A 5 is exceptional and rare. ' +
    'When Playwright MCP is available, you MUST use it to interact with the running app — ' +
    'do not pass a sprint based on code review alone.\n\n' +
    'IMPORTANT: The generator that will fix your bugs has NO browser access. Your eval ' +
    'report and saved evidence are its only window into the running app. For any visual ' +
    'or rendering bug, you MUST save concrete evidence (screenshots, DOM measurements) ' +
    'so the generator can see what you see.',
} as const;

// ---------------------------------------------------------------------------
// Universal criteria — type-agnostic definitions that the researcher's
// project-specific criteria refine.
// ---------------------------------------------------------------------------

const UNIVERSAL_RUBRICS: Record<string, { label: string; description: string; anchors: Record<string, string> }> = {
  conceptAlignment: {
    label: 'Concept Alignment',
    description: 'Does the output match the user\'s actual intent, including domain-specific meaning?',
    anchors: {
      '1': 'Fundamentally misunderstands the request. Builds the wrong thing.',
      '2': 'Superficial interpretation. Misses key domain concepts or terminology.',
      '3': 'Correct surface-level interpretation but misses deeper intent or nuance.',
      '4': 'Accurately captures intent including domain-specific meaning. Appropriate trade-offs.',
      '5': 'Deep understanding. Makes domain-informed decisions that surprise the user positively.',
    },
  },
  completeness: {
    label: 'Completeness',
    description: 'Are requirements met? Does it work end-to-end?',
    anchors: {
      '1': 'Core features broken or missing.',
      '2': 'Features present but incomplete. Missing error states, edge cases.',
      '3': 'All contract features work. Some rough edges.',
      '4': 'Thorough. Handles edge cases, clear affordances, good feedback.',
      '5': 'Comprehensive. Anticipates user needs, graceful degradation, keyboard accessible.',
    },
  },
  craft: {
    label: 'Craft',
    description: 'Is the implementation well-executed for its type? (What "craft" means is defined by project-specific criteria.)',
    anchors: {
      '1': 'Broken or incoherent execution.',
      '2': 'Works but quality is inconsistent. Obvious rough spots.',
      '3': 'Competent execution. No major issues.',
      '4': 'Polished. Consistent quality, clear attention to detail.',
      '5': 'Meticulous. Every detail is considered and deliberate.',
    },
  },
  intentionality: {
    label: 'Intentionality',
    description: 'Are there deliberate, thoughtful decisions vs. generic defaults and template patterns?',
    anchors: {
      '1': 'Pure defaults. Could be any AI-generated output.',
      '2': 'Minor customization on generic patterns.',
      '3': 'Some custom choices but recognizable as typical AI output.',
      '4': 'Distinctive choices that show real thought. Would not be confused for a template.',
      '5': 'Genuinely surprising decisions that feel authored by a domain expert.',
    },
  },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function jsonOnlyContract(example: string): string {
  return [
    'Your final response must be ONLY valid JSON.',
    'Do not wrap it in markdown fences.',
    `Use this shape: ${example}`,
  ].join(' ');
}

function smokeBlock(smoke: SmokeConfig, label: string): string {
  const lines: string[] = [];
  if (smoke.install) lines.push(`- Install: \`${smoke.install}\``);
  if (smoke.start) lines.push(`- Start dev server: \`${smoke.start}\``);
  if (smoke.test) lines.push(`- Run tests: \`${smoke.test}\``);
  if (lines.length === 0) return '';
  return `\n${label}:\n${lines.join('\n')}\n`;
}

/**
 * Build the evaluation rubric section from EvalCriteria.
 * Combines universal criteria definitions with project-specific criteria.
 */
function buildRubricSection(criteria: EvalCriteria | null): string {
  if (!criteria) {
    // Minimal fallback — shouldn't happen in normal flow
    return `Score each criterion 1-5. Use your best judgment on what matters for this project.`;
  }

  const sections: string[] = ['Score each criterion 1-5 using these anchored rubrics:\n'];

  // Universal criteria
  for (const [key, config] of Object.entries(criteria.universalCriteria)) {
    const rubric = UNIVERSAL_RUBRICS[key];
    if (!rubric) continue;
    const weight = config.weight;
    sections.push(`### ${key} — ${rubric.label} (weight: ${weight}, pass bar: ${config.passBar})`);
    sections.push(rubric.description);
    for (const [score, desc] of Object.entries(rubric.anchors)) {
      sections.push(`- ${score}: ${desc}`);
    }
    sections.push('');
  }

  // Project-specific criteria
  if (criteria.projectCriteria.length > 0) {
    sections.push('### Project-Specific Criteria\n');
    sections.push('These criteria are specific to this project. They were identified during the research phase.\n');
    for (const pc of criteria.projectCriteria) {
      sections.push(`### ${pc.id} — ${pc.name} (parent: ${pc.parentCriterion}, pass bar: ${pc.passBar})`);
      for (const [score, desc] of Object.entries(pc.rubric)) {
        sections.push(`- ${score}: ${desc}`);
      }
      sections.push('');
    }
  }

  // Passing bar summary
  const barLines: string[] = [];
  for (const [key, config] of Object.entries(criteria.universalCriteria)) {
    barLines.push(`- ${key} >= ${config.passBar}`);
  }
  for (const pc of criteria.projectCriteria) {
    barLines.push(`- ${pc.id} >= ${pc.passBar}`);
  }
  sections.push('## Passing Bar');
  sections.push(barLines.join('\n'));
  sections.push('- Every contract criterion satisfied');
  sections.push('- No high-severity bugs');
  sections.push('');
  sections.push('NOTE: The harness computes the pass/fail verdict from your scores. You do not write a verdict. Score each criterion honestly — the harness will determine whether the sprint passes based on these thresholds.');

  return sections.join('\n');
}

/**
 * Build the criteria summary for the contract prompt (names + thresholds only).
 */
function buildCriteriaSummary(criteria: EvalCriteria | null): string {
  if (!criteria) return '';

  const lines: string[] = ['Include a "Hard Thresholds" section with minimum scores:\n'];
  for (const [key, config] of Object.entries(criteria.universalCriteria)) {
    const rubric = UNIVERSAL_RUBRICS[key];
    const label = rubric ? ` (${rubric.description})` : '';
    lines.push(`- ${key} >= ${config.passBar}${label}`);
  }
  for (const pc of criteria.projectCriteria) {
    lines.push(`- ${pc.id} >= ${pc.passBar} (${pc.name})`);
  }
  return lines.join('\n');
}

function buildEvaluatorJsonExample(criteria: EvalCriteria | null): string {
  const scoreKeys = criteria
    ? [
        ...Object.keys(criteria.universalCriteria),
        ...criteria.projectCriteria.map((projectCriterion) => projectCriterion.id),
      ]
    : ['conceptAlignment', 'completeness', 'craft', 'intentionality'];

  const scores = Object.fromEntries(scoreKeys.map((key) => [key, 4]));
  return JSON.stringify({
    confidence: 'medium',
    evidenceQuality: 'adequate',
    summary: '...',
    scores,
    bugs: [],
    filesWritten: ['...'],
  });
}

function buildCanonicalContractExample(sprintNumber: number, feature: Feature, markdownPath: string): string {
  const example: CanonicalContract = {
    version: 1,
    sprint: sprintNumber,
    feature: {
      id: feature.id,
      title: feature.title,
    },
    inScope: ['Deliver the scoped sprint outcome'],
    outOfScope: ['Do not expand beyond the backlog item'],
    doneMeans: [
      {
        id: 'DM1',
        requirement: 'Concrete, testable requirement',
        verification: ['Exact command, URL, or interaction to run'],
        failConditions: ['Observable failure condition'],
        evidenceTargets: ['Screenshot, DOM state, file output, or CLI text to inspect'],
      },
    ],
    verificationSteps: ['One or more evaluator steps in execution order'],
    hardThresholds: ['conceptAlignment >= 4'],
    risksNotes: ['Known implementation risk or constraint'],
    sourceMarkdownPath: markdownPath,
  };
  return JSON.stringify(example, null, 2);
}

function buildCanonicalEvaluationExample(
  criteria: EvalCriteria | null,
  sprintNumber: number,
  evaluationRound: number,
  feature: Feature,
  markdownPath: string,
): string {
  const scoreKeys = criteria
    ? [
        ...Object.keys(criteria.universalCriteria),
        ...criteria.projectCriteria.map((projectCriterion) => projectCriterion.id),
      ]
    : ['conceptAlignment', 'completeness', 'craft', 'intentionality'];

  const example: CanonicalEvaluation = {
    version: 1,
    sprint: sprintNumber,
    evaluationRound,
    feature: {
      id: feature.id,
      title: feature.title,
    },
    confidence: 'medium',
    evidenceQuality: 'adequate',
    summary: 'Brief verdict summary',
    scores: Object.fromEntries(scoreKeys.map((key) => [key, 4])),
    contractCriteria: [
      {
        criterion: 'Done Means item summary',
        status: 'pass',
        evidence: ['path/to/evidence.png'],
        notes: 'Why this passed or failed',
      },
    ],
    projectPrinciples: [
      {
        criterion: 'Project principle summary',
        status: 'pass',
        evidence: ['path/to/evidence.txt'],
        notes: 'Why this passed or failed',
      },
    ],
    bugs: [
      {
        severity: 'high',
        title: 'Example bug title',
        repro: 'Exact repro steps',
        expected: 'Expected behavior',
        actual: 'Observed behavior',
        evidence: ['path/to/evidence.png'],
        rootCause: 'Diagnosis grounded in evidence',
        previousFixFailure: null,
      },
    ],
    suggestedRepairPlan: ['Concrete fix step'],
    notes: ['Any extra evaluator note'],
    sourceMarkdownPath: markdownPath,
    devSmoke: {
      required: true,
      ok: true,
      logPath: 'logs/dev-smoke-s01-r00.log',
      url: 'http://127.0.0.1:3000',
    },
  };
  return JSON.stringify(example, null, 2);
}

// ---------------------------------------------------------------------------
// Researcher
// ---------------------------------------------------------------------------

export function buildResearcherPrompt(context: PromptContext): string {
  return `You are the researcher in a long-running application harness.

Goal:
Deeply understand the user's request — especially domain-specific concepts, terminology,
and implicit expectations — then produce evaluation criteria that will guide all later phases.

Repository root: ${context.workspace}
Run artifact root: ${context.runDir}

Read the repository first so your research reflects what already exists.
Do NOT implement code.

If web search tools are available in this provider/runtime, use them to research:
- Domain-specific terms and concepts in the user's request
- What similar products/tools look like in this space
- Industry standards or expectations for this type of work
If web tools are NOT available, do the best repository-and-local-context research you can and note that limitation briefly in the research brief. Do not skip research. The planner and generator will rely on your domain understanding.

Write these files exactly:

1. ${context.paths.researchBrief}
   - What the user's request actually means, including domain context.
   - Key concepts and terminology the planner/generator must understand.
   - What "good" looks like for this type of work (reference real examples if possible).
   - What type of work this is (e.g., frontend app, backend API, CLI tool, AI-native app,
     data pipeline, full-stack, library, etc.).
   - Assumptions and risks — what might the generator misinterpret?

2. ${context.paths.evalCriteria}
   - Valid JSON with EXACTLY this shape:
   {
     "version": 1,
     "projectType": "description of work type",
     "universalCriteria": {
       "conceptAlignment": { "passBar": 4, "weight": "critical" },
       "completeness": { "passBar": 4, "weight": "high" },
       "craft": { "passBar": 3, "weight": "standard" },
       "intentionality": { "passBar": 4, "weight": "standard" }
     },
     "projectCriteria": [
       {
         "id": "camelCaseId",
         "name": "Human Readable Name",
         "parentCriterion": "which universal criterion this refines",
         "passBar": 4,
         "rubric": {
           "1": "What a 1 looks like for this criterion",
           "2": "What a 2 looks like",
           "3": "What a 3 looks like",
           "4": "What a 4 looks like",
           "5": "What a 5 looks like"
         }
       }
     ]
   }

   Rules for evaluation criteria:
   - universalCriteria MUST include all four keys: conceptAlignment, completeness, craft,
     intentionality. You may adjust passBar and weight based on the project type.
   - projectCriteria are specific to THIS project. Generate 2-5 criteria that capture what
     quality means for this particular type of work.
   - Each project criterion MUST have a parentCriterion that is one of the four universal keys.
   - Each rubric entry must be anchored — describe observable, testable conditions, not vague
     quality adjectives.
   - passBar should be calibrated: 3 = acceptable, 4 = good, 5 = exceptional.
   - weight must be one of: "critical", "high", "standard".

   Examples of good project criteria by work type:
   - Frontend app: visualDesign, accessibility, responsiveLayout
   - Backend API: schemaDesign, errorHandling, dataIntegrity
   - AI-native app: llmIntegration, adaptiveBehavior, promptQuality
   - CLI tool: cliUx, helpSystem, errorMessages
   - Data pipeline: dataCorrectness, performanceEfficiency, monitoring
   - Library: apiErgonomics, testCoverage, documentation

User request:
${context.userPrompt}

${jsonOnlyContract('{"status":"ok","summary":"...","filesWritten":["..."],"projectType":"...","criteriaCount":5}')}`;
}

// ---------------------------------------------------------------------------
// Planner
// ---------------------------------------------------------------------------

export function buildPlannerPrompt(context: PromptContext): string {
  const researchSection = `Read the research brief first — it contains domain context and terminology
that must inform your planning:
- ${context.paths.researchBrief}
- ${context.paths.evalCriteria}
`;

  return `You are the planner in a long-running application harness.

Goal:
Turn the user's request into durable planning artifacts that a generator and evaluator can use across many bounded sessions.

Repository root: ${context.workspace}
Run artifact root: ${context.runDir}

${researchSection}
Read the repository so the plan reflects what already exists.
Do NOT implement code yet.

Write these files exactly:

1. ${context.paths.spec}
   - High-level product spec.
   - Product goals, target users, core user journeys, non-goals, technical architecture, risks.
   - IMPORTANT: Incorporate the domain understanding from the research brief. If the research
     identified specific concepts or terminology, use them accurately in the spec.

2. ${context.paths.backlog}
   - Valid JSON with EXACTLY this shape:
   {
     "version": 1,
     "features": [
       {
         "id": "F01",
         "title": "Short feature title",
         "why": "Why it matters",
         "acceptanceCriteria": ["Concrete testable outcome"],
         "dependsOn": [],
         "status": "pending"
       }
     ]
   }

   Feature slicing rules:
   - Every feature MUST deliver a user-visible increment. A user should be able to open
     the app after each sprint and see meaningful new behavior.
   - NEVER create scaffolding-only features ("HTML boilerplate", "project setup").
     Combine scaffolding with the first user-visible feature.
   - Target 4-6 features for a typical app. More than 7 is almost certainly too granular.
   - Order features so the app is usable after each one, not just after all are done.
   - Use dependsOn to declare which features must be done before each one can start.

3. ${context.paths.projectPrinciples}
   - Concrete, testable project principles the evaluator can grade against.
   - These should align with the evaluation criteria from ${context.paths.evalCriteria}.
   - Cover whatever dimensions matter for THIS project type (the research brief identifies
     the project type and what quality means for it).
   - Each principle should be specific enough that two reviewers would agree on pass/fail.
   - If relevant skills are available, invoke them and incorporate their guidance.

User request:
${context.userPrompt}

${jsonOnlyContract('{"status":"ok","summary":"...","filesWritten":["..."],"featureCount":5}')}`;
}

// ---------------------------------------------------------------------------
// Contract negotiation — generator drafts, evaluator reviews
// ---------------------------------------------------------------------------

export function buildGeneratorDraftContractPrompt(
  context: PromptContext,
  feature: Feature,
  sprintNumber: number,
  negotiationRound: number,
  previousReviewPath: string | null,
): string {
  const criteriaSummary = buildCriteriaSummary(context.evalCriteria);
  const canonicalContractExample = buildCanonicalContractExample(
    sprintNumber,
    feature,
    context.currentContractPath!,
  );

  const revisionNote = negotiationRound > 0 && previousReviewPath
    ? `\nThis is revision round ${negotiationRound}. The evaluator rejected your previous draft.
Read their review: ${previousReviewPath}
Address EVERY piece of feedback. Do not ignore any feedback point. If you disagree with
a specific point, explain why in the Risks / Notes section, but still make a good-faith
effort to address it.\n`
    : '';

  return `You are drafting a sprint contract for the next feature you will implement.

Repository root: ${context.workspace}
${revisionNote}
You will implement this feature in the next phase, so draft a contract that is:
- Realistic about what you can accomplish in a single sprint
- Specific enough that an independent evaluator can objectively verify "done"
- Honest about scope boundaries — don't over-promise

Read these files before writing the contract:
- ${context.paths.prompt}
- ${context.paths.researchBrief}
- ${context.paths.spec}
- ${context.paths.backlog}
- ${context.paths.projectPrinciples}
- ${context.paths.progress}

Current feature:
- id: ${feature.id}
- title: ${feature.title}
- why: ${feature.why || ''}
- acceptanceCriteria: ${JSON.stringify(feature.acceptanceCriteria, null, 2)}
- dependsOn: ${JSON.stringify(feature.dependsOn || [])}

Write these files exactly:

1. ${context.currentContractPath}

2. ${context.currentContractJsonPath}
   - Valid JSON with EXACTLY this shape:
${canonicalContractExample}
   - \`sourceMarkdownPath\` MUST equal ${context.currentContractPath}
   - \`doneMeans\` MUST be the canonical representation of the markdown contract.
   - The markdown and JSON contracts must agree. If they differ, the JSON contract is treated as the canonical benchmark artifact.

Contract format:
# Sprint ${sprintNumber} Contract
## Feature
## In Scope
## Out of Scope
## Done Means
## Verification Steps
## Hard Thresholds
## Risks / Notes

For each "Done Means" criterion:
- What the evaluator should look for (file, URL endpoint, visual state)
- How to test it (command, Playwright action, manual check)
- What constitutes a fail

${criteriaSummary}

Keep the scope narrow enough for a single sprint.
${smokeBlock(context.config.smoke, 'Available smoke commands')}
${jsonOnlyContract('{"status":"ok","summary":"...","filesWritten":["..."],"contractPath":"...","contractJsonPath":"..."}')}`;
}

export function buildEvaluatorReviewContractPrompt(
  context: PromptContext,
  feature: Feature,
  sprintNumber: number,
  negotiationRound: number,
  draftContractPath: string,
  reviewPath: string,
): string {
  return `You are reviewing a sprint contract draft before implementation begins.

Repository root: ${context.workspace}

You will evaluate the implementation against this contract later, so make sure it is:
- Precise enough that you can objectively grade pass/fail on every "Done Means" criterion
- Complete — no missing edge cases or untested acceptance criteria from the backlog
- Appropriately scoped — neither so narrow that important behavior is excluded,
  nor so broad that a single sprint cannot realistically deliver

Read these files:
- ${draftContractPath}  (THE DRAFT CONTRACT — this is what you are reviewing)
- ${context.paths.prompt}
- ${context.paths.researchBrief}
- ${context.paths.spec}
- ${context.paths.backlog}
- ${context.paths.projectPrinciples}

Current feature:
- id: ${feature.id}
- title: ${feature.title}
- why: ${feature.why || ''}
- acceptanceCriteria: ${JSON.stringify(feature.acceptanceCriteria, null, 2)}

Review checklist — for each "Done Means" criterion ask:
1. Is it specific and objectively testable? (not "works well" but "responds within 2s")
2. Does it cover edge cases implied by the acceptance criteria?
3. Is the threshold appropriate — not so lenient it passes broken work,
   not so strict it fails acceptable work?
4. Are the verification steps concrete enough for you to execute with browser tooling / CLI?

Compare the draft against the feature's acceptanceCriteria in the backlog.
Flag any acceptance criterion that is NOT covered by a "Done Means" entry.

Write your review to: ${reviewPath}

If the contract is acceptable as-is, respond with status "approved".
If it needs revision, respond with status "revise" and list specific, actionable feedback.
Do NOT rewrite the contract yourself — provide feedback for the generator to address.

${jsonOnlyContract('{"status":"approved","summary":"...","feedback":[],"filesWritten":["..."]}')}
(Use status "revise" if changes are needed: {"status":"revise","summary":"...","feedback":["specific issue 1","specific issue 2"],"filesWritten":["..."]})`;
}

// ---------------------------------------------------------------------------
// Generator
// ---------------------------------------------------------------------------

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
  const commitInstruction = context.config.git.autoCommit
    ? `Create exactly one git commit when the sprint work is done. Use the message: sprint ${sprintNumber}: ${feature.id} ${feature.title}`
    : 'Do not create any git commits.';

  const smokeSection = smokeBlock(context.config.smoke, 'Smoke commands');

  const repairDirectiveNote = repairDirectivePath
    ? `\nCRITICAL — Read the repair directive: ${repairDirectivePath}
It lists every criterion that must improve, with rubric descriptions of your current
level and the target level. Focus on the largest gaps first. Do not regress passing criteria.
The repair directive is the authoritative source for why this repair round exists.
`
    : '';

  const repairNote = repairRound > 0
    ? `\nThis is repair round ${repairRound}. Read the previous evaluation report carefully and fix every issue it identified.
${repairDirectiveNote}
IMPORTANT — Evidence-based repair:
- The evaluator's evidence snapshot is frozen at: ${latestFrozenEvidenceDir || '(no frozen evidence snapshot found)'}
  Read these files (including images) to SEE what the evaluator saw. The evaluator has
  browser access but you do not — this evidence snapshot is your only visual window into the app.
- Treat the frozen evidence as read-only benchmark data. Do NOT modify, delete, or overwrite
  anything under that path.
- Before implementing the evaluator's suggested fix, verify the root cause is correct.
  The evaluator's diagnosis may be wrong. Check the measured DOM evidence (element
  dimensions, computed styles, attribute values) and the code to form your own diagnosis.
- If this is repair round 2+, review what previous fix attempts changed and why they
  failed. Do NOT retry the same approach. Try a fundamentally different strategy.
`
    : '';

  return `You are the generator / implementation agent in a long-running harness.

Repository root: ${context.workspace}
Run artifact root: ${context.runDir}
${repairNote}
Your job is to implement ONLY the current sprint contract.
Stay scoped. Avoid broad refactors unless they are necessary to satisfy the contract.

Read these files first:
- ${context.paths.prompt}
- ${context.paths.researchBrief}
- ${context.paths.spec}
- ${context.paths.backlog}
- ${context.paths.projectPrinciples}
- ${context.paths.progress}
- ${context.currentContractPath}
${context.currentContractJsonPath ? `- ${context.currentContractJsonPath}\n` : ''}${previousEvalPath ? `- ${previousEvalPath}  (LATEST EVAL — fix every issue listed here)\n${latestFrozenEvidenceDir ? `- ${latestFrozenEvidenceDir}/  (FROZEN EVIDENCE — screenshots and diagnostics from the evaluator. Read image files to see what the evaluator saw.)\n` : ''}` : ''}${allPriorEvalPaths.length > 1 ? `\nAll prior eval reports (read these to understand what fixes were already attempted):\n${allPriorEvalPaths.map((p, i) => `- ${p}  (round ${i})${allPriorFrozenEvidenceDirs[i] ? `\n- ${allPriorFrozenEvidenceDirs[i]}/  (frozen evidence snapshot for round ${i})` : ''}`).join('\n')}` : ''}

Current feature:
- id: ${feature.id}
- title: ${feature.title}
- acceptanceCriteria: ${JSON.stringify(feature.acceptanceCriteria, null, 2)}
- repairRound: ${repairRound}

Do this work:
1. Implement the feature in the repository.
   - If relevant skills are available, invoke them to guide your choices.
   - Aim for production-grade quality that matches the project principles.
2. Run focused validation for the feature.${smokeSection}
3. Self-check: re-read the contract and verify you addressed EVERY "Done Means" criterion.
   For each criterion, confirm it passes. If you find gaps, fix them now.
4. Update ${context.paths.progress} with what changed, commands you ran, and resume notes.
5. Update ${context.paths.nextHandoff} with the next most useful follow-up.
6. ${commitInstruction}

Important:
- If the contract cannot be completed as written, explain why in ${context.paths.progress}.
- Do not mark the feature done yourself. The evaluator decides.
- Keep the repository in a usable state.

${jsonOnlyContract('{"status":"ok","summary":"...","filesTouched":["..."],"commandsRun":["..."],"selfCheck":{"criteriaChecked":5,"gapsFound":0,"gapsFixed":[]},"commit":null,"risks":["..."]}')}`;
}

// ---------------------------------------------------------------------------
// Evaluator
// ---------------------------------------------------------------------------

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
  const smokeSection = smokeBlock(context.config.smoke, 'Available smoke commands');
  const evidenceDir = path.join(path.dirname(context.currentEvalPath!), 'evidence', `s${String(sprintNumber).padStart(2, '0')}-r${String(evaluationRound).padStart(2, '0')}`);
  const hasBrowserQa = capabilities.hasBrowserQa;
  const canonicalEvaluationExample = buildCanonicalEvaluationExample(
    context.evalCriteria,
    sprintNumber,
    evaluationRound,
    feature,
    context.currentEvalPath!,
  );

  const playwrightSection = devServerUrl && hasBrowserQa
    ? `
## Testing the Running Application
A dev server is running at ${devServerUrl}.
You have Playwright MCP available. You MUST:
1. Navigate to ${devServerUrl}
2. Take a full-page screenshot and study it
3. Click through every interactive element mentioned in the contract
4. Verify each acceptance criterion by interacting with the actual UI
5. Take screenshots of any bugs you find
Do NOT pass a sprint based only on code review. You must test the running application.

## Saving Evidence for the Generator
The generator has NO browser access and cannot see the running app. Your eval report is
its only source of truth. For every bug — especially visual or rendering bugs — you MUST
save concrete evidence so the generator can diagnose and fix without guessing.

Evidence directory: ${evidenceDir}

For each bug:
1. **Save a screenshot** to the evidence directory (e.g. \`${evidenceDir}/bug-01-description.png\`).
   Use Playwright to take targeted screenshots of the failing area.
2. **Capture DOM diagnostics** using browser_evaluate: measure the failing element's
   getBoundingClientRect(), computed CSS (width, height, display, visibility, overflow),
   and any relevant attribute values. Include these measurements in the bug report.
3. **Describe what you SEE vs what you expected.** Not just "it's broken" — describe the
   actual visual state ("chart area is empty, axes render but bars are invisible").
4. **If this is a repair round**, explain what the previous fix changed and specifically
   why it didn't work based on your measured evidence. Don't just say "still broken."

Reference saved evidence files in your bug reports so the generator can Read them.
`
    : devServerUrl
      ? `
## Testing the Running Application
A dev server is running at ${devServerUrl}.
Browser automation is not guaranteed in this provider/configuration. If browser tooling is
available, use it. Otherwise evaluate using smoke commands, focused CLI checks, HTTP requests,
and code review. Do NOT assume Playwright exists unless you can verify it in this runtime.
${smokeSection}`
      : `
## Testing
No dev server is running. Evaluate based on code review and any available commands.
${smokeSection}`;

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

  const rubricSection = buildRubricSection(context.evalCriteria);
  const evaluatorJsonExample = buildEvaluatorJsonExample(context.evalCriteria);

  return `You are the evaluator / QA in a long-running harness.

Repository root: ${context.workspace}
Run artifact root: ${context.runDir}

Your job is to verify whether the current sprint truly satisfies the contract.
Be skeptical. Prefer concrete bug reports over vague criticism.
${playwrightSection}
${previousVerdictSection}
Read these files:
- ${context.paths.prompt}
- ${context.paths.researchBrief}
- ${context.paths.spec}
- ${context.paths.backlog}
- ${context.paths.projectPrinciples}
- ${context.paths.progress}
- ${context.currentContractPath}
- ${context.paths.nextHandoff}

Current feature:
- id: ${feature.id}
- title: ${feature.title}
- acceptanceCriteria: ${JSON.stringify(feature.acceptanceCriteria, null, 2)}

Write this file exactly: ${context.currentEvalPath}

Write this canonical JSON file exactly: ${context.currentEvalJsonPath}
- Valid JSON with EXACTLY this shape:
${canonicalEvaluationExample}
- \`confidence\` MUST be one of: low, medium, high.
- \`evidenceQuality\` MUST be one of: weak, adequate, strong.
- \`sourceMarkdownPath\` MUST equal ${context.currentEvalPath}
- \`devSmoke\` MUST reflect the harness-run dev smoke result:
  - required: ${String(devSmoke.required)}
  - ok: ${String(devSmoke.ok)}
  - logPath: ${devSmoke.logPath || 'null'}
  - url: ${devSmoke.url || 'null'}
- Every bug's \`evidence\` array must reference saved files under ${evidenceDir}.

## Evaluation Criteria

${rubricSection}

Also grade against each project principle in ${context.paths.projectPrinciples}. Note any violations.

## Report format
# Sprint ${sprintNumber} Evaluation Round ${evaluationRound}
## Scorecard
(Score each criterion honestly. Do NOT write a pass/fail verdict — the harness computes the verdict from your scores.)
## Contract Criteria Check (each Done Means item: pass/fail with evidence)
## Project Principles Check (each principle: pass/fail)
## Bugs
For each bug include:
- severity / title / repro / expected / actual
- evidence: screenshot path(s) and DOM measurements saved to ${evidenceDir}
- root cause: your best diagnosis based on measured evidence (not speculation)
- if repair round: what the previous fix changed and why it didn't work
## Suggested Repair Plan
## Notes

## JSON Output Requirements
- In the final JSON, \`scores\` MUST include every universal criterion and every project-specific criterion id listed above.
- Do not omit project-specific scores just because they already appear in the markdown report.
- Missing score keys will be treated as a failed evaluation by the harness.
- Include \`confidence\` and \`evidenceQuality\` in the final JSON response as well.

${jsonOnlyContract(evaluatorJsonExample)}`;
}

// ---------------------------------------------------------------------------
// Context builder
// ---------------------------------------------------------------------------

export function createPromptContext(
  config: HarnessConfig,
  runState: RunState,
  capabilities: Record<'researcher' | 'planner' | 'generator' | 'evaluator', TaskCapabilities>,
  evalCriteria: EvalCriteria | null = null,
): PromptContext {
  const runDir = runState.runDir;
  return {
    config,
    roleProviders: runState.roleProviders,
    capabilities,
    workspace: config.workspace,
    runDir,
    userPrompt: runState.prompt,
    paths: {
      prompt: path.join(runDir, 'prompt.md'),
      researchBrief: path.join(runDir, 'plan', 'research-brief.md'),
      evalCriteria: path.join(runDir, 'plan', 'eval-criteria.json'),
      spec: path.join(runDir, 'plan', 'spec.md'),
      backlog: path.join(runDir, 'plan', 'backlog.json'),
      projectPrinciples: path.join(runDir, 'plan', 'project-principles.md'),
      progress: path.join(runDir, 'progress.md'),
      nextHandoff: path.join(runDir, 'handoff', 'next.md'),
      events: path.join(runDir, 'events.ndjson'),
    },
    currentContractPath: runState.currentContractPath,
    currentContractJsonPath: runState.currentContractJsonPath,
    currentEvalPath: runState.currentEvalPath,
    currentEvalJsonPath: runState.currentEvalJsonPath,
    evalCriteria,
  };
}
