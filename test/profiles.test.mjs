import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { loadConfig } from '../dist/config.js';
import { expandExecutionProfileSelection, listExecutionProfiles } from '../dist/profiles.js';

async function writeTempConfig(value) {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-profile-config-'));
  const configPath = path.join(tempRoot, 'harness.config.json');
  await fs.writeFile(configPath, `${JSON.stringify(value, null, 2)}\n`);
  return configPath;
}

test('built-in codex-only profile routes every role through codex', async () => {
  const configPath = await writeTempConfig({});
  const { config } = await loadConfig(configPath, {}, { profile: 'codex-only' });

  assert.equal(config.provider, 'codex');
  assert.deepEqual(config.roleProviders, {
    researcher: 'codex',
    planner: 'codex',
    generator: 'codex',
    evaluator: 'codex',
  });
});

test('custom sparse profiles inherit the surrounding provider routing', async () => {
  const configPath = await writeTempConfig({
    provider: 'codex',
    profiles: {
      'claude-eval': {
        roleProviders: {
          evaluator: 'claude-sdk',
        },
      },
    },
  });
  const { config } = await loadConfig(configPath, {}, { profile: 'claude-eval' });

  assert.equal(config.provider, 'codex');
  assert.deepEqual(config.roleProviders, {
    researcher: 'codex',
    planner: 'codex',
    generator: 'codex',
    evaluator: 'claude-sdk',
  });
});

test('adaptive profile selection chooses a fast scout and visual QA for frontend work', () => {
  const profiles = listExecutionProfiles();
  const names = profiles.map((profile) => profile.name);
  const selection = expandExecutionProfileSelection('adaptive', {
    category: 'frontend',
    prompt: 'Improve the adaptive dashboard filtering and empty states.',
  });

  assert.ok(names.includes('fast'));
  assert.ok(names.includes('visual-qa'));
  assert.deepEqual(selection, ['fast', 'visual-qa']);
});
