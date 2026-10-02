import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { loadConfig } from '../dist/core/config.js';
import { HarnessRunner } from '../dist/core/harness.js';

const ALL_ROLES = ['researcher', 'planner', 'generator', 'evaluator'];
const PASSING_SCORES = {
  conceptAlignment: 5,
  completeness: 5,
  craft: 5,
  intentionality: 5,
  artifactCompatibility: 5,
  verificationEvidence: 5,
};
const FAILING_SCORES = Object.fromEntries(Object.keys(PASSING_SCORES).map((key) => [key, 1]));

const silentOutput = { log() {} };

async function setupMinimalRun(extraConfig = {}) {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-minimal-run-'));
  const configPath = path.join(tempRoot, 'harness.config.json');
  await fs.writeFile(
    configPath,
    `${JSON.stringify({ workspace: 'workspace', runRoot: 'run-root', ...extraConfig }, null, 2)}\n`,
  );
  const { config } = await loadConfig(configPath, {}, { profile: 'minimal' });
  return { tempRoot, config };
}

function createFakeRegistry(options) {
  const labels = [];
  return {
    labels,
    getRouting() {
      return Object.fromEntries(ALL_ROLES.map((role) => [role, 'claude-sdk']));
    },
    getProviderName() {
      return 'claude-sdk';
    },
    getTaskCapabilities(role) {
      return { role, provider: 'claude-sdk', hasBrowserQa: false, supportsSessionResume: true };
    },
    async runTask(task) {
      labels.push(task.label);
      await options.beforeTask?.(task);

      if (task.kind === 'generator') {
        for (const artifactPath of Object.values(task.artifacts)) {
          await fs.mkdir(path.dirname(artifactPath), { recursive: true });
          await fs.writeFile(artifactPath, 'updated by fake generator\n');
        }
        return {
          rawText: '{"status":"ok","summary":"implemented"}',
          parsed: { status: 'ok', summary: 'implemented', filesTouched: [], commandsRun: [] },
          meta: { sessionId: 'fake-session' },
        };
      }

      if (task.kind === 'evaluator') {
        const scores = options.scoresForRound(task.evaluationRound ?? 0);
        const canonicalEval = {
          version: 1,
          sprint: task.sprintNumber ?? 1,
          evaluationRound: task.evaluationRound ?? 0,
          feature: { id: task.feature.id, title: task.feature.title },
          confidence: 'high',
          evidenceQuality: 'strong',
          summary: 'fake evaluation',
          scores,
          contractCriteria: [],
          projectPrinciples: [],
          bugs: [],
          suggestedRepairPlan: [],
          notes: [],
          sourceMarkdownPath: task.artifacts.eval,
          devSmoke: { required: false, ok: true, logPath: null, url: null },
        };
        await fs.mkdir(path.dirname(task.artifacts.eval), { recursive: true });
        await fs.writeFile(task.artifacts.eval, '# Fake evaluation\n');
        await fs.writeFile(task.artifacts.evalJson, JSON.stringify(canonicalEval, null, 2));
        await options.afterEvaluation?.(task, canonicalEval);
        return {
          rawText: JSON.stringify(canonicalEval),
          parsed: { summary: 'fake evaluation', scores },
          meta: {},
        };
      }

      throw new Error(`Unexpected ${task.kind} task in minimal mode: ${task.label}`);
    },
  };
}


async function interruptedRun(config, registry) {
  const runner = new HarnessRunner(config, registry, silentOutput);
  await assert.rejects(() => runner.runNew('Build a tiny tool'), /disconnect/);
  const [runId] = await fs.readdir(path.join(config.runRoot, 'runs'));
  return { runner, runId, runDir: path.join(config.runRoot, 'runs', runId) };
}

test('resume continues an interrupted active sprint at maxSprints', async (t) => {
  const { tempRoot, config } = await setupMinimalRun({ maxSprints: 1 });
  t.after(() => fs.rm(tempRoot, { recursive: true, force: true }));
  let first = true;
  const registry = createFakeRegistry({ scoresForRound: () => PASSING_SCORES, beforeTask() {
    if (first) { first = false; throw new Error('disconnect'); }
  } });
  const { runner, runId } = await interruptedRun(config, registry);
  const state = await runner.resume(runId);
  assert.equal(state.status, 'completed');
  assert.equal(state.sprint, 1);
  assert.deepEqual(registry.labels, ['generator-s1-r0', 'generator-s1-r0', 'evaluator-s1-r0']);
});

test('resume replays provider-written evaluation artifacts without a committed verdict', async (t) => {
  const { tempRoot, config } = await setupMinimalRun({ maxSprints: 1, maxRepairRounds: 0 });
  t.after(() => fs.rm(tempRoot, { recursive: true, force: true }));
  let first = true;
  const registry = createFakeRegistry({ scoresForRound: () => PASSING_SCORES, async afterEvaluation(task, evaluation) {
    if (first) {
      first = false;
      const runDir = path.dirname(path.dirname(task.artifacts.eval));
      await fs.writeFile(path.join(runDir, 'logs', 'evaluator-s01-r00.parsed.json'), JSON.stringify(evaluation));
      throw new Error('disconnect');
    }
  } });
  const { runner, runId } = await interruptedRun(config, registry);
  assert.equal((await runner.resume(runId)).status, 'completed');
  assert.deepEqual(registry.labels, ['generator-s1-r0', 'evaluator-s1-r0', 'generator-s1-r0', 'evaluator-s1-r0']);
});

