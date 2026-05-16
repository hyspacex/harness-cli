import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { findLatestRunArtifactBundle } from '../dist/artifacts/run-reader.js';

function runState(id, runDir, updatedAt) {
  return {
    id,
    prompt: 'Synthetic run',
    provider: 'claude-sdk',
    executionProfile: null,
    roleProviders: {
      researcher: 'claude-sdk',
      planner: 'claude-sdk',
      generator: 'codex',
      evaluator: 'claude-sdk',
    },
    workspace: path.dirname(runDir),
    runDir,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt,
    status: 'completed',
    lastError: null,
    sprint: 1,
    currentFeatureId: null,
    summary: 'done',
  };
}

test('latest run artifact reader ignores stray entries without run.json', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-artifact-reader-stray-'));
  const runRoot = path.join(tempRoot, 'run-root');
  const runsDir = path.join(runRoot, 'runs');
  const runDir = path.join(runsDir, 'valid-run');

  await fs.mkdir(path.join(runsDir, 'stray-dir'), { recursive: true });
  await fs.mkdir(runDir, { recursive: true });
  await fs.writeFile(path.join(runsDir, 'not-a-run.txt'), 'ignore me\n');
  await fs.writeFile(path.join(runDir, 'run.json'), JSON.stringify(runState('valid-run', runDir, '2026-01-01T00:00:01.000Z'), null, 2));

  const bundle = await findLatestRunArtifactBundle(runRoot);

  assert.equal(bundle?.run.id, 'valid-run');
});

test('latest run artifact reader surfaces malformed run.json instead of falling back to older run', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-artifact-reader-malformed-'));
  const runRoot = path.join(tempRoot, 'run-root');
  const runsDir = path.join(runRoot, 'runs');
  const oldRunDir = path.join(runsDir, 'old-valid-run');
  const newRunDir = path.join(runsDir, 'new-malformed-run');

  await fs.mkdir(oldRunDir, { recursive: true });
  await fs.mkdir(newRunDir, { recursive: true });
  await fs.writeFile(path.join(oldRunDir, 'run.json'), JSON.stringify(runState('old-valid-run', oldRunDir, '2026-01-01T00:00:01.000Z'), null, 2));
  await fs.writeFile(path.join(newRunDir, 'run.json'), '{"id":');

  await assert.rejects(
    () => findLatestRunArtifactBundle(runRoot),
    /Invalid run artifact at .*new-malformed-run/,
  );
});
