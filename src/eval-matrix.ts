import fs from 'node:fs/promises';
import path from 'node:path';
import { buildOverrides, flagEnabled, parseProviderName } from './cli-flags.js';
import { loadConfig } from './config.js';
import {
  type HarnessEvalCase,
  type EvalRunPacket,
  buildDryJudgeResult,
  buildEvalRunPacket,
  buildPairwiseJudgePrompt,
  findEvalCase,
  listEvalCases,
  normalizeJudgeResult,
  parseJudgeJson,
  writeEvalRunPacket,
  writeJudgeComparisonArtifacts,
} from './evals.js';
import { HarnessRunner } from './harness.js';
import {
  expandExecutionProfileSelection,
  resolveExecutionProfile,
} from './profiles.js';
import { createProvider } from './providers/index.js';
import type { HarnessConfig, ProviderName, RunState } from './types.js';
import {
  deepMerge,
  ensureDir,
  fileExists,
  listDirectories,
  readJson,
  slugify,
  writeJson,
  writeText,
} from './utils.js';

const MATRIX_COPY_EXCLUDE_DIRS = new Set(['.git', '.harness', 'node_modules', 'dist', 'coverage']);

interface MatrixRunPlan {
  caseId: string;
  caseTitle: string;
  category: string;
  profile: string;
  profileDescription: string;
  prompt: string;
  workspace: string;
  runRoot: string;
  command: string;
  configSummary: {
    provider: HarnessConfig['provider'];
    roleProviders: HarnessConfig['roleProviders'];
    maxSprints: number;
    maxRepairRounds: number;
    maxNegotiationRounds: number;
    smoke: HarnessConfig['smoke'];
  };
}

interface PlannedMatrixRun {
  evalCase: HarnessEvalCase;
  profileName: string;
  config: HarnessConfig;
  plan: MatrixRunPlan;
}

