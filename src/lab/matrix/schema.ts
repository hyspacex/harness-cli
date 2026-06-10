import type { HarnessEvalCase } from '../cases.js';
import type { EvalJudgeResult } from '../judge.js';
import type { EvalRunPacket } from '../packet.js';
import type { HarnessConfig, ProviderName } from '../../core/types.js';

export interface MatrixRunPlan {
  caseId: string;
  caseTitle: string;
  category: string;
  profile: string;
  profileDescription: string;
  prompt: string;
  isolationRoot: string;
  workspace: string;
  runRoot: string;
  command: string;
  configSummary: {
    provider: HarnessConfig['provider'];
    runtimeMode: HarnessConfig['runtimeMode'];
    roleProviders: HarnessConfig['roleProviders'];
    maxSprints: number;
    maxRepairRounds: number;
    maxNegotiationRounds: number;
    smoke: HarnessConfig['smoke'];
  };
}

export interface PlannedMatrixRun {
  evalCase: HarnessEvalCase;
  profileName: string;
  config: HarnessConfig;
  plan: MatrixRunPlan;
}

export interface MatrixPlanFile {
  version: number;
  builtAt: string;
  mode: string;
  profileSelection: string;
  /** Explicit cases dir, or null when the plan used the default lab/cases + evals/cases scan. */
  casesDir: string | null;
  /** Set when the plan came from a benchmark suite manifest. */
  suiteId?: string | null;
  runs: MatrixRunPlan[];
}

export interface PreparedMatrixRuns {
  outDir: string;
  execute: boolean;
  plannedRuns: PlannedMatrixRun[];
  plan: MatrixPlanFile;
}

export interface MatrixRunResult {
  caseId: string;
  profile: string;
  ok: boolean;
  status: string;
  runDir?: string;
  packetPath?: string;
  packetMarkdownPath?: string;
  error?: string;
  packetError?: string;
}

export interface PacketizedMatrixRun {
  evalCase: HarnessEvalCase;
  profileName: string;
  runResult: MatrixRunResult;
  packet: EvalRunPacket;
}

export interface MatrixComparisonResult {
  caseId: string;
  profileA: string;
  profileB: string;
  outDir: string;
  judge: string;
  winner: string;
  confidence: number;
  error?: string;
}

export interface MatrixResultFile {
  version: 1;
  builtAt: string;
  results: MatrixRunResult[];
  comparisons: MatrixComparisonResult[];
  shipGate: MatrixShipGate;
}

export type MatrixGateStatus = 'pass' | 'warning' | 'fail';

export interface MatrixShipGateCheck {
  id: string;
  status: MatrixGateStatus;
  message: string;
}

export interface MatrixShipGate {
  version: 1;
  status: MatrixGateStatus;
  ok: boolean;
  checks: MatrixShipGateCheck[];
}

export interface MatrixJudgeRequest {
  judgeProvider: ProviderName;
  prompt: string;
  evalCase: HarnessEvalCase;
  packetA: EvalRunPacket;
  packetB: EvalRunPacket;
}

export interface MatrixJudgeResponse {
  result: EvalJudgeResult;
  rawText: string | null;
}

export type MatrixJudgeRunner = (request: MatrixJudgeRequest) => Promise<MatrixJudgeResponse>;
