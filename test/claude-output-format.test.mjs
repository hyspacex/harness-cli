import test from 'node:test';
import assert from 'node:assert/strict';

import { buildClaudeTaskOutputFormat } from '../dist/providers/claude-sdk.js';

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
