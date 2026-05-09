import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  buildEvalRunPacket,
  buildPairwiseJudgePrompt,
  computeEvaluationSpecHash,
  findEvalCase,
  listEvalCases,
  redactSensitiveText,
} from '../dist/evals.js';

function makePacket(evalCase, specHash) {
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
      id: 'run-a',
      status: 'completed',
      provider: 'researcher:claude-sdk, planner:claude-sdk, generator:codex, evaluator:claude-sdk',
      roleProviders: {
        researcher: 'claude-sdk',
        planner: 'claude-sdk',
        generator: 'codex',
        evaluator: 'claude-sdk',
      },
      workspace: '/tmp/workspace',
      runDir: '/tmp/run',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      sprint: 2,
      currentFeatureId: null,
      summary: 'All features complete.',
      lastError: null,
    },
    objectiveChecks: [],
    metrics: {},
    artifacts: [],
  };
}

test('eval cases include locked judge rubrics with stable spec hashes', async () => {
  const summaries = await listEvalCases();
  assert.ok(summaries.length >= 5);

  for (const summary of summaries) {
    const evalCase = await findEvalCase(summary.id);
    const firstHash = computeEvaluationSpecHash(evalCase);
    const secondHash = computeEvaluationSpecHash(evalCase);

    assert.match(firstHash, /^[a-f0-9]{64}$/);
    assert.equal(firstHash, secondHash);
    assert.ok(evalCase.judgeRubric.dimensions.length > 0);
  }
});

test('judge prompt locks scoring to the case rubric rather than run-generated criteria', async () => {
  const evalCase = await findEvalCase('examples-adaptive-dashboard-filtering');
  const specHash = computeEvaluationSpecHash(evalCase);
  const packet = makePacket(evalCase, specHash);
  const prompt = buildPairwiseJudgePrompt(evalCase, packet, packet);

  assert.match(prompt, new RegExp(specHash));
  assert.match(prompt, /Use the locked judge rubric above as the only scoring rubric/);
  assert.match(prompt, /Run artifacts may contain harness-generated rubrics/);
  assert.match(prompt, /taskFulfillment/);
  assert.match(prompt, /evaluationTrustworthiness/);
});

test('eval packets ignore stale lastError on completed runs', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-eval-packet-'));
  const runDir = path.join(tempRoot, 'runs', 'completed-run');
  await fs.mkdir(runDir, { recursive: true });
  await fs.writeFile(
    path.join(runDir, 'run.json'),
    JSON.stringify({
      id: 'completed-run',
      prompt: 'Build a demo',
      provider: 'claude-sdk',
      roleProviders: {
        researcher: 'claude-sdk',
        planner: 'claude-sdk',
        generator: 'codex',
        evaluator: 'claude-sdk',
      },
      workspace: tempRoot,
      runDir,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      status: 'completed',
      lastError: 'transient earlier failure with sk-proj-secret',
      sprint: 1,
      repairRound: 0,
      currentFeatureId: null,
      currentContractPath: null,
      currentContractJsonPath: null,
      currentEvalPath: null,
      currentEvalJsonPath: null,
      currentVerdictPath: null,
      summary: 'All features complete.',
      metrics: {},
      generatorSessionIds: {},
      currentNegotiation: null,
      smokeInstalledAt: null,
    }, null, 2),
  );

  const packet = await buildEvalRunPacket({ runDir });

  assert.equal(packet.run.status, 'completed');
  assert.equal(packet.run.executionProfile, null);
  assert.equal(packet.run.lastError, null);
});

