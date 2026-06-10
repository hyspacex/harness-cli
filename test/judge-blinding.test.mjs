import test from 'node:test';
import assert from 'node:assert/strict';

import { blindJudgeText, buildPairwiseJudgePrompt } from '../dist/lab/judge.js';

const RUBRIC = {
  version: 1,
  scale: { 1: 'bad', 5: 'good' },
  dimensions: [{ id: 'taskFulfillment', description: 'does the thing', weight: 'critical' }],
};

function fakePacket(profile, provider) {
  return {
    version: 1,
    builtAt: '2026-06-10T00:00:00.000Z',
    case: { id: 'c', title: 'c', category: 'cli', prompt: 'p', judgeFocus: [], judgeRubric: RUBRIC, evaluationSpecHash: 'h' },
    run: {
      id: `run-${profile}`,
      status: 'completed',
      provider,
      executionProfile: profile,
      roleProviders: { researcher: provider, planner: provider, generator: provider, evaluator: provider },
      workspace: '/tmp/w',
      runDir: '/tmp/r',
      createdAt: '2026-06-10T00:00:00.000Z',
      updatedAt: '2026-06-10T00:01:00.000Z',
      sprint: 1,
      currentFeatureId: null,
      summary: `Generated with ${provider} model claude-opus-4-8`,
      lastError: null,
    },
    objectiveChecks: [],
    metrics: { rolePerformance: {} },
    artifacts: [],
  };
}

test('blindJudgeText strips profile, provider, and model identifiers', () => {
  const text = 'Profile min-opus used claude-sdk with claude-opus-4-8; min-gpt55 used codex with gpt-5.5.';
  const blinded = blindJudgeText(text, ['min-opus', 'min-gpt55']);

  assert.doesNotMatch(blinded, /min-opus|min-gpt55/);
  assert.doesNotMatch(blinded, /claude|codex|gpt|opus/i);
  assert.match(blinded, /run-profile-\d/);
  assert.match(blinded, /redacted-provider/);
  assert.match(blinded, /redacted-model/);
});

test('buildPairwiseJudgePrompt blind option redacts both packets', () => {
  const evalCase = {
    version: 1,
    id: 'c',
    category: 'cli',
    prompt: 'p',
    judgeRubric: RUBRIC,
  };
  const packetA = fakePacket('min-opus', 'claude-sdk');
  const packetB = fakePacket('min-gpt55', 'codex');

  const open = buildPairwiseJudgePrompt(evalCase, packetA, packetB);
  assert.match(open, /min-opus/);
  assert.match(open, /codex/);

  const blinded = buildPairwiseJudgePrompt(evalCase, packetA, packetB, { blind: true });
  assert.doesNotMatch(blinded, /min-opus|min-gpt55/);
  assert.doesNotMatch(blinded, /claude-sdk|codex|claude-opus|gpt-5/);
  assert.match(blinded, /identifiers have been redacted/);
  assert.match(blinded, /Run A Packet/);
});

test('objective checks run in the executed workspace, not the case fixture', async () => {
  const { resolveObjectiveWorkspace } = await import('../dist/lab/objective-checks.js');
  const evalCase = { workspaceFixture: 'lab/fixtures/greenfield' };

  assert.match(
    resolveObjectiveWorkspace(evalCase, null, '/tmp/run/workspace'),
    /\/tmp\/run\/workspace$/,
  );
  assert.match(
    resolveObjectiveWorkspace(evalCase, '/explicit/ws', '/tmp/run/workspace'),
    /\/explicit\/ws$/,
  );
  assert.match(
    resolveObjectiveWorkspace(evalCase, null, ''),
    /lab\/fixtures\/greenfield$/,
  );
});
