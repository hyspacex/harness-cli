import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { computeEvaluationSpecHash, findEvalCase } from '../dist/lab/cases.js';
import { buildMatrixShipGate, copyMatrixWorkspace, runEvalMatrix, writeMatrixComparisons } from '../dist/lab/eval-matrix.js';

function makePacket(evalCase, profile, options = {}) {
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
      workspace: options.workspace ?? '/tmp/workspace',
      runDir: options.runDir ?? `/tmp/${profile}-run`,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      sprint: 1,
      currentFeatureId: null,
      summary: `${profile} completed.`,
      lastError: null,
    },
    objectiveChecks: options.objectiveChecks ?? [],
    metrics: {},
    artifacts: [],
  };
}

async function writeRunState(runRoot, evalCase, profile, status) {
  const runDir = path.join(runRoot, 'runs', `${profile}-run`);
  await fs.mkdir(runDir, { recursive: true });
  await fs.writeFile(
    path.join(runDir, 'run.json'),
    JSON.stringify({
      id: `${profile}-run`,
      prompt: evalCase.prompt,
      provider: `profile:${profile}`,
      executionProfile: profile,
      roleProviders: {
        researcher: 'claude-sdk',
        planner: 'claude-sdk',
        generator: profile === 'visual-qa' ? 'codex' : 'claude-sdk',
        evaluator: 'claude-sdk',
      },
      workspace: '/tmp/workspace',
      runDir,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: status === 'completed' ? '2026-01-01T00:00:02.000Z' : '2026-01-01T00:00:01.000Z',
      status,
      lastError: status === 'failed' ? 'Synthetic run failure.' : null,
      sprint: 1,
      repairRound: 0,
      currentFeatureId: null,
      currentContractPath: null,
      currentContractJsonPath: null,
      currentEvalPath: null,
      currentEvalJsonPath: null,
      currentVerdictPath: null,
      summary: `${profile} ${status}.`,
      metrics: {},
      generatorSessionIds: {},
      currentNegotiation: null,
      smokeInstalledAt: null,
    }, null, 2),
  );
  return runDir;
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

test('matrix report mode rebuilds packets, results, and comparisons from a plan', async () => {
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-matrix-report-'));
  const evalCase = await findEvalCase('examples-adaptive-dashboard-filtering');
  const casesDir = path.resolve('evals/cases');
  const fastRunRoot = path.join(outDir, 'run-roots', evalCase.id, 'fast');
  const visualRunRoot = path.join(outDir, 'run-roots', evalCase.id, 'visual-qa');
  await writeRunState(fastRunRoot, evalCase, 'fast', 'failed');
  await writeRunState(visualRunRoot, evalCase, 'visual-qa', 'completed');
  await fs.writeFile(
    path.join(outDir, 'matrix-plan.json'),
    JSON.stringify({
      version: 1,
      builtAt: '2026-01-01T00:00:00.000Z',
      mode: 'execute',
      profileSelection: 'fast,visual-qa',
      casesDir,
      runs: [
        {
          caseId: evalCase.id,
          caseTitle: evalCase.title,
          category: evalCase.category,
          profile: 'fast',
          profileDescription: 'Fast profile',
          prompt: evalCase.prompt,
          workspace: '/tmp/workspace',
          runRoot: fastRunRoot,
          command: 'test fast',
          configSummary: {},
        },
        {
          caseId: evalCase.id,
          caseTitle: evalCase.title,
          category: evalCase.category,
          profile: 'visual-qa',
          profileDescription: 'Visual QA profile',
          prompt: evalCase.prompt,
          workspace: '/tmp/workspace',
          runRoot: visualRunRoot,
          command: 'test visual',
          configSummary: {},
        },
      ],
    }, null, 2),
  );

  await runEvalMatrix({ from: outDir }, ['matrix']);

  const result = JSON.parse(await fs.readFile(path.join(outDir, 'matrix-result.json'), 'utf8'));
  const report = await fs.readFile(path.join(outDir, 'matrix-result.md'), 'utf8');

  assert.equal(result.results.length, 2);
  assert.equal(result.comparisons.length, 1);
  assert.equal(result.shipGate.status, 'fail');
  assert.equal(result.shipGate.ok, false);
  assert.ok(result.shipGate.checks.some((check) => check.id === 'all-runs-completed' && check.status === 'fail'));
  assert.match(report, /fast vs visual-qa/);
  assert.match(report, /Good Enough To Ship Gate/);
  await fs.access(path.join(outDir, 'packets', evalCase.id, 'fast', 'packet.json'));
  await fs.access(path.join(result.comparisons[0].outDir, 'judge-prompt.md'));
});

test('matrix ship gate passes when every check is green', async () => {
  const evalCase = await findEvalCase('examples-adaptive-dashboard-filtering');
  const passingCheck = {
    id: 'smoke',
    command: 'true',
    cwd: '/tmp',
    required: true,
    expectedExitCode: 0,
    ok: true,
    exitCode: 0,
    durationMs: 1,
    stdout: '',
    stderr: '',
    failures: [],
  };
  const fastPacket = makePacket(evalCase, 'fast', {
    workspace: '/tmp/fast/workspace',
    runDir: '/tmp/fast/run',
    objectiveChecks: [passingCheck],
  });
  const visualPacket = makePacket(evalCase, 'visual-qa', {
    workspace: '/tmp/visual-qa/workspace',
    runDir: '/tmp/visual-qa/run',
    objectiveChecks: [passingCheck],
  });

  const results = [
    {
      caseId: evalCase.id,
      profile: 'fast',
      ok: true,
      status: 'completed',
      runDir: fastPacket.run.runDir,
      packetPath: '/tmp/fast/packet.json',
      packetMarkdownPath: '/tmp/fast/packet.md',
    },
    {
      caseId: evalCase.id,
      profile: 'visual-qa',
      ok: true,
      status: 'completed',
      runDir: visualPacket.run.runDir,
      packetPath: '/tmp/visual-qa/packet.json',
      packetMarkdownPath: '/tmp/visual-qa/packet.md',
    },
  ];

  const gate = buildMatrixShipGate({
    results,
    comparisons: [
      {
        caseId: evalCase.id,
        profileA: 'fast',
        profileB: 'visual-qa',
        outDir: '/tmp/cmp',
        judge: 'claude-sdk',
        winner: 'B',
        confidence: 4,
      },
    ],
    packetizedRuns: [
      { evalCase, profileName: 'fast', runResult: results[0], packet: fastPacket },
      { evalCase, profileName: 'visual-qa', runResult: results[1], packet: visualPacket },
    ],
    judgeProvider: 'claude-sdk',
  });

  assert.equal(gate.status, 'pass');
  assert.equal(gate.ok, true);
  for (const check of gate.checks) {
    assert.equal(check.status, 'pass', `expected ${check.id} to pass: ${check.message}`);
  }
});

test('matrix dry-run plans isolated per-profile run roots', async () => {
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-matrix-isolation-'));

  await runEvalMatrix({
    case: 'examples-adaptive-dashboard-filtering',
    profiles: 'balanced,codex-only',
    out: outDir,
    'dry-run': 'true',
  }, ['matrix']);

  const plan = JSON.parse(await fs.readFile(path.join(outDir, 'matrix-plan.json'), 'utf8'));
  assert.equal(plan.runs.length, 2);
  for (const run of plan.runs) {
    assert.match(run.isolationRoot, /isolates/);
    assert.match(run.workspace, /isolates/);
    assert.match(run.runRoot, /isolates/);
    assert.match(run.workspace, new RegExp(`${run.profile}/workspace$`));
    assert.match(run.runRoot, new RegExp(`${run.profile}/run-root$`));
  }
});
