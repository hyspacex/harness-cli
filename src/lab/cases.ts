import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  fileExists,
  isPlainObject,
  listFilesRecursive,
  readJson,
} from '../core/utils.js';

/** Lab-owned cases take precedence over product-facing example cases on id collision. */
const DEFAULT_CASES_DIRS = ['lab/cases', 'evals/cases'];

export interface EvalObjectiveCheck {
  id?: string;
  command?: string;
  argv?: string[];
  cwd?: string;
  timeoutMs?: number;
  required?: boolean;
  expectedExitCode?: number;
  stdoutIncludes?: string[];
  stderrIncludes?: string[];
  outputIncludes?: string[];
}

export interface EvalJudgeRubricDimension {
  id: string;
  name?: string;
  description: string;
  weight?: 'critical' | 'high' | 'standard';
}

export interface EvalJudgeRubric {
  version: 1;
  scale: Record<string, string>;
  dimensions: EvalJudgeRubricDimension[];
  criticalRequirements?: string[];
  scoringNotes?: string[];
}

export interface HarnessEvalCase {
  version: 1;
  id: string;
  title?: string;
  category: string;
  prompt: string;
  workspaceFixture?: string;
  harnessConfig?: Record<string, unknown>;
  objectiveChecks?: EvalObjectiveCheck[];
  judgeFocus?: string[];
  judgeRubric: EvalJudgeRubric;
  notes?: string;
}

export interface EvalCaseSummary {
  id: string;
  title: string;
  category: string;
  path: string;
}

/** A fixed list of eval cases and profiles to run as one benchmark grid. */
export interface BenchmarkSuite {
  version: 1;
  id: string;
  description?: string;
  cases: string[];
  profiles: string[];
}