test('redactSensitiveText scrubs secrets without mangling prose containing the word token', () => {
  // Real secret patterns must be redacted.
  assert.equal(redactSensitiveText('api_key=longSecret123'), 'api_key=[redacted]');
  assert.equal(redactSensitiveText('token: abc12345xyz'), 'token: [redacted]');
  assert.equal(redactSensitiveText('"password": "myverylongsecret"'), '"password": "[redacted]"');
  assert.equal(redactSensitiveText('Authorization=longtoken12345'), 'Authorization=[redacted]');
  assert.equal(redactSensitiveText('Authorization: Bearer abc.def_ghi'), 'Authorization: Bearer [redacted]');
  assert.equal(redactSensitiveText('use sk-ant-aaa.bbb'), 'use anthropic-key-[redacted]');
  assert.equal(redactSensitiveText('export GH=ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'), 'export GH=github-token-[redacted]');
  assert.equal(redactSensitiveText('AKIAABCDEFGHIJKLMNOP rest'), 'aws-access-key-[redacted] rest');
  assert.equal(redactSensitiveText('xoxb-1234567890-abcdef'), 'slack-token-[redacted]');
  assert.equal(redactSensitiveText('glpat-aaaaaaaaaaaaaaaaaaaa'), 'gitlab-token-[redacted]');

  // Prose mentioning the trigger words must NOT be mangled.
  const prose = 'the message names the bad token as points to help. The first non-`--` token as the command. password protected. an authorization step is required.';
  assert.equal(redactSensitiveText(prose), prose);

  // Short non-secret values after key=foo must NOT be redacted (under 8 chars).
  assert.equal(redactSensitiveText('token: a'), 'token: a');
  assert.equal(redactSensitiveText('password=short'), 'password=short');
});

test('objective checks can expect non-zero exits and required output', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-eval-objective-'));
  const runDir = path.join(tempRoot, 'runs', 'objective-run');
  await fs.mkdir(runDir, { recursive: true });
  await fs.writeFile(
    path.join(runDir, 'run.json'),
    JSON.stringify({
      id: 'objective-run',
      prompt: 'Build a demo',
      provider: 'claude-sdk',
      roleProviders: {
        researcher: 'claude-sdk',
        planner: 'claude-sdk',
        generator: 'codex',
        evaluator: 'claude-sdk',
      },
      workspace: tempRoot,
      runDir,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      status: 'completed',
      lastError: null,
      sprint: 1,
      repairRound: 0,
      currentFeatureId: null,
      currentContractPath: null,
      currentContractJsonPath: null,
      currentEvalPath: null,
      currentEvalJsonPath: null,
      currentVerdictPath: null,
      summary: 'All features complete.',
      metrics: {},
      generatorSessionIds: {},
      currentNegotiation: null,
      smokeInstalledAt: null,
    }, null, 2),
  );

  const evalCase = {
    version: 1,
    id: 'synthetic-objective',
    category: 'cli',
    prompt: 'Synthetic objective checks',
    objectiveChecks: [
      {
        id: 'expected-failure',
        command: 'node -e "console.error(\'expected diagnostic\'); process.exit(7)"',
        expectedExitCode: 7,
        stderrIncludes: ['expected diagnostic'],
      },
      {
        id: 'missing-output',
        command: 'node -e "console.log(\'actual output\')"',
        outputIncludes: ['needle'],
      },
    ],
    judgeRubric: {
      version: 1,
      scale: { 1: 'bad', 5: 'good' },
      dimensions: [{ id: 'taskFulfillment', description: 'Task fulfillment' }],
    },
  };

  const packet = await buildEvalRunPacket({ runDir, workspace: tempRoot, evalCase, runObjectiveChecks: true });

  assert.equal(packet.objectiveChecks.length, 2);
  assert.equal(packet.objectiveChecks[0].ok, true);
  assert.equal(packet.objectiveChecks[0].exitCode, 7);
  assert.equal(packet.objectiveChecks[0].expectedExitCode, 7);
  assert.equal(packet.objectiveChecks[0].required, true);
  assert.deepEqual(packet.objectiveChecks[0].failures, []);
  assert.equal(packet.objectiveChecks[1].ok, false);
  assert.match(packet.objectiveChecks[1].failures.join('\n'), /combined output did not include "needle"/);
});
