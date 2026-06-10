import path from 'node:path';
import { flagEnabled, parseProviderName } from '../cli-flags.js';
import { findLatestRunArtifactBundle } from '../artifacts/run-reader.js';
import {
  buildDryJudgeResult,
  buildEvalRunPacket,
  buildPairwiseJudgePrompt,
  findEvalCase,
  writeEvalRunPacket,
  writeJudgeComparisonArtifacts,
  type EvalRunPacket,
  type HarnessEvalCase,
} from '../evals.js';
import type { ProviderName } from '../types.js';
import { ensureDir, readJson, slugify, writeJson, writeText } from '../utils.js';
import type {
  MatrixComparisonResult,
  MatrixGateStatus,
  MatrixJudgeRunner,
  MatrixPlanFile,
  MatrixResultFile,
  MatrixRunResult,
  MatrixShipGate,
  MatrixShipGateCheck,
  PacketizedMatrixRun,
} from './schema.js';

export async function reportEvalMatrix(
  flags: Record<string, string>,
  positionals: string[],
  options: { runJudge?: MatrixJudgeRunner } = {},
): Promise<void> {
  const outDirInput = flags.from || positionals[2] || flags.out;
  if (!outDirInput) {
    throw new Error('Provide a matrix output directory: harness eval matrix report --from <dir>');
  }
  const outDir = path.resolve(outDirInput);

  const plan = await readJson<MatrixPlanFile | null>(path.join(outDir, 'matrix-plan.json'), null);
  if (!plan) {
    throw new Error(`Matrix plan not found: ${path.join(outDir, 'matrix-plan.json')}`);
  }

  const judgeProvider = parseProviderName(flags['judge-provider']);
  const results: MatrixRunResult[] = [];
  const packetizedRuns: PacketizedMatrixRun[] = [];
  for (const planRun of plan.runs) {
    const evalCase = await findEvalCase(planRun.caseId, flags.cases || plan.casesDir || 'evals/cases');
    const run = await findLatestMatrixRun(planRun.runRoot);
    if (!run) {
      results.push({
        caseId: planRun.caseId,
        profile: planRun.profile,
        ok: false,
        status: 'missing',
        error: `No run.json found under ${path.join(planRun.runRoot, 'runs')}`,
      });
      continue;
    }

    let packetInfo: Awaited<ReturnType<typeof writeMatrixRunPacket>> | null = null;
    let packetError: string | undefined;
    try {
      packetInfo = await writeMatrixRunPacket({
        outDir,
        evalCase,
        profileName: planRun.profile,
        workspace: run.workspace || planRun.workspace,
        runDir: run.runDir,
        flags,
      });
    } catch (error) {
      packetError = error instanceof Error ? error.message : String(error);
    }

    const runResult: MatrixRunResult = {
      caseId: evalCase.id,
      profile: planRun.profile,
      ok: run.status === 'completed',
      status: run.status,
      runDir: run.runDir,
      ...(packetInfo ? { packetPath: packetInfo.packetPath, packetMarkdownPath: packetInfo.packetMarkdownPath } : {}),
      ...(run.lastError ? { error: run.lastError } : {}),
      ...(packetError ? { packetError } : {}),
    };
    results.push(runResult);

    if (packetInfo) {
      packetizedRuns.push({
        evalCase,
        profileName: planRun.profile,
        runResult,
        packet: packetInfo.packet,
      });
    }
  }

  const comparisons = await writeMatrixComparisons({
    outDir,
    packetizedRuns,
    judgeProvider,
    flags,
    runJudge: options.runJudge,
  });
  await writeMatrixResult(outDir, {
    version: 1,
    builtAt: new Date().toISOString(),
    results,
    comparisons,
    shipGate: buildMatrixShipGate({
      results,
      comparisons,
      packetizedRuns,
      judgeProvider,
    }),
  });
  console.log(`Matrix results: ${path.join(outDir, 'matrix-result.json')}`);
  console.log(`Matrix report: ${path.join(outDir, 'matrix-result.md')}`);
  if (comparisons.length > 0) {
    console.log(`Matrix comparisons: ${path.join(outDir, 'comparisons')}`);
  }
}

export async function writeMatrixResult(outDir: string, result: MatrixResultFile): Promise<void> {
  await writeJson(path.join(outDir, 'matrix-result.json'), result);
  await writeText(path.join(outDir, 'matrix-result.md'), renderMatrixResultMarkdown(result));
  await freezeSuiteResult(outDir, result);
}

