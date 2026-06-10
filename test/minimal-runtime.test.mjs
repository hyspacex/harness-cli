import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { loadConfig } from '../dist/config.js';
import { HarnessRunner } from '../dist/harness.js';

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

test('minimal ceremony skips role tasks but keeps harness verification gates', async () => {
  const { config } = await setupMinimalRun();
  const registry = createFakeRegistry({ scoresForRound: () => PASSING_SCORES });
  const runner = new HarnessRunner(config, registry, silentOutput);

  const runState = await runner.runNew('Build a tiny tool');

  assert.equal(runState.status, 'completed');
  assert.deepEqual(registry.labels, ['generator-s1-r0', 'evaluator-s1-r0']);

  const contract = JSON.parse(
    await fs.readFile(path.join(runState.runDir, 'contracts', 'contract-01.json'), 'utf8'),
  );
  assert.equal(contract.version, 1);
  assert.equal(contract.passBarOverrides, undefined);
  assert.match(
    await fs.readFile(path.join(runState.runDir, 'contracts', 'contract-01.md'), 'utf8'),
    /authored by the harness/,
  );

  const verdict = JSON.parse(
    await fs.readFile(path.join(runState.runDir, 'verdicts', 'verdict-01-r00.json'), 'utf8'),
  );
  assert.equal(verdict.passed, true);
  assert.equal(verdict.reason, 'all_scores_met');

  for (const planArtifact of ['research-brief.md', 'eval-criteria.json', 'spec.md', 'backlog.json', 'project-principles.md']) {
    await fs.access(path.join(runState.runDir, 'plan', planArtifact));
  }
  assert.match(
    await fs.readFile(path.join(runState.runDir, 'plan', 'research-brief.md'), 'utf8'),
    /runtimeMode: minimal/,
  );
});

test('minimal ceremony still fails the run when harness verdict fails', async () => {
  const { config } = await setupMinimalRun({ maxRepairRounds: 1 });
  const registry = createFakeRegistry({ scoresForRound: () => FAILING_SCORES });
  const runner = new HarnessRunner(config, registry, silentOutput);

  await assert.rejects(() => runner.runNew('Build a tiny tool'), /failed evaluation/);

  const runsDir = path.join(config.runRoot, 'runs');
  const [runId] = await fs.readdir(runsDir);
  const runDir = path.join(runsDir, runId);

  const verdict = JSON.parse(
    await fs.readFile(path.join(runDir, 'verdicts', 'verdict-01-r00.json'), 'utf8'),
  );
  assert.equal(verdict.passed, false);
  assert.equal(verdict.reason, 'score_below_threshold');
  assert.ok(verdict.failingScores.length > 0);

  await fs.access(path.join(runDir, 'repair-directives', 'repair-s01-r00.json'));
  assert.deepEqual(registry.labels, [
    'generator-s1-r0',
    'evaluator-s1-r0',
    'generator-s1-r1',
    'evaluator-s1-r1',
  ]);
});