export async function listEvalCases(casesDir?: string | null): Promise<EvalCaseSummary[]> {
  const summariesById = new Map<string, EvalCaseSummary>();
  for (const dir of resolveCasesDirs(casesDir)) {
    const absoluteCasesDir = path.resolve(dir);
    if (!(await fileExists(absoluteCasesDir))) {
      continue;
    }

    const files = (await listFilesRecursive(absoluteCasesDir)).filter((filePath) => filePath.endsWith('.json'));
    for (const filePath of files) {
      try {
        const evalCase = await readEvalCase(filePath);
        if (summariesById.has(evalCase.id)) {
          continue;
        }
        summariesById.set(evalCase.id, {
          id: evalCase.id,
          title: evalCase.title || evalCase.id,
          category: evalCase.category,
          path: filePath,
        });
      } catch {
        // Ignore malformed drafts in the case directory; direct reads still report errors.
      }
    }
  }
  return [...summariesById.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/** An explicit cases dir scans only that dir; the default scans lab/cases then evals/cases. */
function resolveCasesDirs(casesDir?: string | null): string[] {
  return casesDir ? [casesDir] : DEFAULT_CASES_DIRS;
}

export const DEFAULT_BENCHMARK_SUITE_PATH = 'lab/suites/ceremony-ladder-v1.json';

export async function readBenchmarkSuite(filePath = DEFAULT_BENCHMARK_SUITE_PATH): Promise<BenchmarkSuite> {
  const absolutePath = path.resolve(filePath);
  const value = await readJson<unknown>(absolutePath, null);
  if (!isPlainObject(value)) {
    throw new Error(`Benchmark suite not found or not a JSON object: ${absolutePath}`);
  }
  if (value.version !== 1) {
    throw new Error(`Benchmark suite version must be 1: ${absolutePath}`);
  }
  if (typeof value.id !== 'string' || !value.id) {
    throw new Error(`Benchmark suite is missing id: ${absolutePath}`);
  }
  for (const field of ['cases', 'profiles'] as const) {
    const items = value[field];
    if (!Array.isArray(items) || items.length === 0 || !items.every((item) => typeof item === 'string' && item)) {
      throw new Error(`Benchmark suite ${value.id} ${field} must be a non-empty array of strings`);
    }
  }
  return value as unknown as BenchmarkSuite;
}

export async function findEvalCase(ref: string, casesDir?: string | null): Promise<HarnessEvalCase> {
  const directPath = path.resolve(ref);
  if (await fileExists(directPath)) {
    return readEvalCase(directPath);
  }

  for (const dir of resolveCasesDirs(casesDir)) {
    const namedPath = path.resolve(dir, ref.endsWith('.json') ? ref : `${ref}.json`);
    if (await fileExists(namedPath)) {
      return readEvalCase(namedPath);
    }
  }

  throw new Error(`Eval case not found: ${ref}`);
}

export async function readEvalCase(filePath: string): Promise<HarnessEvalCase> {
  const value = await readJson<unknown>(filePath, null);
  if (!isPlainObject(value)) {
    throw new Error(`Eval case must be a JSON object: ${filePath}`);
  }

  if (value.version !== 1) {
    throw new Error(`Eval case version must be 1: ${filePath}`);
  }
  if (typeof value.id !== 'string' || !value.id) {
    throw new Error(`Eval case is missing id: ${filePath}`);
  }
  if (typeof value.category !== 'string' || !value.category) {
    throw new Error(`Eval case ${value.id} is missing category`);
  }
  if (typeof value.prompt !== 'string' || !value.prompt) {
    throw new Error(`Eval case ${value.id} is missing prompt`);
  }

  const checks = value.objectiveChecks;
  if (checks !== undefined) {
    if (!Array.isArray(checks)) {
      throw new Error(`Eval case ${value.id} objectiveChecks must be an array`);
    }
    for (const check of checks) {
      if (!isPlainObject(check)) {
        throw new Error(`Eval case ${value.id} contains an invalid objective check`);
      }
      const hasCommand = typeof check.command === 'string' && check.command.length > 0;
      const hasArgv = Array.isArray(check.argv) && check.argv.length > 0 && check.argv.every((item) => typeof item === 'string' && item.length > 0);
      if (!hasCommand && !hasArgv) {
        throw new Error(`Eval case ${value.id} objective check must provide either "command" (string) or "argv" (non-empty string[])`);
      }
      if (check.argv !== undefined && !hasArgv) {
        throw new Error(`Eval case ${value.id} objective check argv must be a non-empty array of non-empty strings`);
      }
      if (check.cwd !== undefined) {
        if (typeof check.cwd !== 'string' || check.cwd.length === 0) {
          throw new Error(`Eval case ${value.id} objective check cwd must be a non-empty string`);
        }
        if (path.isAbsolute(check.cwd)) {
          throw new Error(`Eval case ${value.id} objective check cwd must be relative to the workspace, got "${check.cwd}"`);
        }
      }
      if (check.expectedExitCode !== undefined && typeof check.expectedExitCode !== 'number') {
        throw new Error(`Eval case ${value.id} objective check expectedExitCode must be a number`);
      }
      for (const field of ['stdoutIncludes', 'stderrIncludes', 'outputIncludes'] as const) {
        const needles = check[field];
        if (needles !== undefined && (!Array.isArray(needles) || !needles.every((item) => typeof item === 'string'))) {
          throw new Error(`Eval case ${value.id} objective check ${field} must be an array of strings`);
        }
      }
    }
  }
  validateJudgeRubric(value.id, value.judgeRubric);

  return value as unknown as HarnessEvalCase;
}

function validateJudgeRubric(caseId: unknown, value: unknown): void {
  const id = typeof caseId === 'string' ? caseId : '(unknown)';
  if (!isPlainObject(value)) {
    throw new Error(`Eval case ${id} is missing judgeRubric`);
  }
  if (value.version !== 1) {
    throw new Error(`Eval case ${id} judgeRubric version must be 1`);
  }
  if (!isPlainObject(value.scale) || Object.keys(value.scale).length === 0) {
    throw new Error(`Eval case ${id} judgeRubric.scale must be a non-empty object`);
  }
  for (const [score, meaning] of Object.entries(value.scale)) {
    if (!/^[1-5]$/.test(score) || typeof meaning !== 'string' || !meaning) {
      throw new Error(`Eval case ${id} judgeRubric.scale contains an invalid score anchor`);
    }
  }

  if (!Array.isArray(value.dimensions) || value.dimensions.length === 0) {
    throw new Error(`Eval case ${id} judgeRubric.dimensions must be a non-empty array`);
  }
  const dimensionIds = new Set<string>();
  for (const dimension of value.dimensions) {
    if (!isPlainObject(dimension)) {
      throw new Error(`Eval case ${id} judgeRubric contains an invalid dimension`);
    }
    if (typeof dimension.id !== 'string' || !/^[a-z][A-Za-z0-9]*$/.test(dimension.id)) {
      throw new Error(`Eval case ${id} judgeRubric dimension has an invalid id`);
    }
    if (dimensionIds.has(dimension.id)) {
      throw new Error(`Eval case ${id} judgeRubric dimension id is duplicated: ${dimension.id}`);
    }
    dimensionIds.add(dimension.id);
    if (typeof dimension.description !== 'string' || !dimension.description) {
      throw new Error(`Eval case ${id} judgeRubric dimension ${dimension.id} is missing description`);
    }
    if (
      dimension.weight !== undefined &&
      dimension.weight !== 'critical' &&
      dimension.weight !== 'high' &&
      dimension.weight !== 'standard'
    ) {
      throw new Error(`Eval case ${id} judgeRubric dimension ${dimension.id} has invalid weight`);
    }
  }

  for (const field of ['criticalRequirements', 'scoringNotes'] as const) {
    const items = value[field];
    if (items === undefined) continue;
    if (!Array.isArray(items) || !items.every((item) => typeof item === 'string' && item)) {
      throw new Error(`Eval case ${id} judgeRubric.${field} must contain only non-empty strings`);
    }
  }
}

export function computeEvaluationSpecHash(evalCase: HarnessEvalCase): string {
  return createHash('sha256')
    .update(canonicalJson({
      version: evalCase.version,
      id: evalCase.id,
      prompt: evalCase.prompt,
      objectiveChecks: evalCase.objectiveChecks || [],
      judgeRubric: evalCase.judgeRubric,
    }))
    .digest('hex');
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortJsonValue(value));
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sortJsonValue(item));
  }
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, sortJsonValue(item)]),
    );
  }
  return value;
}
