import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { classifyCeremonyLevel, parseRuntimeMode, resolveCeremony } from '../dist/core/ceremony.js';
import { buildOverrides } from '../dist/cli-flags.js';
import { loadConfig } from '../dist/core/config.js';
import { buildHarnessAuthoredContract } from '../dist/core/contract-bootstrap.js';
import { resolveExecutionProfile } from '../dist/core/profiles.js';
import { deriveContractPassBarOverrides } from '../dist/core/utils.js';

async function writeTempConfig(value) {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-ceremony-config-'));
  const configPath = path.join(tempRoot, 'harness.config.json');
  await fs.writeFile(configPath, `${JSON.stringify(value, null, 2)}\n`);
  return configPath;
}

test('runtimeMode is sugar for the ceremony ladder', () => {
  const full = resolveCeremony({ runtimeMode: 'full', maxNegotiationRounds: 3, ceremony: {} });
  assert.deepEqual(full, { researcher: true, planner: true, negotiationRounds: 3 });
  assert.equal(classifyCeremonyLevel(full), 'full');

  const flat = resolveCeremony({ runtimeMode: 'flat', maxNegotiationRounds: 1, ceremony: {} });
  assert.deepEqual(flat, { researcher: false, planner: false, negotiationRounds: 1 });
  assert.equal(classifyCeremonyLevel(flat), 'flat');

  const minimal = resolveCeremony({ runtimeMode: 'minimal', maxNegotiationRounds: 3, ceremony: {} });
  assert.deepEqual(minimal, { researcher: false, planner: false, negotiationRounds: 0 });
  assert.equal(classifyCeremonyLevel(minimal), 'minimal');
});

test('explicit ceremony dials override the mode-derived defaults', () => {
  const ceremony = resolveCeremony({
    runtimeMode: 'full',
    maxNegotiationRounds: 3,
    ceremony: { planner: false, negotiationRounds: 0 },
  });

  assert.deepEqual(ceremony, { researcher: true, planner: false, negotiationRounds: 0 });
  assert.equal(classifyCeremonyLevel(ceremony), 'custom');
});

test('parseRuntimeMode rejects unknown modes', () => {
  assert.equal(parseRuntimeMode('minimal'), 'minimal');
  assert.throws(() => parseRuntimeMode('turbo'), /Invalid runtime mode/);
  assert.throws(() => buildOverrides({ 'runtime-mode': 'turbo' }), /Invalid runtime mode/);
  assert.equal(buildOverrides({ 'runtime-mode': 'flat' }).runtimeMode, 'flat');
});

test('minimal and flat ladder profiles resolve through config', async () => {
  const minimalProfile = resolveExecutionProfile('minimal');
  assert.equal(minimalProfile.config.runtimeMode, 'minimal');

  const flatProfile = resolveExecutionProfile('flat');
  assert.equal(flatProfile.config.runtimeMode, 'flat');
  assert.equal(flatProfile.config.maxNegotiationRounds, 1);

  const configPath = await writeTempConfig({});
  const { config } = await loadConfig(configPath, {}, { profile: 'minimal' });
  assert.equal(config.runtimeMode, 'minimal');
  assert.equal(classifyCeremonyLevel(resolveCeremony(config)), 'minimal');
});

test('harness-authored contract is canonical and cannot weaken pass bars', () => {
  const feature = {
    id: 'F01',
    title: 'Build the thing',
    acceptanceCriteria: ['It works end to end.', 'Tests cover the failure path.'],
    dependsOn: [],
    status: 'pending',
  };
  const { markdown, contract } = buildHarnessAuthoredContract({
    feature,
    sprint: 1,
    contractMarkdownPath: '/tmp/run/contracts/contract-01.md',
    smoke: { start: null, test: 'npm test' },
  });

  assert.equal(contract.version, 1);
  assert.equal(contract.feature.id, 'F01');
  assert.equal(contract.doneMeans.length, 2);
  assert.ok(Array.isArray(contract.verificationSteps) && contract.verificationSteps.length > 0);
  assert.ok(Array.isArray(contract.hardThresholds) && contract.hardThresholds.length > 0);
  assert.equal(contract.sourceMarkdownPath, '/tmp/run/contracts/contract-01.md');
  assert.equal(contract.passBarOverrides, undefined);
  assert.deepEqual(deriveContractPassBarOverrides(contract, null), {});
  assert.match(markdown, /authored by the harness/);
  assert.match(markdown, /npm test/);
});
