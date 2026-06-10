import path from 'node:path';
import { buildOverrides, parseProviderName } from '../../cli-flags.js';
import { loadConfig } from '../../core/config.js';
import { normalizeJudgeResult, parseJudgeJson } from '../judge.js';
import { redactSensitiveText } from '../packet.js';
import { HarnessRunner } from '../../core/harness.js';
import { createProvider } from '../../core/providers/index.js';
import type { ProviderName } from '../../core/types.js';
import type { MatrixJudgeRunner, MatrixRunResult, PacketizedMatrixRun, PlannedMatrixRun } from './schema.js';
import {
  buildMatrixShipGate,
  findLatestMatrixRun,
  writeMatrixComparisons,
  writeMatrixResult,
  writeMatrixRunPacket,
} from './report.js';

export async function executePlannedMatrixRuns(options: {
  outDir: string;
  plannedRuns: PlannedMatrixRun[];
  flags: Record<string, string>;
}): Promise<void> {
  const judgeProvider = parseProviderName(options.flags['judge-provider']);
  const results: MatrixRunResult[] = [];
  const packetizedRuns: PacketizedMatrixRun[] = [];
  for (const planned of options.plannedRuns) {
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
      const packetInfo = await writeMatrixRunPacket({
        outDir: options.outDir,
        evalCase: planned.evalCase,
        profileName: planned.profileName,
        workspace: planned.config.workspace,
        runDir: run.runDir,
        flags: options.flags,
      });
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
      packetizedRuns.push({
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
            outDir: options.outDir,
            evalCase: planned.evalCase,
            profileName: planned.profileName,
            workspace: planned.config.workspace,
            runDir: failedRun.runDir,
            flags: options.flags,
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
      if (packetInfo) {
        packetizedRuns.push({
          evalCase: planned.evalCase,
          profileName: planned.profileName,
          runResult,
          packet: packetInfo.packet,
        });
      }
      if (options.flags['continue-on-error'] !== 'true') {
        await writeMatrixResult(options.outDir, {
          version: 1,
          builtAt: new Date().toISOString(),
          results,
          comparisons: [],
          shipGate: buildMatrixShipGate({
            results,
            comparisons: [],
            packetizedRuns,
            judgeProvider,
          }),
        });
        throw error;
      }
    }
  }

  const comparisons = await writeMatrixComparisons({
    outDir: options.outDir,
    packetizedRuns,
    judgeProvider,
    flags: options.flags,
    runJudge: createMatrixJudgeRunner(options.flags),
  });

  await writeMatrixResult(options.outDir, {
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
  console.log(`Matrix results: ${path.join(options.outDir, 'matrix-result.json')}`);
  if (comparisons.length > 0) {
    console.log(`Matrix comparisons: ${path.join(options.outDir, 'comparisons')}`);
  }
}

export function createMatrixJudgeRunner(flags: Record<string, string>): MatrixJudgeRunner {
  return async (options) => {
    const judgeFlags = { ...flags, provider: options.judgeProvider };
    const { config } = await loadConfig(flags.config, buildOverrides(judgeFlags), {
      profile: flags['judge-profile'] || flags.profile || null,
    });
    if (flags['judge-model']) {
      if (options.judgeProvider === 'codex') {
        config.codex.model = flags['judge-model'];
      } else {
        config.claudeSdk.model = flags['judge-model'];
      }
    }
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
      prompt: redactSensitiveText(options.prompt) || '',
      artifacts: {},
    });
    const parsed = result.parsed || parseJudgeJson(result.rawText);
    return {
      result: normalizeJudgeResult(parsed, {
        caseId: options.evalCase.id,
        provider: options.judgeProvider,
        model: modelForProvider(options.judgeProvider, config),
        packetA: options.packetA,
        packetB: options.packetB,
      }),
      rawText: result.rawText,
    };
  };
}

function modelForProvider(provider: ProviderName, config: Awaited<ReturnType<typeof loadConfig>>['config']): string | null {
  return provider === 'codex' ? config.codex.model : config.claudeSdk.model;
}
