import fs from 'node:fs/promises';
import path from 'node:path';
import { buildOverrides, flagEnabled } from '../../cli-flags.js';
import { loadConfig } from '../../core/config.js';
import {
  DEFAULT_BENCHMARK_SUITE_PATH,
  findEvalCase,
  listEvalCases,
  readBenchmarkSuite,
  type HarnessEvalCase,
} from '../cases.js';
import { recommendProfilesWithEvidence } from '../../core/history.js';
import { expandExecutionProfileSelection, resolveExecutionProfile } from '../../core/profiles.js';
import type { HarnessConfig } from '../../core/types.js';
import {
  deepMerge,
  ensureDir,
  fileExists,
  slugify,
  writeJson,
  writeText,
} from '../../core/utils.js';
import type {
  MatrixPlanFile,
  MatrixRunPlan,
  PlannedMatrixRun,
  PreparedMatrixRuns,
} from './schema.js';

const MATRIX_COPY_EXCLUDE_DIRS = new Set(['.git', '.harness', 'node_modules', 'dist', 'coverage']);

export async function prepareMatrixRuns(
  flags: Record<string, string>,
  positionals: string[],
): Promise<PreparedMatrixRuns> {
  const casesDir = flags.cases || 'evals/cases';
  const suite = flags.suite
    ? await readBenchmarkSuite(flags.suite === 'true' ? DEFAULT_BENCHMARK_SUITE_PATH : flags.suite)
    : null;
  const evalCases = suite
    ? await Promise.all(suite.cases.map((caseRef) => findEvalCase(caseRef, casesDir)))
    : await resolveMatrixCases(flags, positionals, casesDir);
  if (evalCases.length === 0) {
    throw new Error('No eval cases selected.');
  }

  const execute = flagEnabled(flags, 'execute');
  if (execute && flagEnabled(flags, 'dry-run')) {
    throw new Error('Use either --execute true or --dry-run true, not both.');
  }

  const builtAt = new Date().toISOString();
  const outDir = path.resolve(
    flags.out ||
      path.join(
        '.harness',
        'evals',
        `${builtAt.replace(/[:.]/g, '-')}-matrix`,
      ),
  );
  const { config: baseConfig } = await loadConfig(flags.config, buildOverrides(flags));
  const selection = suite
    ? suite.profiles.join(',')
    : flags.profiles || flags.profile || 'adaptive';
  const plannedRuns: PlannedMatrixRun[] = [];

  for (const evalCase of evalCases) {
    const profileNames = await resolveProfileSelection(selection, evalCase, baseConfig);

    for (const profileName of profileNames) {
      const profile = resolveExecutionProfile(profileName, baseConfig.profiles);
      const caseSlug = slugify(evalCase.id);
      const profileSlug = slugify(profileName);
      const isolationRoot = path.join(outDir, 'isolates', caseSlug, profileSlug);
      const workspace = await resolveMatrixWorkspace({
        evalCase,
        baseWorkspace: baseConfig.workspace,
        isolationRoot,
        execute,
        flags,
      });
      const runRoot = flags['run-root']
        ? path.join(path.resolve(flags['run-root']), caseSlug, profileSlug)
        : path.join(isolationRoot, 'run-root');
      const caseOverrides = (evalCase.harnessConfig || {}) as Partial<HarnessConfig>;
      const matrixOverrides = deepMerge(
        caseOverrides,
        {
          ...buildOverrides(flags),
          workspace,
          runRoot,
        } satisfies Partial<HarnessConfig>,
      ) as Partial<HarnessConfig>;
      const { config } = await loadConfig(flags.config, matrixOverrides, { profile: profileName });
      const plan: MatrixRunPlan = {
        caseId: evalCase.id,
        caseTitle: evalCase.title || evalCase.id,
        category: evalCase.category,
        profile: profileName,
        profileDescription: profile.description,
        prompt: evalCase.prompt,
        isolationRoot,
        workspace: config.workspace,
        runRoot: config.runRoot,
        command: renderMatrixRunCommand(evalCase, profileName, outDir, flags),
        configSummary: {
          provider: config.provider,
          runtimeMode: config.runtimeMode,
          roleProviders: config.roleProviders,
          maxSprints: config.maxSprints,
          maxRepairRounds: config.maxRepairRounds,
          maxNegotiationRounds: config.maxNegotiationRounds,
          smoke: config.smoke,
        },
      };
      plannedRuns.push({ evalCase, profileName, config, plan });
    }
  }

  const plan: MatrixPlanFile = {
    version: 1,
    builtAt,
    mode: execute ? 'execute' : 'dry-run',
    profileSelection: selection,
    casesDir: path.resolve(casesDir),
    suiteId: suite?.id || null,
    runs: plannedRuns.map((run) => run.plan),
  };

  await ensureDir(outDir);
  await writeJson(path.join(outDir, 'matrix-plan.json'), plan);
  await writeText(path.join(outDir, 'matrix-plan.md'), renderMatrixPlanMarkdown(plan));

  return { outDir, execute, plannedRuns, plan };
}

