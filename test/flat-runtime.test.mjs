import test from 'node:test';
import assert from 'node:assert/strict';

import { buildFlatRuntimeArtifacts } from '../dist/core/flat-runtime.js';
import { validateBacklog, validateBacklogSprintBudget } from '../dist/core/utils.js';

test('flat runtime artifacts preserve canonical planning shape without role execution', () => {
  const artifacts = buildFlatRuntimeArtifacts({
    prompt: 'Build a CLI flag parser with deterministic validation.',
    maxSprints: 2,
  });

  const backlog = validateBacklogSprintBudget(validateBacklog(artifacts.backlog), 2);

  assert.equal(backlog.features.length, 1);
  assert.equal(backlog.features[0].id, 'F01');
  assert.equal(backlog.features[0].status, 'pending');
  assert.match(backlog.features[0].acceptanceCriteria.join('\n'), /progress\.md/);

  assert.equal(artifacts.evalCriteria.version, 1);
  assert.deepEqual(Object.keys(artifacts.evalCriteria.universalCriteria).sort(), [
    'completeness',
    'conceptAlignment',
    'craft',
    'intentionality',
  ]);
  assert.ok(artifacts.evalCriteria.projectCriteria.some((criterion) => criterion.id === 'artifactCompatibility'));
  assert.ok(artifacts.evalCriteria.projectCriteria.some((criterion) => criterion.id === 'verificationEvidence'));

  assert.match(artifacts.researchBrief, /runtimeMode: flat/);
  assert.match(artifacts.spec, /packetize the resulting run without Pi-specific/);
  assert.match(artifacts.projectPrinciples, /Preserve auditability/);
});

test('flat runtime artifacts stay within a one-sprint budget', () => {
  const artifacts = buildFlatRuntimeArtifacts({
    prompt: 'Do the requested work.',
    maxSprints: 1,
  });

  assert.doesNotThrow(() => validateBacklogSprintBudget(validateBacklog(artifacts.backlog), 1));
});
