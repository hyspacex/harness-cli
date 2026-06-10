import path from 'node:path';
import { classifyCeremonyLevel, resolveCeremony, type CeremonyLevel } from './ceremony.js';
import {
  categorizeWork,
  recommendExecutionProfiles,
  resolveExecutionProfile,
  type WorkCategory,
} from './profiles.js';
import type {
  HarnessProfileConfig,
  RoleProviderPerformanceMetrics,
  RunState,
} from './types.js';
import { deepMerge, listDirectories, readJson } from './utils.js';

export interface RunHistoryEntry {
  runId: string;
  runDir: string;
  profile: string | null;
  status: 'completed' | 'failed';
  completed: boolean;
  category: WorkCategory;
  generatorProvider: string;
  ceremonyLevel: CeremonyLevel | 'unknown';
  /** Total provider tasks started across all roles — the run's measured cost proxy. */
  totalTasksStarted: number;
  /** Generator repair rounds needed per passed sprint (0 = first-round pass). */
  repairRoundsToPass: number[];
  contractApprovalAttempts: number;
  contractApprovalPasses: number;
  finalRegressionFailures: number;
}

export interface ProfileEvidence {
  profile: string;
  runs: number;
  completionRate: number;
  avgTasksStarted: number;
  firstRoundPassRate: number | null;
}

export interface EvidenceRecommendation {
  profiles: string[];
  source: 'evidence' | 'heuristic';
  category: WorkCategory;
  /** Which slice of history backed an evidence recommendation. */
  scope: 'category' | 'all-runs' | null;
  evidence: ProfileEvidence[];
}

const DEFAULT_MIN_RUNS = 2;
const DEFAULT_TOLERANCE = 0.15;

export async function loadRunHistory(
  runRoot: string,
  customProfiles: Record<string, HarnessProfileConfig> = {},
): Promise<RunHistoryEntry[]> {
  const runsDir = path.join(runRoot, 'runs');
  const runIds = await listDirectories(runsDir);
  const entries: RunHistoryEntry[] = [];

  for (const runId of runIds) {
    const runDir = path.join(runsDir, runId);
    const run = await readJson<RunState | null>(path.join(runDir, 'run.json'), null);
    if (!run || (run.status !== 'completed' && run.status !== 'failed')) {
      continue;
    }

    const rolePerformance = run.metrics?.rolePerformance || {};
    const roleMetrics = Object.values(rolePerformance) as RoleProviderPerformanceMetrics[];
    const generatorMetrics = roleMetrics.filter((metric) => metric.role === 'generator');
    const evaluatorMetrics = roleMetrics.filter((metric) => metric.role === 'evaluator');

    entries.push({
      runId: run.id,
      runDir,
      profile: run.executionProfile || null,
      status: run.status,
      completed: run.status === 'completed',
      category: categorizeWork({ prompt: run.prompt }),
      generatorProvider: run.roleProviders?.generator || run.provider,
      ceremonyLevel: ceremonyLevelForProfile(run.executionProfile, customProfiles),
      totalTasksStarted: roleMetrics.reduce((sum, metric) => sum + (metric.tasksStarted || 0), 0),
      repairRoundsToPass: generatorMetrics.flatMap((metric) => metric.repairRoundsToPass || []),
      contractApprovalAttempts: evaluatorMetrics.reduce(
        (sum, metric) => sum + (metric.contractApprovalAttempts || 0),
        0,
      ),
      contractApprovalPasses: evaluatorMetrics.reduce(
        (sum, metric) => sum + (metric.contractApprovalPasses || 0),
        0,
      ),
      finalRegressionFailures: run.metrics?.finalRegressionFailures || 0,
    });
  }

  return entries.sort((a, b) => a.runId.localeCompare(b.runId));
}

