import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { buildEvalRunPacket } from '../dist/lab/packet.js';
import { PiProvider } from '../dist/core/providers/pi.js';
import { createProvider } from '../dist/core/providers/index.js';
import { DEFAULT_CONFIG } from '../dist/core/config.js';
import { resolveExecutionProfile } from '../dist/core/profiles.js';

class FakePiTransport {
  constructor(result) {
    this.result = result;
    this.requests = [];
  }

  async run(request) {
    this.requests.push(request);
    return this.result;
  }
}

function generatorTask(overrides = {}) {
  return {
    kind: 'generator',
    label: 'generator-s01-r0',
    cwd: process.cwd(),
    prompt: 'Implement the feature and return JSON.',
    artifacts: {},
    ...overrides,
  };
}

test('PiProvider generator task returns TaskResult from fake transport output', async () => {
  const transport = new FakePiTransport({
    stdout: [
      JSON.stringify({
        type: 'message_update',
        assistantMessageEvent: {
          type: 'text_end',
          content: '{"summary":"Pi wrote the feature","filesWritten":["src/app.ts"]}',
        },
      }),
      JSON.stringify({
        type: 'response',
        command: 'get_state',
        success: true,
        data: {
          sessionId: 'pi-session-1',
          sessionFile: '/tmp/pi-session.jsonl',
        },
      }),
    ].join('\n'),
    stderr: 'tool update\n',
    meta: { transport: 'fake', args: ['-p', 'transport raw prompt'] },
  });
  const stderrChunks = [];
  const provider = new PiProvider(
    {
      command: 'pi',
      args: ['--no-update-check'],
      env: { PI_TEST: '1' },
      provider: 'anthropic',
      model: 'anthropic/claude-sonnet-4-5',
      outputMode: 'json',
      noSession: true,
      sessionDir: null,
      timeoutMs: 1234,
      roleOverrides: {},
    },
    { onStdErr: (chunk) => stderrChunks.push(chunk) },
    transport,
  );

  const result = await provider.runTask(generatorTask());

  assert.equal(result.rawText, '{"summary":"Pi wrote the feature","filesWritten":["src/app.ts"]}');
  assert.deepEqual(result.parsed, {
    summary: 'Pi wrote the feature',
    filesWritten: ['src/app.ts'],
  });
  assert.equal(result.meta.sessionId, 'pi-session-1');
  assert.equal(result.meta.sessionFile, '/tmp/pi-session.jsonl');
  assert.equal(result.meta.transport, 'fake');
  assert.deepEqual(result.meta.args, [
    '--no-update-check',
    '--mode',
    'json',
    '--no-session',
    '--provider',
    'anthropic',
    '--model',
    'anthropic/claude-sonnet-4-5',
    '-p',
    '[redacted prompt]',
  ]);
  assert.doesNotMatch(JSON.stringify(result.meta), /Implement the feature and return JSON/);
  assert.doesNotMatch(JSON.stringify(result.meta), /transport raw prompt/);
  assert.deepEqual(stderrChunks, ['tool update\n']);

  assert.equal(transport.requests.length, 1);
  assert.equal(transport.requests[0].command, 'pi');
  assert.deepEqual(transport.requests[0].env, { PI_TEST: '1' });
  assert.equal(transport.requests[0].cwd, process.cwd());
  assert.equal(transport.requests[0].timeoutMs, 1234);
  assert.deepEqual(transport.requests[0].args, [
    '--no-update-check',
    '--mode',
    'json',
    '--no-session',
    '--provider',
    'anthropic',
    '--model',
    'anthropic/claude-sonnet-4-5',
    '-p',
    'Implement the feature and return JSON.',
  ]);
});