async function resolveProfileSelection(
  selection: string,
  evalCase: HarnessEvalCase,
  baseConfig: HarnessConfig,
): Promise<string[]> {
  if (selection !== 'adaptive') {
    return expandExecutionProfileSelection(
      selection,
      { category: evalCase.category, prompt: evalCase.prompt },
      baseConfig.profiles,
    );
  }

  const recommendation = await recommendProfilesWithEvidence({
    runRoot: baseConfig.runRoot,
    category: evalCase.category,
    prompt: evalCase.prompt,
    customProfiles: baseConfig.profiles,
  });
  const sourceLabel = recommendation.source === 'evidence'
    ? `evidence from ${recommendation.scope === 'category' ? `${recommendation.category} runs` : 'all runs'}`
    : 'heuristic fallback — no comparable run history yet';
  console.log(`Adaptive profiles for ${evalCase.id}: ${recommendation.profiles.join(', ')} (${sourceLabel})`);
  return recommendation.profiles;
}

async function resolveMatrixCases(
  flags: Record<string, string>,
  positionals: string[],
  casesDir: string,
): Promise<HarnessEvalCase[]> {
  const rawCase = flags.case || positionals[1];
  if (!rawCase) {
    throw new Error('Provide an eval case: harness eval matrix --case <id|path|all>');
  }

  if (rawCase === 'all') {
    const summaries = await listEvalCases(casesDir);
    return Promise.all(summaries.map((summary) => findEvalCase(summary.id, casesDir)));
  }

  return Promise.all(
    rawCase
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean)
      .map((ref) => findEvalCase(ref, casesDir)),
  );
}

async function resolveMatrixWorkspace(options: {
  evalCase: HarnessEvalCase;
  baseWorkspace: string;
  isolationRoot: string;
  execute: boolean;
  flags: Record<string, string>;
}): Promise<string> {
  const sourceWorkspace = path.resolve(
    options.flags.workspace ||
      options.evalCase.workspaceFixture ||
      options.baseWorkspace,
  );

  if (!options.execute || flagEnabled(options.flags, 'in-place')) {
    if (flagEnabled(options.flags, 'in-place')) {
      return sourceWorkspace;
    }
    return path.join(options.isolationRoot, 'workspace');
  }

  if (!options.evalCase.workspaceFixture && !options.flags.workspace) {
    throw new Error(
      `Matrix execution for ${options.evalCase.id} needs a workspaceFixture, --workspace, or --in-place true.`,
    );
  }

  const destination = path.join(
    options.isolationRoot,
    'workspace',
  );
  if ((await fileExists(destination)) && !flagEnabled(options.flags, 'force')) {
    throw new Error(`Workspace destination already exists: ${destination}. Use --force true to overwrite.`);
  }
  await copyMatrixWorkspace(sourceWorkspace, destination, flagEnabled(options.flags, 'force'));
  return destination;
}

export async function copyMatrixWorkspace(sourceWorkspace: string, destination: string, force: boolean): Promise<void> {
  const root = path.resolve(sourceWorkspace);
  await ensureDir(path.dirname(destination));
  await fs.cp(root, destination, {
    recursive: true,
    force,
    filter: (sourcePath) => {
      const relative = path.relative(root, sourcePath);
      if (!relative) return true;
      return !relative.split(path.sep).some((part) => MATRIX_COPY_EXCLUDE_DIRS.has(part));
    },
  });
}

function renderMatrixRunCommand(
  evalCase: HarnessEvalCase,
  profileName: string,
  outDir: string,
  flags: Record<string, string>,
): string {
  const pieces = [
    'npm run harness -- eval matrix',
    '--case',
    quoteCliValue(evalCase.id),
    '--profiles',
    quoteCliValue(profileName),
    '--out',
    quoteCliValue(outDir),
    '--execute true',
  ];
  if (flags.config) {
    pieces.push('--config', quoteCliValue(flags.config));
  }
  if (flags.workspace) {
    pieces.push('--workspace', quoteCliValue(flags.workspace));
  }
  return pieces.join(' ');
}

function renderMatrixPlanMarkdown(plan: MatrixPlanFile): string {
  const lines: string[] = [];
  lines.push('# Eval Matrix Plan');
  lines.push('');
  lines.push(`Built at: ${plan.builtAt}`);
  lines.push(`Mode: ${plan.mode}`);
  lines.push(`Profile selection: ${plan.profileSelection}`);
  lines.push(`Cases directory: ${plan.casesDir}`);
  lines.push('');
  lines.push('## Runs');
  lines.push('');

  for (const run of plan.runs) {
    lines.push(`### ${run.caseId} / ${run.profile}`);
    lines.push('');
    lines.push(`Title: ${run.caseTitle}`);
    lines.push(`Category: ${run.category}`);
    lines.push(`Profile: ${run.profileDescription}`);
    lines.push(`Isolation root: ${run.isolationRoot}`);
    lines.push(`Workspace: ${run.workspace}`);
    lines.push(`Run root: ${run.runRoot}`);
    lines.push(`Provider: ${run.configSummary.provider}`);
    lines.push(`Runtime mode: ${run.configSummary.runtimeMode}`);
    lines.push(`Role providers: ${JSON.stringify(run.configSummary.roleProviders)}`);
    lines.push(
      `Budgets: ${run.configSummary.maxSprints} sprint(s), ` +
        `${run.configSummary.maxRepairRounds} repair round(s), ` +
        `${run.configSummary.maxNegotiationRounds} negotiation round(s)`,
    );
    lines.push(`Command: \`${run.command}\``);
    lines.push('');
  }

  return `${lines.join('\n').trim()}\n`;
}

function quoteCliValue(value: string): string {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}
