export type ArtifactAgentRole = 'researcher' | 'planner' | 'generator' | 'evaluator';
export type ArtifactRoleProviderMap = Record<ArtifactAgentRole, string>;
export type ArtifactRunStatus = 'created' | 'planning' | 'running' | 'completed' | 'failed';
export type ArtifactMetrics = Record<string, unknown>;
export type ConfidenceLevel = 'low' | 'medium' | 'high';
export type EvidenceQuality = 'weak' | 'adequate' | 'strong';

export interface RunArtifactSummary {
  id: string;
  prompt?: string;
  provider: string;
  executionProfile: string | null;
  roleProviders: ArtifactRoleProviderMap;
  workspace: string;
  runDir: string;
  createdAt: string;
  updatedAt: string;
  status: ArtifactRunStatus;
  lastError: string | null;
  sprint: number;
  currentFeatureId: string | null;
  summary: string | null;
}

export interface RunArtifactBundle {
  rootDir: string;
  run: RunArtifactSummary;
  metrics: ArtifactMetrics | null;
}

export interface CanonicalContractCriterion {
  id: string;
  requirement: string;
  verification: string[];
  failConditions: string[];
  evidenceTargets?: string[];
}

export interface CanonicalContract {
  version: 1;
  sprint: number;
  feature: {
    id: string;
    title: string;
  };
  inScope: string[];
  outOfScope: string[];
  doneMeans: CanonicalContractCriterion[];
  verificationSteps: string[];
  hardThresholds: string[];
  risksNotes: string[];
  passBarOverrides?: Record<string, number>;
  sourceMarkdownPath: string;
}

export interface CanonicalEvaluationCriterionCheck {
  criterion: string;
  status: 'pass' | 'fail';
  evidence: string[];
  notes?: string;
}

export interface CanonicalEvaluationBug {
  severity: string;
  title: string;
  repro: string;
  expected: string;
  actual: string;
  evidence: string[];
  rootCause: string;
  previousFixFailure?: string | null;
}

export interface CanonicalEvaluation {
  version: 1;
  sprint: number;
  evaluationRound: number;
  feature: {
    id: string;
    title: string;
  };
  confidence: ConfidenceLevel;
  evidenceQuality: EvidenceQuality;
  summary: string;
  scores: Record<string, number>;
  contractCriteria: CanonicalEvaluationCriterionCheck[];
  projectPrinciples: CanonicalEvaluationCriterionCheck[];
  bugs: CanonicalEvaluationBug[];
  suggestedRepairPlan: string[];
  notes: string[];
  sourceMarkdownPath: string;
  devSmoke: {
    required: boolean;
    ok: boolean;
    logPath: string | null;
    url: string | null;
  };
}

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

export interface FrozenEvidenceManifest {
  version: 1;
  frozenAt: string;
  sourceDir: string;
  frozenDir: string;
  files: Array<{
    path: string;
    sha256: string;
    bytes?: number;
  }>;
}

export interface BenchmarkArtifactManifest {
  version: 1;
  updatedAt: string;
  artifacts: Array<{
    label: string;
    capturedAt: string;
    sourcePath: string;
    frozenPath: string;
    files: Array<{
      path: string;
      sha256: string;
      bytes?: number;
    }>;
  }>;
}