interface MatrixRunResult {
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

interface CompletedMatrixRun {
  evalCase: HarnessEvalCase;
  profileName: string;
  runResult: MatrixRunResult;
  packet: EvalRunPacket;
}

interface MatrixComparisonResult {
  caseId: string;
  profileA: string;
  profileB: string;
  outDir: string;
  judge: string;
  winner: string;
  confidence: number;
  error?: string;
}

export async function runEvalMatrix(flags: Record<string, string>, positionals: string[]): Promise<void> {
  const casesDir = flags.cases || 'evals/cases';
  const evalCases = await resolveMatrixCases(flags, positionals, casesDir);
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
  const selection = flags.profiles || flags.profile || 'adaptive';
  const plannedRuns: PlannedMatrixRun[] = [];

  for (const evalCase of evalCases) {
    const profileNames = expandExecutionProfileSelection(
      selection,
      { category: evalCase.category, prompt: evalCase.prompt },
      baseConfig.profiles,
    );

    for (const profileName of profileNames) {
      const profile = resolveExecutionProfile(profileName, baseConfig.profiles);
      const caseSlug = slugify(evalCase.id);
      const profileSlug = slugify(profileName);
      const workspace = await resolveMatrixWorkspace({
        evalCase,
        profileName,
        baseWorkspace: baseConfig.workspace,
        outDir,
        execute,
        flags,
      });
      const runRootBase = flags['run-root']
        ? path.resolve(flags['run-root'])
        : path.join(outDir, 'run-roots');
      const runRoot = path.join(runRootBase, caseSlug, profileSlug);
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
        workspace: config.workspace,
        runRoot: config.runRoot,
        command: renderMatrixRunCommand(evalCase, profileName, outDir, flags),
        configSummary: {
          provider: config.provider,
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

  const plan = {
    version: 1,
    builtAt,
    mode: execute ? 'execute' : 'dry-run',
    profileSelection: selection,
    casesDir: path.resolve(casesDir),
    runs: plannedRuns.map((run) => run.plan),
  };

  await ensureDir(outDir);
  await writeJson(path.join(outDir, 'matrix-plan.json'), plan);
  await writeText(path.join(outDir, 'matrix-plan.md'), renderMatrixPlanMarkdown(plan));

  console.log(`Matrix plan: ${outDir}`);
  console.log(`Runs: ${plannedRuns.length}`);
  if (!execute) {
    console.log('Dry run only. Add --execute true to run the planned matrix.');
    return;
  }

  const judgeProvider = parseProviderName(flags['judge-provider']);
  const results: MatrixRunResult[] = [];
  const completedRuns: CompletedMatrixRun[] = [];
  for (const planned of plannedRuns) {
    console.log(`[matrix] ${planned.plan.caseId} / ${planned.profileName}`);
    try {
      const runner = new HarnessRunner(
        planned.config,
        createProvider(planned.config, {
          onStdErr: (chunk) => {
            const text = String(chunk || '').trim();
            if (text) {
              console.error(`[${planned.profileName}] ${text}`);
            }
          },
          onUpdate: (update) => {
            if (update?.sessionUpdate === 'tool_call' && update.title) {
              console.error(`[${planned.profileName}:tool] ${update.title}`);
            }
          },
        }),
        console,
      );
      const run = await runner.runNew(planned.evalCase.prompt);
      const packetInfo = await writeMatrixRunPacket({ outDir, planned, runDir: run.runDir, flags });
      const runResult: MatrixRunResult = {
        caseId: planned.evalCase.id,
        profile: planned.profileName,
        ok: run.status === 'completed',
        status: run.status,
        runDir: run.runDir,
        packetPath: packetInfo.packetPath,
        packetMarkdownPath: packetInfo.packetMarkdownPath,
      };
      results.push(runResult);
      completedRuns.push({
        evalCase: planned.evalCase,
        profileName: planned.profileName,
        runResult,
        packet: packetInfo.packet,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const failedRun = await findLatestMatrixRun(planned.config.runRoot);
      let packetInfo: Awaited<ReturnType<typeof writeMatrixRunPacket>> | null = null;
      let packetError: string | undefined;
      if (failedRun) {
        try {
          packetInfo = await writeMatrixRunPacket({
            outDir,
            planned,
            runDir: failedRun.runDir,
            flags,
          });
        } catch (packetBuildError) {
          packetError = packetBuildError instanceof Error ? packetBuildError.message : String(packetBuildError);
        }
      }
      const runResult: MatrixRunResult = {
        caseId: planned.evalCase.id,
        profile: planned.profileName,
        ok: false,
        status: failedRun?.status || 'failed',
        ...(failedRun?.runDir ? { runDir: failedRun.runDir } : {}),
        ...(packetInfo ? { packetPath: packetInfo.packetPath, packetMarkdownPath: packetInfo.packetMarkdownPath } : {}),
        error: message,
        ...(packetError ? { packetError } : {}),
      };
      results.push(runResult);
      if (flags['continue-on-error'] !== 'true') {
        await writeJson(path.join(outDir, 'matrix-result.json'), {
          version: 1,
          builtAt: new Date().toISOString(),
          results,
        });
        throw error;
      }
    }
  }

  const comparisons = await writeMatrixComparisons({
    outDir,
    completedRuns,
    judgeProvider,
    flags,
  });

  await writeJson(path.join(outDir, 'matrix-result.json'), {
    version: 1,
    builtAt: new Date().toISOString(),
    results,
    comparisons,
  });
  console.log(`Matrix results: ${path.join(outDir, 'matrix-result.json')}`);
  if (comparisons.length > 0) {
    console.log(`Matrix comparisons: ${path.join(outDir, 'comparisons')}`);
  }
}

async function writeMatrixRunPacket(options: {
  outDir: string;
  planned: PlannedMatrixRun;
  runDir: string;
  flags: Record<string, string>;
}): Promise<{ packet: EvalRunPacket; packetPath: string; packetMarkdownPath: string }> {
  const packet = await buildEvalRunPacket({
    runDir: options.runDir,
    evalCase: options.planned.evalCase,
    workspace: options.planned.config.workspace,
    runObjectiveChecks: flagEnabled(options.flags, 'objective-checks'),
  });
  const packetBase = path.join(
    options.outDir,
    'packets',
    slugify(options.planned.evalCase.id),
    slugify(options.planned.profileName),
    'packet',
  );
  const packetPath = `${packetBase}.json`;
  const packetMarkdownPath = `${packetBase}.md`;
  await writeEvalRunPacket(packet, packetPath, packetMarkdownPath);
  return { packet, packetPath, packetMarkdownPath };
}

async function findLatestMatrixRun(runRoot: string): Promise<RunState | null> {
  const runIds = await listDirectories(path.join(runRoot, 'runs'));
  const runs = (
    await Promise.all(
      runIds.map((runId) => readJson<RunState | null>(path.join(runRoot, 'runs', runId, 'run.json'), null)),
    )
  ).filter((run): run is RunState => run !== null);

  return runs.sort((a, b) => {
    const aTime = Date.parse(a.updatedAt || a.createdAt);
    const bTime = Date.parse(b.updatedAt || b.createdAt);
    return bTime - aTime;
  })[0] || null;
}

export async function writeMatrixComparisons(options: {
  outDir: string;
  completedRuns: CompletedMatrixRun[];
  judgeProvider: ProviderName | undefined;
  flags: Record<string, string>;
}): Promise<MatrixComparisonResult[]> {
  const byCase = new Map<string, CompletedMatrixRun[]>();
  for (const run of options.completedRuns) {
    if (!run.runResult.ok) continue;
    const existing = byCase.get(run.evalCase.id) || [];
    existing.push(run);
    byCase.set(run.evalCase.id, existing);
  }

  const comparisons: MatrixComparisonResult[] = [];
  for (const runs of byCase.values()) {
    runs.sort((a, b) => a.profileName.localeCompare(b.profileName));
    for (let i = 0; i < runs.length; i += 1) {
      for (let j = i + 1; j < runs.length; j += 1) {
        const runA = runs[i];
        const runB = runs[j];
        const prompt = buildPairwiseJudgePrompt(runA.evalCase, runA.packet, runB.packet);
        const comparisonDir = path.join(
          options.outDir,
          'comparisons',
          slugify(runA.evalCase.id),
          `${slugify(runA.profileName)}-vs-${slugify(runB.profileName)}`,
        );
        let judged = {
          result: buildDryJudgeResult(runA.evalCase, runA.packet, runB.packet),
          rawText: null as string | null,
        };
        let judgeError: Error | null = null;

        if (options.judgeProvider) {
          try {
            judged = await runMatrixJudge({
              flags: options.flags,
              judgeProvider: options.judgeProvider,
              prompt,
              evalCase: runA.evalCase,
              packetA: runA.packet,
              packetB: runB.packet,
            });
          } catch (error) {
            judgeError = error instanceof Error ? error : new Error(String(error));
            judged.result = {
              ...judged.result,
              judge: {
                provider: options.judgeProvider,
                model: null,
              },
              rationale: `Judge failed before producing a result: ${judgeError.message}`,
            };
          }
        }

        await writeJudgeComparisonArtifacts({
          outDir: comparisonDir,
          packetA: runA.packet,
          packetB: runB.packet,
          prompt,
          result: judged.result,
          rawJudgeText: judged.rawText,
        });
        comparisons.push({
          caseId: runA.evalCase.id,
          profileA: runA.profileName,
          profileB: runB.profileName,
          outDir: comparisonDir,
          judge: judged.result.judge.provider,
          winner: judged.result.winner,
          confidence: judged.result.confidence,
          ...(judgeError ? { error: judgeError.message } : {}),
        });
      }
    }
  }
  return comparisons;
}

async function runMatrixJudge(options: {
  flags: Record<string, string>;
  judgeProvider: ProviderName;
  prompt: string;
  evalCase: HarnessEvalCase;
  packetA: EvalRunPacket;
  packetB: EvalRunPacket;
}): Promise<{ result: ReturnType<typeof normalizeJudgeResult>; rawText: string | null }> {
  const judgeFlags = { ...options.flags, provider: options.judgeProvider };
  const { config } = await loadConfig(options.flags.config, buildOverrides(judgeFlags), {
    profile: options.flags['judge-profile'] || options.flags.profile || null,
  });
  const providerRegistry = createProvider(config, {
    onStdErr: (chunk) => {
      const text = String(chunk || '').trim();
      if (text) {
        console.error(`[matrix-judge] ${text}`);
      }
    },
    onUpdate: (update) => {
      if (update?.sessionUpdate === 'tool_call' && update.title) {
        console.error(`[matrix-judge-tool] ${update.title}`);
      }
    },
  });
  const result = await providerRegistry.runTask({
    kind: 'evaluator',
    label: `matrix-judge-${options.evalCase.id}`,
    cwd: process.cwd(),
    prompt: options.prompt,
    artifacts: {},
  });
  const parsed = result.parsed || parseJudgeJson(result.rawText);
  return {
    result: normalizeJudgeResult(parsed, {
      caseId: options.evalCase.id,
      provider: options.judgeProvider,
      model: options.judgeProvider === 'codex' ? config.codex.model : config.claudeSdk.model,
      packetA: options.packetA,
      packetB: options.packetB,
    }),
    rawText: result.rawText,
  };
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
  profileName: string;
  baseWorkspace: string;
  outDir: string;
  execute: boolean;
  flags: Record<string, string>;
}): Promise<string> {
  const sourceWorkspace = path.resolve(
    options.flags.workspace ||
      options.evalCase.workspaceFixture ||
      options.baseWorkspace,
  );

  if (!options.execute || flagEnabled(options.flags, 'in-place')) {
    return sourceWorkspace;
  }

  if (!options.evalCase.workspaceFixture && !options.flags.workspace) {
    throw new Error(
      `Matrix execution for ${options.evalCase.id} needs a workspaceFixture, --workspace, or --in-place true.`,
    );
  }

  const destination = path.join(
    options.outDir,
    'workspaces',
    slugify(options.evalCase.id),
    slugify(options.profileName),
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

function renderMatrixPlanMarkdown(plan: {
  version: number;
  builtAt: string;
  mode: string;
  profileSelection: string;
  casesDir: string;
  runs: MatrixRunPlan[];
}): string {
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
    lines.push(`Workspace: ${run.workspace}`);
    lines.push(`Run root: ${run.runRoot}`);
    lines.push(`Provider: ${run.configSummary.provider}`);
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
