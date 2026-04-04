// ---- Provider names & policies ----

export type ProviderName = 'claude-sdk' | 'codex';
export type ApprovalPolicy = 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always';
export type AgentRole = 'researcher' | 'planner' | 'generator' | 'evaluator';

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
export type CodexApprovalMode = 'onRequest' | 'unlessTrusted' | 'never';
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
}

// ---- Run state ----

export interface RunState {
  id: string;
  prompt: string;
  provider: string;
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
  currentEvalPath: string | null;
  summary: string | null;
  metrics: {
    completedFeatures: number;
    blockedFeatures: number;
  };
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

export interface Provider {
  runTask(task: TaskDefinition): Promise<TaskResult>;
}

export interface ProviderHooks {
  onStdErr?: (chunk: string, task?: TaskDefinition) => void;
  onUpdate?: (update: Record<string, unknown>, task?: TaskDefinition) => void;
}

// ---- Prompt context ----

export interface PromptContext {
  config: HarnessConfig;
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
  currentEvalPath: string | null;
  /** Loaded from eval-criteria.json after the research phase. */
  evalCriteria: EvalCriteria | null;
}