/** Benchmark-suite matrix results are additionally frozen under benchmarks/frozen/ for cross-run comparison. */
async function freezeSuiteResult(outDir: string, result: MatrixResultFile): Promise<void> {
  const plan = await readJson<MatrixPlanFile | null>(path.join(outDir, 'matrix-plan.json'), null);
  if (!plan?.suiteId) {
    return;
  }

  const frozenDir = path.resolve('benchmarks', 'frozen', slugify(plan.suiteId), slugify(plan.builtAt));
  await ensureDir(frozenDir);
  await writeJson(path.join(frozenDir, 'matrix-plan.json'), plan);
  await writeJson(path.join(frozenDir, 'matrix-result.json'), result);
  await writeText(path.join(frozenDir, 'matrix-result.md'), renderMatrixResultMarkdown(result));
  console.log(`Frozen benchmark results: ${frozenDir}`);
}

function renderMatrixResultMarkdown(result: MatrixResultFile): string {
  const lines: string[] = [];
  lines.push('# Eval Matrix Result');
  lines.push('');
  lines.push(`Built at: ${result.builtAt}`);
  lines.push('');
  lines.push('## Good Enough To Ship Gate');
  lines.push('');
  lines.push(`Status: ${result.shipGate.status}`);
  lines.push(`OK: ${result.shipGate.ok ? 'yes' : 'no'}`);
  lines.push('');
  for (const check of result.shipGate.checks) {
    lines.push(`- ${check.status}: ${check.id} — ${check.message}`);
  }
  lines.push('');
  lines.push('## Runs');
  lines.push('');

  if (result.results.length === 0) {
    lines.push('No runs were recorded.');
  }
  for (const run of result.results) {
    lines.push(`### ${run.caseId} / ${run.profile}`);
    lines.push('');
    lines.push(`Status: ${run.status}`);
    lines.push(`OK: ${run.ok ? 'yes' : 'no'}`);
    if (run.runDir) lines.push(`Run dir: ${run.runDir}`);
    if (run.packetPath) lines.push(`Packet: ${run.packetPath}`);
    if (run.packetMarkdownPath) lines.push(`Packet markdown: ${run.packetMarkdownPath}`);
    if (run.error) lines.push(`Error: ${run.error}`);
    if (run.packetError) lines.push(`Packet error: ${run.packetError}`);
    lines.push('');
  }

  lines.push('## Comparisons');
  lines.push('');
  if (result.comparisons.length === 0) {
    lines.push('No pairwise comparisons were written.');
  }
  for (const comparison of result.comparisons) {
    lines.push(`### ${comparison.caseId} / ${comparison.profileA} vs ${comparison.profileB}`);
    lines.push('');
    lines.push(`Judge: ${comparison.judge}`);
    lines.push(`Winner: ${comparison.winner}`);
    lines.push(`Confidence: ${comparison.confidence}`);
    lines.push(`Artifacts: ${comparison.outDir}`);
    if (comparison.error) lines.push(`Error: ${comparison.error}`);
    lines.push('');
  }

  return `${lines.join('\n').trim()}\n`;
}