export function ceremonyLevelForProfile(
  profileName: string | null | undefined,
  customProfiles: Record<string, HarnessProfileConfig> = {},
): CeremonyLevel | 'unknown' {
  const ceremonyDefaults = {
    runtimeMode: 'full' as const,
    maxNegotiationRounds: 3,
    ceremony: {},
  };

  if (!profileName) {
    return classifyCeremonyLevel(resolveCeremony(ceremonyDefaults));
  }

  try {
    const profile = resolveExecutionProfile(profileName, customProfiles);
    const merged = deepMerge(ceremonyDefaults, {
      ...(profile.config.runtimeMode ? { runtimeMode: profile.config.runtimeMode } : {}),
      ...(profile.config.maxNegotiationRounds ? { maxNegotiationRounds: profile.config.maxNegotiationRounds } : {}),
      ...(profile.config.ceremony ? { ceremony: profile.config.ceremony } : {}),
    }) as typeof ceremonyDefaults;
    return classifyCeremonyLevel(resolveCeremony(merged));
  } catch {
    return 'unknown';
  }
}

export function summarizeProfileEvidence(entries: RunHistoryEntry[]): ProfileEvidence[] {
  const byProfile = new Map<string, RunHistoryEntry[]>();
  for (const entry of entries) {
    if (!entry.profile) continue;
    const existing = byProfile.get(entry.profile) || [];
    existing.push(entry);
    byProfile.set(entry.profile, existing);
  }

  return Array.from(byProfile.entries())
    .map(([profile, profileEntries]) => {
      const repairSamples = profileEntries.flatMap((entry) => entry.repairRoundsToPass);
      return {
        profile,
        runs: profileEntries.length,
        completionRate: ratio(
          profileEntries.filter((entry) => entry.completed).length,
          profileEntries.length,
        ),
        avgTasksStarted: mean(profileEntries.map((entry) => entry.totalTasksStarted)),
        firstRoundPassRate: repairSamples.length > 0
          ? ratio(repairSamples.filter((rounds) => rounds === 0).length, repairSamples.length)
          : null,
      };
    })
    .sort((a, b) => a.profile.localeCompare(b.profile));
}

/**
 * Evidence-first profile recommendation: prefer the cheapest profile whose
 * measured completion rate is within `tolerance` of the best, falling back to
 * the keyword heuristic when run history is too thin to compare profiles.
 */
export async function recommendProfilesWithEvidence(options: {
  runRoot: string;
  category?: string | null;
  prompt?: string | null;
  customProfiles?: Record<string, HarnessProfileConfig>;
  minRuns?: number;
  tolerance?: number;
}): Promise<EvidenceRecommendation> {
  const customProfiles = options.customProfiles || {};
  const category = categorizeWork({ category: options.category, prompt: options.prompt });
  const minRuns = options.minRuns ?? DEFAULT_MIN_RUNS;
  const tolerance = options.tolerance ?? DEFAULT_TOLERANCE;

  const heuristic: EvidenceRecommendation = {
    profiles: recommendExecutionProfiles({ category: options.category, prompt: options.prompt }),
    source: 'heuristic',
    category,
    scope: null,
    evidence: [],
  };

  let entries: RunHistoryEntry[];
  try {
    entries = await loadRunHistory(options.runRoot, customProfiles);
  } catch {
    return heuristic;
  }

  const usable = entries.filter(
    (entry) => entry.profile && isResolvableProfile(entry.profile, customProfiles),
  );

  for (const scope of ['category', 'all-runs'] as const) {
    const scoped = scope === 'category'
      ? usable.filter((entry) => entry.category === category)
      : usable;
    const evidence = summarizeProfileEvidence(scoped).filter((item) => item.runs >= minRuns);
    if (evidence.length < 2) continue;

    const best = evidence.reduce((a, b) => (b.completionRate > a.completionRate ? b : a));
    const withinTolerance = evidence.filter(
      (item) => item.completionRate >= best.completionRate - tolerance,
    );
    const cheapest = withinTolerance.reduce((a, b) => (b.avgTasksStarted < a.avgTasksStarted ? b : a));

    return {
      profiles: Array.from(new Set([cheapest.profile, best.profile])),
      source: 'evidence',
      category,
      scope,
      evidence,
    };
  }

  return heuristic;
}

function isResolvableProfile(
  name: string,
  customProfiles: Record<string, HarnessProfileConfig>,
): boolean {
  try {
    resolveExecutionProfile(name, customProfiles);
    return true;
  } catch {
    return false;
  }
}

function ratio(numerator: number, denominator: number): number {
  return denominator > 0 ? numerator / denominator : 0;
}

function mean(values: number[]): number {
  return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}
