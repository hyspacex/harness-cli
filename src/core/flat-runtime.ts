import type { Backlog, EvalCriteria } from './types.js';

export interface FlatRuntimeArtifactsInput {
  prompt: string;
  maxSprints: number;
  /** Runtime mode recorded in the bootstrapped artifacts. Defaults to 'flat'. */
  mode?: 'flat' | 'minimal';
}

export interface FlatRuntimeArtifacts {
  researchBrief: string;
  evalCriteria: EvalCriteria;
  spec: string;
  backlog: Backlog;
  projectPrinciples: string;
}

export function buildFlatRuntimeArtifacts(input: FlatRuntimeArtifactsInput): FlatRuntimeArtifacts {
  const prompt = normalizePrompt(input.prompt);
  const title = summarizePrompt(prompt);
  const promptBlock = fencedBlock(prompt);
  const maxSprints = Math.max(1, Math.trunc(input.maxSprints || 1));
  const mode = input.mode || 'flat';
  const modeTitle = mode === 'minimal' ? 'Minimal' : 'Flat';

  const evalCriteria: EvalCriteria = {
    version: 1,
    projectType: 'flat-runtime generator task',
    universalCriteria: {
      conceptAlignment: { passBar: 4, weight: 'critical' },
      completeness: { passBar: 4, weight: 'high' },
      craft: { passBar: 3, weight: 'standard' },
      intentionality: { passBar: 4, weight: 'standard' },
    },
    projectCriteria: [
      {
        id: 'artifactCompatibility',
        name: 'Artifact Compatibility',
        parentCriterion: 'completeness',
        passBar: 4,
        rubric: {
          '1': 'Required harness artifacts are missing or unreadable.',
          '2': 'Artifacts exist but are incomplete or inconsistent with the run.',
          '3': 'Core artifacts exist, with some weak traceability.',
          '4': 'Canonical artifacts are complete, consistent, and useful for audit.',
          '5': 'Artifacts provide exceptionally clear, reproducible audit evidence.',
        },
      },
      {
        id: 'verificationEvidence',
        name: 'Verification Evidence',
        parentCriterion: 'craft',
        passBar: 4,
        rubric: {
          '1': 'No meaningful verification was attempted.',
          '2': 'Verification is mostly asserted rather than reproduced.',
          '3': 'Focused checks were run, but coverage is thin.',
          '4': 'Verification directly exercises the requested behavior and is reproducible.',
          '5': 'Verification is comprehensive, minimal, and highly diagnostic.',
        },
      },
    ],
  };

  const backlog: Backlog = {
    version: 1,
    features: [
      {
        id: 'F01',
        title,
        why: 'The flat runtime collapses separate research and planning roles into one generator-owned delivery sprint.',
        acceptanceCriteria: [
          'Implement the user request in prompt.md without adding unrelated scope.',
          'Preserve the harness artifact contract: progress.md and handoff/next.md must be updated with concrete evidence.',
          'Run the most relevant deterministic validation available in the workspace, or document why no such command exists.',
        ],
        dependsOn: [],
        status: 'pending',
      },
    ],
  };

  return {
    researchBrief: [
      `# ${modeTitle} Runtime Research Brief`,
      '',
      `This run uses \`runtimeMode: ${mode}\`, so no separate researcher role executed.`,
      'The generator must treat prompt.md, repository inspection, and these bootstrap artifacts as the source of truth.',
      '',
      '## User Request',
      '',
      promptBlock,
      '',
      '## What Good Looks Like',
      '',
      '- The implementation is faithful to the user request and the existing repository shape.',
      '- The sprint contract turns the request into objective, independently verifiable criteria.',
      '- Validation evidence is captured in the normal harness artifacts so eval packetization works unchanged.',
      '',
      '## Risks',
      '',
      '- Domain nuance may be weaker than in the full researcher path.',
      '- The generator must avoid expanding scope while still making enough decisions to ship a coherent increment.',
      '- If the request requires specialized research, the contract should state that limitation instead of pretending it was performed.',
      '',
    ].join('\n'),
    evalCriteria,
    spec: [
      `# ${modeTitle} Runtime Spec`,
      '',
      'This profile intentionally skips separate researcher and planner task execution.',
      'The generator owns final decomposition through the sprint contract while the evaluator remains separate.',
      '',
      '## User Request',
      '',
      promptBlock,
      '',
      '## Scope',
      '',
      `- Deliver one generator-owned sprint within a maximum configured budget of ${maxSprints} sprint(s).`,
      '- Keep the implementation scoped to the request and the current contract.',
      '- Preserve all canonical harness artifacts expected by packetization and matrix reporting.',
      '',
      '## Out Of Scope',
      '',
      '- Broad architectural rewrites not required by the request.',
      '- Changes to eval packet schema or matrix reporting to accommodate this runtime mode.',
      '- Treating the flat bootstrap as a substitute for external research when the request explicitly needs it.',
      '',
      '## Verification',
      '',
      '- The evaluator must grade against the sprint contract and eval-criteria.json.',
      '- The generator must record commands and evidence in progress.md.',
      '- System B must be able to packetize the resulting run without Pi-specific or flat-runtime-specific branches.',
      '',
    ].join('\n'),
    backlog,
    projectPrinciples: [
      '# Project Principles',
      '',
      '1. Stay prompt-faithful: make decisions that directly serve the user request.',
      '2. Stay repository-native: follow existing code, command, and artifact conventions.',
      '3. Preserve auditability: every claim of completion needs a reproducible artifact or command.',
      '4. Keep scope tight: defer unrelated improvements instead of folding them into the sprint.',
      '',
    ].join('\n'),
  };
}

function normalizePrompt(prompt: string): string {
  return String(prompt || '').trim() || '(empty prompt)';
}

function summarizePrompt(prompt: string): string {
  const firstLine = prompt.split(/\r?\n/).map((line) => line.trim()).find(Boolean) || 'Requested outcome';
  const collapsed = firstLine.replace(/\s+/g, ' ');
  return collapsed.length > 80 ? `${collapsed.slice(0, 77)}...` : collapsed;
}

function fencedBlock(value: string): string {
  const fence = value.includes('```') ? '````' : '```';
  return `${fence}\n${value}\n${fence}`;
}
