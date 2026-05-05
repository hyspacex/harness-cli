import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { computeEvaluationSpecHash, findEvalCase } from '../dist/evals.js';
import { copyMatrixWorkspace, writeMatrixComparisons } from '../dist/eval-matrix.js';

function makePacket(evalCase, profile) {
  const specHash = computeEvaluationSpecHash(evalCase);
  return {
    version: 1,
    builtAt: '2026-01-01T00:00:00.000Z',
    case: {
      id: evalCase.id,
      title: evalCase.title || null,
      category: evalCase.category,
      prompt: evalCase.prompt,
      judgeFocus: evalCase.judgeFocus || [],
      judgeRubric: evalCase.judgeRubric,
      evaluationSpecHash: specHash,
    },
    run: {
      id: `${profile}-run`,
      status: 'completed',
      provider: `profile:${profile}`,
      executionProfile: profile,
      roleProviders: {
        researcher: 'claude-sdk',
        planner: 'claude-sdk',
        generator: profile === 'visual-qa' ? 'codex' : 'claude-sdk',
        evaluator: 'claude-sdk',
      },
      workspace: '/tmp/workspace',
      runDir: `/tmp/${profile}-run`,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      sprint: 1,
      currentFeatureId: null,
      summary: `${profile} completed.`,
      lastError: null,
    },
    objectiveChecks: [],
    metrics: {},
    artifacts: [],
  };
}

test('matrix comparisons write locked-rubric pairwise artifacts for profile runs', async () => {
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-matrix-comparison-'));
  const evalCase = await findEvalCase('examples-adaptive-dashboard-filtering');
  const fastPacket = makePacket(evalCase, 'fast');
  const visualPacket = makePacket(evalCase, 'visual-qa');

  const comparisons = await writeMatrixComparisons({
    outDir,
    packetizedRuns: [
      {
        evalCase,
        profileName: 'fast',
        runResult: { caseId: evalCase.id, profile: 'fast', ok: false, status: 'failed' },
        packet: fastPacket,
      },
      {
        evalCase,
        profileName: 'visual-qa',
        runResult: { caseId: evalCase.id, profile: 'visual-qa', ok: true, status: 'completed' },
        packet: visualPacket,
      },
    ],
    judgeProvider: undefined,
    flags: {},
  });

  assert.equal(comparisons.length, 1);
  assert.equal(comparisons[0].caseId, evalCase.id);
  assert.equal(comparisons[0].judge, 'dry-run');

  const comparisonDir = comparisons[0].outDir;
  const prompt = await fs.readFile(path.join(comparisonDir, 'judge-prompt.md'), 'utf8');
  const result = JSON.parse(await fs.readFile(path.join(comparisonDir, 'judge-result.json'), 'utf8'));

  assert.match(prompt, /Use the locked judge rubric above as the only scoring rubric/);
  assert.match(prompt, new RegExp(computeEvaluationSpecHash(evalCase)));
  assert.equal(result.winner, 'inconclusive');
  assert.equal(result.order.A, 'fast-run');
  assert.equal(result.order.B, 'visual-qa-run');
});

test('matrix workspace copies exclude stale harness and dependency artifacts', async () => {
  const source = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-matrix-source-'));
  const destination = path.join(os.tmpdir(), `harness-matrix-dest-${Date.now()}`);

  await fs.mkdir(path.join(source, 'src'), { recursive: true });
  await fs.mkdir(path.join(source, '.harness', 'runs', 'old-run'), { recursive: true });
  await fs.mkdir(path.join(source, 'node_modules', 'left-pad'), { recursive: true });
  await fs.writeFile(path.join(source, 'src', 'app.ts'), 'export const ok = true;\n');
  await fs.writeFile(path.join(source, '.harness', 'runs', 'old-run', 'run.json'), '{}\n');
  await fs.writeFile(path.join(source, 'node_modules', 'left-pad', 'index.js'), 'module.exports = null;\n');

  await copyMatrixWorkspace(source, destination, false);

  await fs.access(path.join(destination, 'src', 'app.ts'));
  await assert.rejects(fs.access(path.join(destination, '.harness')));
  await assert.rejects(fs.access(path.join(destination, 'node_modules')));
});
