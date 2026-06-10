import type { CanonicalContract, Feature } from './types.js';

export interface HarnessAuthoredContractInput {
  feature: Feature;
  sprint: number;
  contractMarkdownPath: string;
  /** Smoke commands configured for the run, used to make verification steps concrete. */
  smoke?: { start?: string | null; test?: string | null };
}

export interface HarnessAuthoredContract {
  markdown: string;
  contract: CanonicalContract;
}

/**
 * Deterministically author a sprint contract from the feature's acceptance
 * criteria when ceremony.negotiationRounds is 0. No model call is involved and
 * no passBarOverrides are produced, so the harness verdict applies the
 * unmodified pass bars from eval-criteria.json.
 */
export function buildHarnessAuthoredContract(input: HarnessAuthoredContractInput): HarnessAuthoredContract {
  const { feature, sprint } = input;
  const acceptanceCriteria = feature.acceptanceCriteria.length > 0
    ? feature.acceptanceCriteria
    : [`Deliver the feature: ${feature.title}`];

  const verificationSteps = [
    ...(input.smoke?.start ? [`Start the app with \`${input.smoke.start}\` and confirm it responds.`] : []),
    ...(input.smoke?.test ? [`Run \`${input.smoke.test}\` and confirm it passes.`] : []),
    'Run the most relevant deterministic validation available in the workspace, or document why none exists.',
    'Record commands and evidence in progress.md so the evaluator can reproduce every claim.',
  ];

  const contract: CanonicalContract = {
    version: 1,
    sprint,
    feature: {
      id: feature.id,
      title: feature.title,
    },
    inScope: acceptanceCriteria,
    outOfScope: ['Work not required by the acceptance criteria above.'],
    doneMeans: acceptanceCriteria.map((criterion, index) => ({
      id: `AC${String(index + 1).padStart(2, '0')}`,
      requirement: criterion,
      verification: ['Demonstrate the behavior with reproducible evidence (command output, test result, or screenshot).'],
      failConditions: ['The behavior is missing, broken, or only asserted without evidence.'],
    })),
    verificationSteps,
    hardThresholds: ['Every required evaluation criterion must meet its configured pass bar; the harness verdict is not negotiable.'],
    risksNotes: [
      'Contract authored by the harness (ceremony.negotiationRounds = 0). The generator did not negotiate scope or pass bars.',
    ],
    sourceMarkdownPath: input.contractMarkdownPath,
  };

  const markdown = [
    `# Sprint ${sprint} Contract: ${feature.id} ${feature.title}`,
    '',
    'This contract was authored by the harness because contract negotiation is dialed to zero rounds.',
    'Pass bars come unmodified from plan/eval-criteria.json.',
    '',
    '## In Scope',
    '',
    ...acceptanceCriteria.map((criterion) => `- ${criterion}`),
    '',
    '## Out of Scope',
    '',
    '- Work not required by the acceptance criteria above.',
    '',
    '## Done Means',
    '',
    ...contract.doneMeans.map((entry) => `- ${entry.id}: ${entry.requirement}`),
    '',
    '## Verification Steps',
    '',
    ...verificationSteps.map((step) => `- ${step}`),
    '',
    '## Hard Thresholds',
    '',
    ...contract.hardThresholds.map((item) => `- ${item}`),
    '',
  ].join('\n');

  return { markdown, contract };
}
