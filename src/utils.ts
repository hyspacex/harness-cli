import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { Backlog, CanonicalContract, EvalCriteria, Feature } from './types.js';

export function nowIso(): string {
  return new Date().toISOString();
}

export function slugify(value: string, fallback = 'run'): string {
  const slug = String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return slug || fallback;
}

export function newRunId(prompt: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `${stamp}-${slugify(prompt, 'run')}`;
}

export async function ensureDir(dirPath: string): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true });
}

export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function readText(filePath: string, fallback = ''): Promise<string> {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return fallback;
    }
    throw error;
  }
}

export async function writeText(filePath: string, content: string): Promise<void> {
  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, content, 'utf8');
}

export async function readJson<T>(filePath: string, fallback: T): Promise<T> {
  const text = await readText(filePath, '');
  if (!text) return fallback;
  return JSON.parse(text) as T;
}

export async function writeJson(filePath: string, data: unknown): Promise<void> {
  await writeText(filePath, `${JSON.stringify(data, null, 2)}\n`);
}

export async function copyTree(sourcePath: string, destinationPath: string): Promise<void> {
  await ensureDir(path.dirname(destinationPath));
  await fs.cp(sourcePath, destinationPath, { recursive: true, force: true });
}

export async function hashFile(filePath: string): Promise<string> {
  const content = await fs.readFile(filePath);
  return createHash('sha256').update(content).digest('hex');
}

export async function listFilesRecursive(rootPath: string): Promise<string[]> {
  if (!(await fileExists(rootPath))) {
    return [];
  }

  const entries = await fs.readdir(rootPath, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(rootPath, entry.name);
      if (entry.isDirectory()) {
        return listFilesRecursive(entryPath);
      }
      return [entryPath];
    }),
  );

  return files.flat().sort();
}

export async function appendNdjson(filePath: string, entry: Record<string, unknown>): Promise<void> {
  await ensureDir(path.dirname(filePath));
  await fs.appendFile(filePath, `${JSON.stringify(entry)}\n`, 'utf8');
}

export function deepMerge(base: unknown, override: unknown): unknown {
  if (Array.isArray(base) || Array.isArray(override)) {
    return override ?? base;
  }
  if (!isPlainObject(base) || !isPlainObject(override)) {
    return override ?? base;
  }

  const merged: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [key, value] of Object.entries(override as Record<string, unknown>)) {
    if (value === undefined) continue;
    merged[key] = key in merged ? deepMerge(merged[key], value) : value;
  }
  return merged;
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function toAbsolutePath(baseDir: string, maybeRelative: string): string {
  return path.isAbsolute(maybeRelative) ? maybeRelative : path.resolve(baseDir, maybeRelative);
}

export function relativeTo(baseDir: string, filePath: string): string {
  return path.relative(baseDir, filePath) || '.';
}

export function extractJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = String(text || '').trim();
  if (!trimmed) return null;

  const direct = tryParseJson(trimmed);
  if (direct) return direct;

  const fencedMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fencedMatch) {
    const fenced = tryParseJson(fencedMatch[1]);
    if (fenced) return fenced;
  }

  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    const candidate = trimmed.slice(firstBrace, lastBrace + 1);
    const parsed = tryParseJson(candidate);
    if (parsed) return parsed;
  }

  // Scan backward from lastBrace to find the last valid top-level JSON object.
  // This handles prose containing braces before the actual JSON output.
  if (lastBrace !== -1) {
    for (let i = lastBrace; i >= 0; i--) {
      if (trimmed[i] === '{') {
        const candidate = trimmed.slice(i, lastBrace + 1);
        const parsed = tryParseJson(candidate);
        if (parsed) return parsed;
      }
    }
  }

  return null;
}

