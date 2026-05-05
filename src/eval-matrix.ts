import path from 'node:path';
import { buildOverrides, flagEnabled } from './cli-flags.js';
import { loadConfig } from './config.js';
import {
  type HarnessEvalCase,
  buildEvalRunPacket,
  findEvalCase,
  listEvalCases,
  writeEvalRunPacket,
} from './evals.js';
import { HarnessRunner } from './harness.js';
import {
  expandExecutionProfileSelection,
  resolveExecutionProfile,
} from './profiles.js';
import { createProvider } from './providers/index.js';
import type { HarnessConfig } from './types.js';
import {
  copyTree,
  deepMerge,
  ensureDir,
  fileExists,
  slugify,
  writeJson,
  writeText,
} from './utils.js';

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

  const results = [];
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
      const packet = await buildEvalRunPacket({
        runDir: run.runDir,
        evalCase: planned.evalCase,
        workspace: planned.config.workspace,
        runObjectiveChecks: flagEnabled(flags, 'objective-checks'),
      });
      const packetBase = path.join(
        outDir,
        'packets',
        slugify(planned.evalCase.id),
        slugify(planned.profileName),
        'packet',
      );
      await writeEvalRunPacket(packet, `${packetBase}.json`, `${packetBase}.md`);
      results.push({
        caseId: planned.evalCase.id,
        profile: planned.profileName,
        ok: run.status === 'completed',
        status: run.status,
        runDir: run.runDir,
        packetPath: `${packetBase}.json`,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      results.push({
        caseId: planned.evalCase.id,
        profile: planned.profileName,
        ok: false,
        status: 'failed',
        error: message,
      });
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

  await writeJson(path.join(outDir, 'matrix-result.json'), {
    version: 1,
    builtAt: new Date().toISOString(),
    results,
  });
  console.log(`Matrix results: ${path.join(outDir, 'matrix-result.json')}`);
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
  await copyTree(sourceWorkspace, destination);
  return destination;
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
