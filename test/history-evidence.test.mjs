import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { buildCeremonyRoiReport, renderCeremonyRoiMarkdown } from '../dist/core/ceremony-roi.js';
import {
  ceremonyLevelForProfile,
  loadRunHistory,
  recommendProfilesWithEvidence,
  summarizeProfileEvidence,
} from '../dist/core/history.js';

const BACKEND_PROMPT = 'Create a REST API server for invoices with a database schema.';

async function makeRunRoot() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'harness-history-'));
}

async function writeRun(runRoot, runId, options) {
  const runDir = path.join(runRoot, 'runs', runId);
  await fs.mkdir(runDir, { recursive: true });
  const generatorMetrics = {
    role: 'generator',
    provider: options.provider || 'claude-sdk',
    tasksStarted: options.tasksStarted ?? 6,
    tasksFinished: options.tasksStarted ?? 6,
    parseSuccesses: options.tasksStarted ?? 6,
    parseFailures: 0,
    contractApprovalAttempts: 0,
    contractApprovalPasses: 0,
    repairRoundsToPass: options.repairRoundsToPass ?? [0],
    finalRegressionFailures: 0,
    devSmokePassed: 0,
    devSmokeFailed: 0,
    evaluatorConfidence: { low: 0, medium: 0, high: 0, unknown: 0 },
    evidenceQuality: { weak: 0, adequate: 0, strong: 0, unknown: 0 },
  };
  const evaluatorMetrics = {
    ...generatorMetrics,
    role: 'evaluator',
    repairRoundsToPass: [],
    contractApprovalAttempts: options.contractApprovalAttempts ?? 0,
    contractApprovalPasses: options.contractApprovalPasses ?? 0,
  };

  await fs.writeFile(
    path.join(runDir, 'run.json'),
    JSON.stringify({
      id: runId,
      prompt: options.prompt || BACKEND_PROMPT,
      provider: options.provider || 'claude-sdk',
      executionProfile: options.profile,
      roleProviders: {
        researcher: options.provider || 'claude-sdk',
        planner: options.provider || 'claude-sdk',
        generator: options.provider || 'claude-sdk',
        evaluator: options.provider || 'claude-sdk',
      },
      workspace: '/tmp/w',
      runDir,
      createdAt: '2026-06-01T00:00:00.000Z',
      updatedAt: '2026-06-01T00:10:00.000Z',
      status: options.status || 'completed',
      lastError: null,
      sprint: 1,
      repairRound: 0,
      currentFeatureId: null,
      summary: 'done',
      metrics: {
        completedFeatures: options.status === 'failed' ? 0 : 1,
        blockedFeatures: 0,
        finalRegressionFailures: options.finalRegressionFailures ?? 0,
        rolePerformance: {
          [`generator@${options.provider || 'claude-sdk'}`]: generatorMetrics,
          [`evaluator@${options.provider || 'claude-sdk'}`]: evaluatorMetrics,
        },
      },
      generatorSessionIds: {},
      currentNegotiation: null,
    }, null, 2),
  );
}

test('profile evidence summarizes run history per profile', async () => {
  const runRoot = await makeRunRoot();
  await writeRun(runRoot, 'r1', { profile: 'minimal', tasksStarted: 4 });
  await writeRun(runRoot, 'r2', { profile: 'minimal', tasksStarted: 4, repairRoundsToPass: [1] });
  await writeRun(runRoot, 'r3', { profile: 'full-harness', tasksStarted: 12, contractApprovalAttempts: 2, contractApprovalPasses: 1 });
  await writeRun(runRoot, 'r4', { profile: 'full-harness', tasksStarted: 14, status: 'failed' });
  await writeRun(runRoot, 'r5', { profile: 'minimal', status: 'created' });

  const entries = await loadRunHistory(runRoot);
  assert.equal(entries.length, 4, 'in-flight runs are excluded');
  assert.ok(entries.every((entry) => entry.category === 'backend'));

  const evidence = summarizeProfileEvidence(entries);
  const minimal = evidence.find((item) => item.profile === 'minimal');
  const full = evidence.find((item) => item.profile === 'full-harness');
  assert.equal(minimal.runs, 2);
  assert.equal(minimal.completionRate, 1);
  assert.equal(minimal.avgTasksStarted, 8, 'sums tasksStarted across generator and evaluator roles');
  assert.equal(minimal.firstRoundPassRate, 0.5);
  assert.equal(full.completionRate, 0.5);
  assert.equal(full.avgTasksStarted, 26);
});

test('recommendation prefers the cheapest profile within tolerance of the best', async () => {
  const runRoot = await makeRunRoot();
  for (let i = 0; i < 3; i += 1) {
    await writeRun(runRoot, `min-${i}`, { profile: 'minimal', tasksStarted: 4 });
    await writeRun(runRoot, `full-${i}`, { profile: 'full-harness', tasksStarted: 12 });
  }

  const recommendation = await recommendProfilesWithEvidence({
    runRoot,
    prompt: BACKEND_PROMPT,
  });

  assert.equal(recommendation.source, 'evidence');
  assert.equal(recommendation.scope, 'category');
  assert.equal(recommendation.category, 'backend');
  assert.equal(recommendation.profiles[0], 'minimal');
  assert.equal(recommendation.evidence.length, 2);
});

test('recommendation falls back to the keyword heuristic without comparable history', async () => {
  const runRoot = await makeRunRoot();
  await writeRun(runRoot, 'only', { profile: 'minimal' });

  const recommendation = await recommendProfilesWithEvidence({
    runRoot,
    prompt: BACKEND_PROMPT,
  });

  assert.equal(recommendation.source, 'heuristic');
  assert.deepEqual(recommendation.profiles, ['fast', 'balanced']);
});

test('ceremony levels derive from profile configs', () => {
  assert.equal(ceremonyLevelForProfile('minimal'), 'minimal');
  assert.equal(ceremonyLevelForProfile('flat'), 'flat');
  assert.equal(ceremonyLevelForProfile('full-harness'), 'full');
  assert.equal(ceremonyLevelForProfile(null), 'full');
  assert.equal(ceremonyLevelForProfile('no-such-profile'), 'unknown');
});

test('ceremony ROI report compares ladder rungs per provider', async () => {
  const runRoot = await makeRunRoot();
  for (let i = 0; i < 2; i += 1) {
    await writeRun(runRoot, `min-${i}`, { profile: 'minimal', tasksStarted: 4 });
    await writeRun(runRoot, `full-${i}`, {
      profile: 'full-harness',
      tasksStarted: 12,
      contractApprovalAttempts: 2,
      contractApprovalPasses: 2,
    });
  }

  const entries = await loadRunHistory(runRoot);
  const report = buildCeremonyRoiReport(entries, {
    runRoot,
    builtAt: '2026-06-09T00:00:00.000Z',
  });

  assert.equal(report.totalRuns, 4);
  const levels = report.rows.map((row) => row.ceremonyLevel);
  assert.deepEqual(levels, ['minimal', 'full']);
  const fullRow = report.rows.find((row) => row.ceremonyLevel === 'full');
  assert.equal(fullRow.negotiationApprovalRate, 1);

  assert.equal(report.findings.length, 1);
  assert.match(report.findings[0], /full ceremony vs minimal/);
  assert.match(report.findings[0], /NOT buying/);

  const markdown = renderCeremonyRoiMarkdown(report);
  assert.match(markdown, /# Ceremony ROI Report/);
  assert.match(markdown, /\| claude-sdk \| minimal \|/);
});
