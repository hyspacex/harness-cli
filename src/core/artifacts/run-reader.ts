import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  ArtifactMetrics,
  ArtifactRoleProviderMap,
  ArtifactRunStatus,
  RunArtifactBundle,
  RunArtifactSummary,
} from './schema.js';

const RUN_STATUSES = new Set<ArtifactRunStatus>(['created', 'planning', 'running', 'completed', 'failed']);
const ARTIFACT_ROLES = ['researcher', 'planner', 'generator', 'evaluator'] as const;

export async function readRunArtifactBundle(runDirInput: string): Promise<RunArtifactBundle> {
  const rootDir = path.resolve(runDirInput);
  const runValue = await readJsonUnknown(path.join(rootDir, 'run.json'));
  if (!isRecord(runValue)) {
    throw new Error(`Run artifact source is missing run.json: ${rootDir}`);
  }

  const metricsValue = await readJsonUnknown(path.join(rootDir, 'metrics.json'), null);
  const metrics = isRecord(metricsValue) ? metricsValue as ArtifactMetrics : null;
  return {
    rootDir,
    run: parseRunArtifactSummary(runValue, rootDir),
    metrics,
  };
}

export async function findLatestRunArtifactBundle(runRoot: string): Promise<RunArtifactBundle | null> {
  const runsDir = path.join(path.resolve(runRoot), 'runs');
  let entries: Array<{ name: string; isDirectory(): boolean }>;
  try {
    entries = await fs.readdir(runsDir, { withFileTypes: true });
  } catch {
    return null;
  }

  const bundles: RunArtifactBundle[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const runDir = path.join(runsDir, entry.name);
    if (!(await fileExists(path.join(runDir, 'run.json')))) {
      continue;
    }
    try {
      bundles.push(await readRunArtifactBundle(runDir));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Invalid run artifact at ${runDir}: ${message}`);
    }
  }

  return bundles.sort((a, b) => {
    const aTime = Date.parse(a.run.updatedAt || a.run.createdAt);
    const bTime = Date.parse(b.run.updatedAt || b.run.createdAt);
    return bTime - aTime;
  })[0] || null;
}

function parseRunArtifactSummary(value: Record<string, unknown>, rootDir: string): RunArtifactSummary {
  return {
    id: requiredString(value, 'id'),
    prompt: optionalString(value, 'prompt') ?? undefined,
    provider: requiredString(value, 'provider'),
    executionProfile: optionalString(value, 'executionProfile'),
    roleProviders: parseRoleProviders(value.roleProviders),
    workspace: requiredString(value, 'workspace'),
    runDir: optionalString(value, 'runDir') || rootDir,
    createdAt: requiredString(value, 'createdAt'),
    updatedAt: requiredString(value, 'updatedAt'),
    status: parseRunStatus(value.status),
    lastError: optionalString(value, 'lastError'),
    sprint: requiredNumber(value, 'sprint'),
    currentFeatureId: optionalString(value, 'currentFeatureId'),
    summary: optionalString(value, 'summary'),
  };
}

function parseRunStatus(value: unknown): ArtifactRunStatus {
  if (typeof value === 'string' && RUN_STATUSES.has(value as ArtifactRunStatus)) {
    return value as ArtifactRunStatus;
  }
  throw new Error(`Run artifact has invalid status: ${String(value)}`);
}

function parseRoleProviders(value: unknown): ArtifactRoleProviderMap {
  if (!isRecord(value)) {
    throw new Error('Run artifact roleProviders must be an object');
  }
  const result: Partial<ArtifactRoleProviderMap> = {};
  for (const role of ARTIFACT_ROLES) {
    const provider = value[role];
    if (typeof provider !== 'string' || !provider) {
      throw new Error(`Run artifact roleProviders.${role} must be a non-empty string`);
    }
    result[role] = provider;
  }
  return result as ArtifactRoleProviderMap;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readJsonUnknown(filePath: string, fallback?: unknown): Promise<unknown> {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8')) as unknown;
  } catch (error) {
    if (arguments.length >= 2) {
      return fallback;
    }
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

function requiredString(value: Record<string, unknown>, key: string): string {
  const item = value[key];
  if (typeof item !== 'string' || !item) {
    throw new Error(`Run artifact field ${key} must be a non-empty string`);
  }
  return item;
}

function optionalString(value: Record<string, unknown>, key: string): string | null {
  const item = value[key];
  if (item === undefined || item === null) {
    return null;
  }
  if (typeof item !== 'string') {
    throw new Error(`Run artifact field ${key} must be a string or null`);
  }
  return item;
}

function requiredNumber(value: Record<string, unknown>, key: string): number {
  const item = value[key];
  if (typeof item !== 'number' || !Number.isFinite(item)) {
    throw new Error(`Run artifact field ${key} must be a finite number`);
  }
  return item;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