function tryParseJson(text: string): Record<string, unknown> | null {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function validateBacklog(value: unknown): Backlog {
  if (!isPlainObject(value)) {
    throw new Error('backlog.json must be an object');
  }
  const features = (value as Record<string, unknown>).features;
  if (!Array.isArray(features) || features.length === 0) {
    throw new Error('backlog.json must contain a non-empty features array');
  }
  for (const feature of features) {
    if (!isPlainObject(feature)) {
      throw new Error('Each feature in backlog.json must be an object');
    }
    const f = feature as Record<string, unknown>;
    if (!f.id || !f.title) {
      throw new Error('Each feature must include id and title');
    }
    if (!Array.isArray(f.acceptanceCriteria)) {
      throw new Error(`Feature ${f.id} is missing acceptanceCriteria[]`);
    }
    if (!f.status) {
      f.status = 'pending';
    }
    if (!Array.isArray(f.dependsOn)) {
      f.dependsOn = [];
    }
  }
  return value as unknown as Backlog;
}

export function getNextPendingFeature(backlog: Backlog): Feature | null {
  const doneIds = new Set(
    backlog.features.filter((f) => f.status === 'done').map((f) => f.id),
  );
  return (
    backlog.features.find(
      (f) => f.status === 'pending' && f.dependsOn.every((dep) => doneIds.has(dep)),
    ) ?? null
  );
}

/**
 * Determine whether an evaluation passes using the two-tier criteria model.
 * The harness enforces thresholds itself rather than trusting the
 * evaluator's status field alone — this addresses evaluator leniency.
 */
export function resolvePass(
  parsedEval: Record<string, unknown> | null,
  criteria: EvalCriteria | null,
  passBarOverrides: Record<string, number> = {},
): boolean {
  if (!parsedEval) return false;
  if (!criteria) return false;

  const scores = isPlainObject(parsedEval.scores)
    ? (parsedEval.scores as Record<string, unknown>)
    : null;

  if (!scores) return false;

  for (const [key, config] of Object.entries(criteria.universalCriteria)) {
    const effectiveBar = Math.min(passBarOverrides[key] ?? config.passBar, config.passBar);
    const score = typeof scores[key] === 'number' ? (scores[key] as number) : null;
    if (score === null || score < effectiveBar) return false;
  }

  for (const pc of criteria.projectCriteria) {
    const effectiveBar = Math.min(passBarOverrides[pc.id] ?? pc.passBar, pc.passBar);
    const score = typeof scores[pc.id] === 'number' ? (scores[pc.id] as number) : null;
    if (score === null || score < effectiveBar) return false;
  }

  return true;
}

export function getFailingScores(
  parsedEval: Record<string, unknown> | null,
  criteria: EvalCriteria | null,
  passBarOverrides: Record<string, number> = {},
): { criterion: string; score: number; passBar: number }[] {
  if (!parsedEval || !criteria) return [];

  const scores = isPlainObject(parsedEval.scores)
    ? (parsedEval.scores as Record<string, unknown>)
    : null;
  if (!scores) return [];

  const failing: { criterion: string; score: number; passBar: number }[] = [];

  for (const [key, config] of Object.entries(criteria.universalCriteria)) {
    const effectiveBar = Math.min(passBarOverrides[key] ?? config.passBar, config.passBar);
    const score = typeof scores[key] === 'number' ? (scores[key] as number) : null;
    if (score === null || score < effectiveBar) {
      failing.push({ criterion: key, score: score ?? 0, passBar: effectiveBar });
    }
  }

  for (const pc of criteria.projectCriteria) {
    const effectiveBar = Math.min(passBarOverrides[pc.id] ?? pc.passBar, pc.passBar);
    const score = typeof scores[pc.id] === 'number' ? (scores[pc.id] as number) : null;
    if (score === null || score < effectiveBar) {
      failing.push({ criterion: pc.id, score: score ?? 0, passBar: effectiveBar });
    }
  }

  return failing;
}

export function getPassingScores(
  parsedEval: Record<string, unknown> | null,
  criteria: EvalCriteria | null,
  passBarOverrides: Record<string, number> = {},
): { criterion: string; score: number; passBar: number }[] {
  if (!parsedEval || !criteria) return [];

  const scores = isPlainObject(parsedEval.scores)
    ? (parsedEval.scores as Record<string, unknown>)
    : null;
  if (!scores) return [];

  const passing: { criterion: string; score: number; passBar: number }[] = [];

  for (const [key, config] of Object.entries(criteria.universalCriteria)) {
    const effectiveBar = Math.min(passBarOverrides[key] ?? config.passBar, config.passBar);
    const score = typeof scores[key] === 'number' ? (scores[key] as number) : null;
    if (score !== null && score >= effectiveBar) {
      passing.push({ criterion: key, score, passBar: effectiveBar });
    }
  }

  for (const pc of criteria.projectCriteria) {
    const effectiveBar = Math.min(passBarOverrides[pc.id] ?? pc.passBar, pc.passBar);
    const score = typeof scores[pc.id] === 'number' ? (scores[pc.id] as number) : null;
    if (score !== null && score >= effectiveBar) {
      passing.push({ criterion: pc.id, score, passBar: effectiveBar });
    }
  }

  return passing;
}

function buildBasePassBarMap(criteria: EvalCriteria | null): Record<string, number> {
  if (!criteria) return {};

  const bars: Record<string, number> = {};
  for (const [key, config] of Object.entries(criteria.universalCriteria)) {
    bars[key] = config.passBar;
  }
  for (const criterion of criteria.projectCriteria) {
    bars[criterion.id] = criterion.passBar;
  }
  return bars;
}

function parseHardThreshold(threshold: string): { criterion: string; passBar: number } | null {
  const match = threshold.match(/`?([A-Za-z][A-Za-z0-9_]*)`?\s*>=\s*(\d+)/);
  if (!match) return null;

  return {
    criterion: match[1],
    passBar: Number(match[2]),
  };
}

/**
 * Contracts express effective score gates twice:
 * - `hardThresholds`: the human-reviewed canonical list of thresholds
 * - `passBarOverrides`: the optional machine-readable deltas from the research defaults
 *
 * The harness historically only enforced `passBarOverrides`, which let the two drift out of
 * sync and produced incorrect verdicts. We now derive effective overrides from the canonical
 * hard-threshold list as well, then merge both representations conservatively.
 */
export function deriveContractPassBarOverrides(
  contract: CanonicalContract,
  criteria: EvalCriteria | null,
): Record<string, number> {
  const mergedOverrides: Record<string, number> = { ...(contract.passBarOverrides ?? {}) };
  const basePassBars = buildBasePassBarMap(criteria);

  for (const threshold of contract.hardThresholds) {
    const parsed = parseHardThreshold(threshold);
    if (!parsed) continue;

    const basePassBar = basePassBars[parsed.criterion];
    if (typeof basePassBar !== 'number') continue;

    const effectivePassBar = Math.min(parsed.passBar, basePassBar);
    if (effectivePassBar >= basePassBar) continue;

    const existingOverride = mergedOverrides[parsed.criterion];
    mergedOverrides[parsed.criterion] = typeof existingOverride === 'number'
      ? Math.min(existingOverride, effectivePassBar)
      : effectivePassBar;
  }

  return mergedOverrides;
}

export function truncate(text: string, maxLength = 240): string {
  const value = String(text || '');
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}…`;
}

export async function listDirectories(dirPath: string): Promise<string[]> {
  if (!(await fileExists(dirPath))) {
    return [];
  }
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort()
    .reverse();
}