test('resume restores failed evaluation and its repair directive without consuming another round', async (t) => {
  const { tempRoot, config } = await setupMinimalRun({ maxSprints: 1, maxRepairRounds: 1 });
  t.after(() => fs.rm(tempRoot, { recursive: true, force: true }));
  let firstRepair = true;
  let resumedPrompt;
  const registry = createFakeRegistry({ scoresForRound: (round) => round === 0 ? FAILING_SCORES : PASSING_SCORES,
    beforeTask(task) {
      if (task.label === 'generator-s1-r1') {
        if (firstRepair) { firstRepair = false; throw new Error('disconnect'); }
        resumedPrompt = task.prompt;
        assert.equal(task.resumeSessionId, 'fake-session');
      }
    },
  });
  const { runner, runId, runDir } = await interruptedRun(config, registry);
  await fs.rm(path.join(runDir, 'repair-directives', 'repair-s01-r00.json'));
  assert.equal((await runner.resume(runId)).status, 'completed');
  assert.match(resumedPrompt, /repair-s01-r00.json/);
  assert.deepEqual(registry.labels, ['generator-s1-r0', 'evaluator-s1-r0', 'generator-s1-r1', 'generator-s1-r1', 'evaluator-s1-r1']);
});

test('resume trusts finalized evaluation but rejects altered frozen evidence', async (t) => {
  for (const tamper of [false, true]) {
    const { tempRoot, config } = await setupMinimalRun({ maxSprints: 1 });
    t.after(() => fs.rm(tempRoot, { recursive: true, force: true }));
    const registry = createFakeRegistry({ scoresForRound: () => PASSING_SCORES });
    const runner = new HarnessRunner(config, registry, silentOutput);
    const originalMarkDone = runner.markFeatureDone;
    runner.markFeatureDone = () => { throw new Error('disconnect'); };
    await assert.rejects(() => runner.runNew('Build a tiny tool'), /disconnect/);
    const [runId] = await fs.readdir(path.join(config.runRoot, 'runs'));
    runner.markFeatureDone = originalMarkDone;
    if (tamper) {
      const state = await runner.status(runId);
      const frozenDir = runner.frozenEvidenceDir(1, 0, state.runDir);
      const manifestPath = path.join(frozenDir, 'manifest.json');
      const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
      manifest.files.push({ path: 'missing-evidence.txt', sha256: 'unavailable' });
      await fs.writeFile(manifestPath, JSON.stringify(manifest));
      await assert.rejects(() => runner.resume(runId), /Frozen evaluator evidence was modified/);
    } else {
      assert.equal((await runner.resume(runId)).status, 'completed');
    }
    assert.deepEqual(registry.labels, ['generator-s1-r0', 'evaluator-s1-r0']);
  }
});


test('resume replays a round if its frozen evidence was not completed', async (t) => {
  const { tempRoot, config } = await setupMinimalRun({ maxSprints: 1, maxRepairRounds: 0 });
  t.after(() => fs.rm(tempRoot, { recursive: true, force: true }));
  const registry = createFakeRegistry({ scoresForRound: () => PASSING_SCORES });
  const runner = new HarnessRunner(config, registry, silentOutput);
  const originalMarkDone = runner.markFeatureDone;
  runner.markFeatureDone = () => { throw new Error('disconnect'); };
  await assert.rejects(() => runner.runNew('Build a tiny tool'), /disconnect/);
  const [runId] = await fs.readdir(path.join(config.runRoot, 'runs'));
  const state = await runner.status(runId);
  await fs.rm(runner.frozenEvidenceDir(1, 0, state.runDir), { recursive: true, force: true });
  runner.markFeatureDone = originalMarkDone;
  assert.equal((await runner.resume(runId)).status, 'completed');
  assert.deepEqual(registry.labels, ['generator-s1-r0', 'evaluator-s1-r0', 'generator-s1-r0', 'evaluator-s1-r0']);
});

test('resume retains a synthetic smoke-failure verdict without evaluator evidence', async (t) => {
  const { tempRoot, config } = await setupMinimalRun({ maxSprints: 1, maxRepairRounds: 1, smoke: { test: 'exit 1' } });
  t.after(() => fs.rm(tempRoot, { recursive: true, force: true }));
  let firstRepair = true;
  const registry = createFakeRegistry({ scoresForRound: () => PASSING_SCORES, beforeTask(task) {
    if (task.label === 'generator-s1-r1' && firstRepair) {
      firstRepair = false;
      throw new Error('disconnect');
    }
  } });
  const { runner, runId, runDir } = await interruptedRun(config, registry);
  const verdict = JSON.parse(await fs.readFile(path.join(runDir, 'verdicts', 'verdict-01-r00.json'), 'utf8'));
  assert.equal(verdict.reason, 'smoke_failure');
  await assert.rejects(fs.access(runner.frozenEvidenceDir(1, 0, runDir)), { code: 'ENOENT' });
  config.smoke.test = 'exit 0';
  assert.equal((await runner.resume(runId)).status, 'completed');
  assert.deepEqual(registry.labels, ['generator-s1-r0', 'generator-s1-r1', 'generator-s1-r1', 'evaluator-s1-r1']);
});