test('PiProvider spike rejects non-generator roles explicitly', async () => {
  const provider = new PiProvider({
    command: 'pi',
    args: [],
    env: {},
    provider: null,
    model: null,
    outputMode: 'json',
    noSession: false,
    sessionDir: null,
    timeoutMs: 1000,
    roleOverrides: {},
  }, {}, new FakePiTransport({ stdout: '{}', stderr: '' }));

  await assert.rejects(
    () => provider.runTask(generatorTask({ kind: 'planner', label: 'planner' })),
    /supports generator tasks only/,
  );
});

test('PiProvider redacts prompt-bearing args from CLI transport errors', async () => {
  const prompt = 'Sensitive repo context: SECRET_PROMPT_SHOULD_NOT_LEAK';
  const provider = new PiProvider({
    command: process.execPath,
    args: ['-e', 'setTimeout(() => {}, 1000)'],
    env: {},
    provider: null,
    model: null,
    outputMode: 'json',
    noSession: false,
    sessionDir: null,
    timeoutMs: 10,
    roleOverrides: {},
  });

  await assert.rejects(
    () => provider.runTask(generatorTask({ prompt })),
    (error) => {
      const message = error instanceof Error ? error.message : String(error);
      assert.match(message, /Pi provider exited with/);
      assert.match(message, /-p "\[redacted prompt\]"/);
      assert.match(message, /stdoutBytes:/);
      assert.match(message, /stderrBytes:/);
      assert.doesNotMatch(message, /SECRET_PROMPT_SHOULD_NOT_LEAK/);
      assert.doesNotMatch(message, /Sensitive repo context/);
      return true;
    },
  );
});

test('pi-generator-spike profile routes only generator through pi', () => {
  const profile = resolveExecutionProfile('pi-generator-spike');

  assert.equal(profile.config.provider, 'claude-sdk');
  assert.equal(profile.config.roleProviders?.researcher, 'claude-sdk');
  assert.equal(profile.config.roleProviders?.planner, 'claude-sdk');
  assert.equal(profile.config.roleProviders?.generator, 'pi');
  assert.equal(profile.config.roleProviders?.evaluator, 'claude-sdk');
});

test('provider registry can route generator tasks to pi runtime', async () => {
  const config = {
    ...DEFAULT_CONFIG,
    roleProviders: {
      researcher: 'claude-sdk',
      planner: 'claude-sdk',
      generator: 'pi',
      evaluator: 'claude-sdk',
    },
    pi: {
      ...DEFAULT_CONFIG.pi,
      command: 'fake-pi',
    },
  };
  const registry = createProvider(config);

  assert.equal(registry.getProviderName('generator'), 'pi');
  assert.equal(registry.getTaskCapabilities('generator').provider, 'pi');
  assert.equal(registry.getTaskCapabilities('generator').supportsSessionResume, false);
});

test('Pi-shaped run artifacts packetize without special cases', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-pi-packet-'));
  const runDir = path.join(tempRoot, 'runs', 'pi-run');
  await fs.mkdir(runDir, { recursive: true });
  await fs.writeFile(path.join(runDir, 'run.json'), JSON.stringify({
    id: 'pi-run',
    prompt: 'Build a demo',
    provider: 'researcher:claude-sdk, planner:claude-sdk, generator:pi, evaluator:claude-sdk',
    executionProfile: 'pi-generator-spike',
    roleProviders: {
      researcher: 'claude-sdk',
      planner: 'claude-sdk',
      generator: 'pi',
      evaluator: 'claude-sdk',
    },
    workspace: tempRoot,
    runDir,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:01.000Z',
    status: 'completed',
    lastError: null,
    sprint: 1,
    currentFeatureId: null,
    summary: 'Pi generator completed.',
  }, null, 2));
  await fs.writeFile(path.join(runDir, 'metrics.json'), JSON.stringify({ completedFeatures: 1 }, null, 2));

  const packet = await buildEvalRunPacket({ runDir });

  assert.equal(packet.run.id, 'pi-run');
  assert.equal(packet.run.executionProfile, 'pi-generator-spike');
  assert.equal(packet.run.roleProviders.generator, 'pi');
  assert.equal(packet.metrics?.completedFeatures, 1);
});