export function buildMatrixShipGate(options: {
  results: MatrixRunResult[];
  comparisons: MatrixComparisonResult[];
  packetizedRuns: PacketizedMatrixRun[];
  judgeProvider: ProviderName | undefined;
}): MatrixShipGate {
  const checks: MatrixShipGateCheck[] = [];
  const failedRuns = options.results.filter((result) => !result.ok);
  checks.push({
    id: 'all-runs-completed',
    status: failedRuns.length === 0 ? 'pass' : 'fail',
    message: failedRuns.length === 0
      ? 'Every planned run completed successfully.'
      : `${failedRuns.length} run(s) failed, were missing, or did not complete.`,
  });

  const packetFailures = options.results.filter((result) => result.packetError || (result.runDir && !result.packetPath));
  checks.push({
    id: 'packets-built',
    status: packetFailures.length === 0 ? 'pass' : 'fail',
    message: packetFailures.length === 0
      ? 'Packets were built for every run with a run directory.'
      : `${packetFailures.length} run(s) are missing usable packet artifacts.`,
  });

  const objectiveChecks = options.packetizedRuns.flatMap((run) => run.packet.objectiveChecks);
  const requiredObjectiveFailures = objectiveChecks.filter((check) => check.required && !check.ok);
  checks.push({
    id: 'required-objective-checks',
    status: objectiveChecks.length === 0
      ? 'warning'
      : requiredObjectiveFailures.length === 0
        ? 'pass'
        : 'fail',
    message: objectiveChecks.length === 0
      ? 'No objective checks were run; rerun with --objective-checks true for release evidence.'
      : requiredObjectiveFailures.length === 0
        ? `${objectiveChecks.length} objective check result(s) passed.`
        : `${requiredObjectiveFailures.length} required objective check(s) failed.`,
  });

  const judgeErrors = options.comparisons.filter((comparison) => comparison.error);
  const dryComparisons = options.comparisons.filter((comparison) => comparison.judge === 'dry-run');
  checks.push({
    id: 'pairwise-judging',
    status: options.comparisons.length === 0
      ? 'warning'
      : judgeErrors.length > 0
        ? 'fail'
        : dryComparisons.length > 0 || !options.judgeProvider
          ? 'warning'
          : 'pass',
    message: options.comparisons.length === 0
      ? 'No pairwise comparisons were written; use at least two packetized profiles for comparative evidence.'
      : judgeErrors.length > 0
        ? `${judgeErrors.length} pairwise judge comparison(s) failed.`
        : dryComparisons.length > 0 || !options.judgeProvider
          ? 'Comparisons are dry-run prompts only; rerun with --judge-provider for judged evidence.'
          : `${options.comparisons.length} judged pairwise comparison(s) completed.`,
  });

  const workspaces = options.packetizedRuns.map((run) => path.resolve(run.packet.run.workspace));
  const runDirs = options.packetizedRuns.map((run) => path.resolve(run.packet.run.runDir));
  const uniqueWorkspaces = new Set(workspaces);
  const uniqueRunDirs = new Set(runDirs);
  checks.push({
    id: 'profile-artifact-isolation',
    status: uniqueWorkspaces.size === workspaces.length && uniqueRunDirs.size === runDirs.length
      ? 'pass'
      : 'fail',
    message: uniqueWorkspaces.size === workspaces.length && uniqueRunDirs.size === runDirs.length
      ? 'Each packetized profile has a distinct workspace and run directory.'
      : 'At least two packetized profiles share a workspace or run directory.',
  });

  const status: MatrixGateStatus = checks.some((check) => check.status === 'fail')
    ? 'fail'
    : checks.some((check) => check.status === 'warning')
      ? 'warning'
      : 'pass';
  return {
    version: 1,
    status,
    ok: status === 'pass',
    checks,
  };
}

export async function writeMatrixRunPacket(options: {
  outDir: string;
  evalCase: HarnessEvalCase;
  profileName: string;
  workspace: string;
  runDir: string;
  flags: Record<string, string>;
}): Promise<{ packet: EvalRunPacket; packetPath: string; packetMarkdownPath: string }> {
  const packet = await buildEvalRunPacket({
    runDir: options.runDir,
    evalCase: options.evalCase,
    workspace: options.workspace,
    runObjectiveChecks: flagEnabled(options.flags, 'objective-checks'),
  });
  const packetBase = path.join(
    options.outDir,
    'packets',
    slugify(options.evalCase.id),
    slugify(options.profileName),
    'packet',
  );
  const packetPath = `${packetBase}.json`;
  const packetMarkdownPath = `${packetBase}.md`;
  await writeEvalRunPacket(packet, packetPath, packetMarkdownPath);
  return { packet, packetPath, packetMarkdownPath };
}

export async function findLatestMatrixRun(runRoot: string) {
  const bundle = await findLatestRunArtifactBundle(runRoot);
  return bundle?.run || null;
}

export async function writeMatrixComparisons(options: {
  outDir: string;
  packetizedRuns: PacketizedMatrixRun[];
  judgeProvider: ProviderName | undefined;
  flags: Record<string, string>;
  runJudge?: MatrixJudgeRunner;
}): Promise<MatrixComparisonResult[]> {
  const byCase = new Map<string, PacketizedMatrixRun[]>();
  for (const run of options.packetizedRuns) {
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
        const prompt = buildPairwiseJudgePrompt(runA.evalCase, runA.packet, runB.packet, {
          blind: flagEnabled(options.flags, 'blind-judge'),
        });
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
          if (options.runJudge) {
            try {
              judged = await options.runJudge({
                judgeProvider: options.judgeProvider,
                prompt,
                evalCase: runA.evalCase,
                packetA: runA.packet,
                packetB: runB.packet,
              });
            } catch (error) {
              judgeError = error instanceof Error ? error : new Error(String(error));
            }
          } else {
            judgeError = new Error('No matrix judge runner was provided.');
          }

          if (judgeError) {
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
