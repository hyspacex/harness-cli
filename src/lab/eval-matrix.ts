import { copyMatrixWorkspace, prepareMatrixRuns } from './matrix/plan.js';
import {
  buildMatrixShipGate,
  reportEvalMatrix,
  writeMatrixComparisons,
} from './matrix/report.js';

export { buildMatrixShipGate, copyMatrixWorkspace, writeMatrixComparisons };

export async function runEvalMatrix(flags: Record<string, string>, positionals: string[]): Promise<void> {
  if (flags.from || positionals[1] === 'report') {
    const options = flags['judge-provider']
      ? { runJudge: (await import('./matrix/execute.js')).createMatrixJudgeRunner(flags) }
      : {};
    await reportEvalMatrix(flags, positionals, options);
    return;
  }

  const prepared = await prepareMatrixRuns(flags, positionals);
  console.log(`Matrix plan: ${prepared.outDir}`);
  console.log(`Runs: ${prepared.plannedRuns.length}`);
  if (!prepared.execute) {
    console.log('Dry run only. Add --execute true to run the planned matrix.');
    return;
  }

  const { executePlannedMatrixRuns } = await import('./matrix/execute.js');
  await executePlannedMatrixRuns({
    outDir: prepared.outDir,
    plannedRuns: prepared.plannedRuns,
    flags,
  });
}
