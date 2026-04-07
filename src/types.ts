// ---- Provider names & policies ----

export type ProviderName = 'claude-sdk' | 'codex';
export type ApprovalPolicy = 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always';
export type AgentRole = 'researcher' | 'planner' | 'generator' | 'evaluator';
export type ConfidenceLevel = 'low' | 'medium' | 'high';
export type EvidenceQuality = 'weak' | 'adequate' | 'strong';
export type RoleProviderMap = Record<AgentRole, ProviderName>;

// ---- SDK configuration ----

export interface McpServerConfig {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export type ClaudeSdkSystemPrompt =
  | string
  | {
      type: 'preset';
      preset: 'claude_code';
      append?: string;
    };

/** Per-role overrides merged on top of the base ClaudeSdkConfig. */
export interface ClaudeSdkRoleConfig {
  systemPrompt?: ClaudeSdkSystemPrompt;
  mcpServers?: Record<string, McpServerConfig>;
  allowedTools?: string[];
  settingSources?: Array<'user' | 'project'>;
  maxTurns?: number | null;
}

export interface ClaudeSdkConfig {
  model: string;
  permissionMode: string;
  mcpServers: Record<string, McpServerConfig>;
  allowedTools: string[];
  maxTurns: number | null;
  env: Record<string, string>;
  roleOverrides: Partial<Record<AgentRole, ClaudeSdkRoleConfig>>;
}

// ---- Codex App Server configuration ----

export type CodexSandboxMode = 'workspaceWrite' | 'readOnly' | 'dangerFullAccess';
export type CodexApprovalMode =
  | 'on-request'
  | 'untrusted'
  | 'never'
  | 'granular'
  | 'on-failure'
  | 'onRequest'
  | 'unlessTrusted';
export type CodexServiceTier = 'fast' | 'flex';

export interface CodexRoleConfig {
  model?: string | null;
  effort?: string | null;
  summary?: string | null;
  serviceTier?: CodexServiceTier | null;
}

export interface CodexConfig {
  command: string;
  args: string[];
  env: Record<string, string>;
  model: string | null;
  effort: string | null;
  summary: string | null;
  serviceTier: CodexServiceTier | null;
  sandboxMode: CodexSandboxMode;
  writableRoots: string[];
  networkAccess: boolean;
  approvalMode: CodexApprovalMode;
  assumePlaywrightMcp: boolean;
  roleOverrides: Partial<Record<AgentRole, CodexRoleConfig>>;
}

// ---- Harness-level config ----

export interface GitConfig {
  autoCommit: boolean;
}

export interface SmokeConfig {
  install: string | null;
  start: string | null;
  test: string | null;
  stop: string | null;
  startTimeout: number;
  startReadyPattern: string | null;
}

/** Named skills that can be auto-installed into the workspace. */
export interface SkillsConfig {
  [name: string]: string | null;
}

export interface HarnessConfig {
  provider: ProviderName;
  roleProviders: RoleProviderMap;
  workspace: string;
  runRoot: string;
  maxSprints: number;
  maxRepairRounds: number;
  maxNegotiationRounds: number;
  failFast: boolean;
  approvalPolicy: ApprovalPolicy;
  git: GitConfig;
  smoke: SmokeConfig;
  skills: SkillsConfig;
  claudeSdk: ClaudeSdkConfig;
  codex: CodexConfig;
}

// ---- Two-tier evaluation criteria ----

export type CriterionWeight = 'critical' | 'high' | 'standard';

export interface UniversalCriterionConfig {
  passBar: number;
  weight: CriterionWeight;
}

export interface ProjectCriterion {
  id: string;
  name: string;
  parentCriterion: string;
  passBar: number;
  rubric: Record<string, string>; // "1"–"5" anchored descriptions
}

export interface EvalCriteria {
  version: number;
  projectType: string;
  universalCriteria: Record<string, UniversalCriterionConfig>;
  projectCriteria: ProjectCriterion[];
}

// ---- Features & backlog ----

export interface Feature {
  id: string;
  title: string;
  why?: string;
  acceptanceCriteria: string[];
  dependsOn: string[];
  status: 'pending' | 'done' | 'blocked';
  completedAt?: string;
  blockedAt?: string;
}

export interface Backlog {
  version?: number;
  features: Feature[];
}

// ---- Contract negotiation ----

export interface NegotiationRound {
  round: number;
  draftPath: string;
  reviewPath: string | null;
  approved: boolean;
}

export interface NegotiationState {
  featureId: string;
  sprint: number;
  rounds: NegotiationRound[];
  finalContractPath: string | null;
  status: 'drafting' | 'reviewing' | 'approved' | 'exhausted';
  /** Pass bar overrides negotiated for this sprint. Keyed by criterion id. */
  passBarOverrides: Record<string, number>;
}

export interface ConfidenceCounts {
  low: number;
  medium: number;
  high: number;
  unknown: number;
}

export interface EvidenceQualityCounts {
  weak: number;
  adequate: number;
  strong: number;
  unknown: number;
}

export interface RoleProviderPerformanceMetrics {
  role: AgentRole;
  provider: ProviderName;
  tasksStarted: number;
  tasksFinished: number;
  parseSuccesses: number;
  parseFailures: number;
  contractApprovalAttempts: number;
  contractApprovalPasses: number;
  repairRoundsToPass: number[];
  finalRegressionFailures: number;
  devSmokePassed: number;
  devSmokeFailed: number;
  evaluatorConfidence: ConfidenceCounts;
  evidenceQuality: EvidenceQualityCounts;
}

export interface HarnessMetrics {
  completedFeatures: number;
  blockedFeatures: number;
  finalRegressionFailures: number;
  rolePerformance: Record<string, RoleProviderPerformanceMetrics>;
}

// ---- Run state ----

export interface RunState {
  id: string;
  prompt: string;
  provider: string;
  roleProviders: RoleProviderMap;
  workspace: string;
  runDir: string;
  createdAt: string;
  updatedAt: string;
  status: 'created' | 'planning' | 'running' | 'completed' | 'failed';
  lastError: string | null;
  sprint: number;
  repairRound: number;
  currentFeatureId: string | null;
  currentContractPath: string | null;
  currentContractJsonPath: string | null;
  currentEvalPath: string | null;
  currentEvalJsonPath: string | null;
  currentVerdictPath: string | null;
  summary: string | null;
  metrics: HarnessMetrics;
  /** Generator sessionId per sprint, used for repair-round resume. */
  generatorSessionIds: Record<number, string>;
  /** Tracks bilateral contract negotiation progress for resume support. */
  currentNegotiation: NegotiationState | null;
  /** Marker to avoid re-running install on every evaluator round. */
  smokeInstalledAt?: string | null;
}

// ---- Task / provider interface ----

export interface TaskDefinition {
  kind: AgentRole;
  label: string;
  cwd: string;
  prompt: string;
  capabilities?: TaskCapabilities;
  userPrompt?: string;
  sprintNumber?: number;
  repairRound?: number;
  evaluationRound?: number;
  feature?: Feature;
  approvalPolicy?: string;
  artifacts: Record<string, string>;
  /** Provider session/thread ID to resume (for generator repair rounds). */
  resumeSessionId?: string;
  /** Dev server URL passed to evaluator. */
  devServerUrl?: string;
}

export interface TaskResult {
  rawText: string;
  parsed: Record<string, unknown> | null;
  meta: { sessionId?: string; [key: string]: unknown };
}

export interface TaskCapabilities {
  role: AgentRole;
  provider: ProviderName;
  hasBrowserQa: boolean;
  supportsSessionResume: boolean;
}

export interface ProviderRuntime {
  runTask(task: TaskDefinition): Promise<TaskResult>;
}

export interface ProviderRegistry {
  runTask(task: TaskDefinition): Promise<TaskResult>;
  getProviderName(role: AgentRole): ProviderName;
  getTaskCapabilities(role: AgentRole): TaskCapabilities;
  getRouting(): RoleProviderMap;
}

export interface ProviderHooks {
  onStdErr?: (chunk: string, task?: TaskDefinition) => void;
  onUpdate?: (update: Record<string, unknown>, task?: TaskDefinition) => void;
}

// ---- Canonical contract / evaluation artifacts ----

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
  /** Pass bar overrides negotiated for this sprint. */
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

// ---- Prompt context ----

export interface PromptContext {
  config: HarnessConfig;
  roleProviders: RoleProviderMap;
  capabilities: Record<AgentRole, TaskCapabilities>;
  workspace: string;
  runDir: string;
  userPrompt: string;
  paths: {
    prompt: string;
    researchBrief: string;
    evalCriteria: string;
    spec: string;
    backlog: string;
    projectPrinciples: string;
    progress: string;
    nextHandoff: string;
    events: string;
  };
  currentContractPath: string | null;
  currentContractJsonPath: string | null;
  currentEvalPath: string | null;
  currentEvalJsonPath: string | null;
  /** Loaded from eval-criteria.json after the research phase. */
  evalCriteria: EvalCriteria | null;
}

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
