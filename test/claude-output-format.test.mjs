import test from 'node:test';
import assert from 'node:assert/strict';

import { buildClaudeTaskOutputFormat, claudeResultError } from '../dist/core/providers/claude-sdk.js';

function requiredFor(kind, label) {
  const outputFormat = buildClaudeTaskOutputFormat({ kind, label });
  assert.equal(outputFormat.type, 'json_schema');
  return outputFormat.schema.required;
}

test('claude output format asks for structured evaluator results', () => {
  const required = requiredFor('evaluator', 'evaluator-s1-r0');

  assert.deepEqual(required, ['summary', 'confidence', 'evidenceQuality', 'scores', 'bugs']);
});

test('claude output format distinguishes contract review status shape', () => {
  const outputFormat = buildClaudeTaskOutputFormat({
    kind: 'evaluator',
    label: 'contract-review-s1-n0',
  });

  assert.deepEqual(outputFormat.schema.required, ['status', 'summary', 'feedback']);
  assert.deepEqual(outputFormat.schema.properties.status.enum, ['approved', 'revise']);
});

test('claude output format keeps implementation tasks permissive but structured', () => {
  const outputFormat = buildClaudeTaskOutputFormat({
    kind: 'generator',
    label: 'generator-s1-r0',
  });

  assert.deepEqual(outputFormat.schema.required, ['status', 'summary']);
  assert.equal(outputFormat.schema.additionalProperties, true);
});

test('claude output format uses pairwise judge schema for meta and matrix judges', () => {
  for (const label of ['meta-judge-examples-adaptive-dashboard-filtering', 'matrix-judge-harness-cli-error-ergonomics']) {
    const outputFormat = buildClaudeTaskOutputFormat({
      kind: 'evaluator',
      label,
    });

    assert.deepEqual(outputFormat.schema.required, [
      'winner',
      'confidence',
      'dimensionScores',
      'criticalRegressions',
      'rationale',
    ]);
    assert.deepEqual(outputFormat.schema.properties.winner.enum, ['A', 'B', 'tie', 'inconclusive']);
    assert.equal(outputFormat.schema.properties.dimensionScores.type, 'object');
  }
});

test('Claude SDK result failures preserve execution and limit diagnostics', () => {
  for (const subtype of ['error_during_execution', 'error_max_turns', 'error_max_budget_usd', 'error_max_structured_output_retries']) {
    assert.equal(claudeResultError({ type: 'result', subtype, errors: ['first failure', 'second failure'] }), 'first failure; second failure');
    assert.equal(claudeResultError({ type: 'result', subtype, errors: [] }), `Query ended with ${subtype}`);
  }
  assert.equal(claudeResultError({ type: 'result', subtype: 'success', is_error: true, result: 'access denied' }), 'access denied');
  assert.equal(claudeResultError({ type: 'result', subtype: 'success', result: 'done' }), null);
  assert.equal(claudeResultError({ type: 'assistant', subtype: 'error' }), null);
});

test('default and example Claude configuration select Opus 5.5 while preserving explicit overrides', async () => {
  const { DEFAULT_CONFIG, loadConfig } = await import('../dist/core/config.js');
  const { readFile } = await import('node:fs/promises');
  const example = JSON.parse(await readFile(new URL('../examples/harness.config.json', import.meta.url), 'utf8'));
  assert.equal(DEFAULT_CONFIG.claudeSdk.model, 'claude-opus-5-5');
  assert.equal(example.claudeSdk.model, DEFAULT_CONFIG.claudeSdk.model);
  const { config } = await loadConfig(undefined, { claudeSdk: { model: 'claude-opus-4-7' } });
  assert.equal(config.claudeSdk.model, 'claude-opus-4-7');
});
