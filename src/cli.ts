#!/usr/bin/env node
import path from 'node:path';
import { loadConfig, writeDefaultConfig } from './config.js';
import { HarnessRunner } from './harness.js';
import { createProvider } from './providers/index.js';
import { listDirectories, readJson } from './utils.js';
import type { HarnessConfig, RunState } from './types.js';

async function main(): Promise<void> {
  const { command, positionals, flags } = parseArgv(process.argv.slice(2));

  switch (command) {
    case 'init': {
      const configPath = await writeDefaultConfig(flags.config || 'harness.config.json');
      console.log(`Wrote ${configPath}`);
      console.log('Edit the provider settings, then run: harness run "Build a ..."');
      return;
    }
    case 'run': {
      const prompt = positionals.join(' ').trim();
      if (!prompt) {
        throw new Error('Provide a prompt. Example: harness run "Build a small CRM dashboard"');
      }
      const runner = await createRunner(flags);
      const result = await runner.runNew(prompt);
      printRunSummary(result);
      return;
    }
    case 'resume': {
      const runId = positionals[0];
      if (!runId) {
        throw new Error('Provide a run id. Example: harness resume 2026-04-02T12-00-00-000Z-my-run');
      }
      const runner = await createRunner(flags);
      const result = await runner.resume(runId);
      printRunSummary(result);
      return;
    }
    case 'status': {
      await printStatus(flags, positionals[0] || null);
      return;
    }
    case 'help':
    case undefined:
    default:
      printHelp();
  }
}

async function createRunner(flags: Record<string, string>): Promise<HarnessRunner> {
  const overrides = buildOverrides(flags);
  const { config } = await loadConfig(flags.config, overrides);
  const providerRegistry = createProvider(config, {
    onStdErr: (chunk) => {
      const text = String(chunk || '').trim();
      if (text) {
        console.error(`[agent] ${text}`);
      }
    },
    onUpdate: (update) => {
      if (update?.sessionUpdate === 'tool_call' && update.title) {
        console.error(`[tool] ${update.title}`);
      }
      if (update?.sessionUpdate === 'plan' && Array.isArray(update.entries)) {
        console.error(
          `[plan] ${(update.entries as Array<{ content: string }>).map((entry) => entry.content).join(' | ')}`,
        );
      }
    },
  });
  return new HarnessRunner(config, providerRegistry, console);
}

async function printStatus(flags: Record<string, string>, runId: string | null): Promise<void> {
  const overrides = buildOverrides(flags);
  const { config } = await loadConfig(flags.config, overrides);

  if (runId) {
    const run = await readJson<RunState | null>(path.join(config.runRoot, 'runs', runId, 'run.json'), null);
    if (!run) {
      throw new Error(`Run not found: ${runId}`);
    }
    printRunSummary(run);
    return;
  }

  const runIds = await listDirectories(path.join(config.runRoot, 'runs'));
  if (runIds.length === 0) {
    console.log(`No runs found under ${path.join(config.runRoot, 'runs')}`);
    return;
  }

  for (const id of runIds.slice(0, 20)) {
    const run = await readJson<RunState | null>(path.join(config.runRoot, 'runs', id, 'run.json'), null);
    if (!run) continue;
    console.log(
      `${run.id}\n  status: ${run.status}\n  providers: ${run.provider}\n  sprint: ${run.sprint}\n  summary: ${run.summary || '(none yet)'}\n`,
    );
  }
}

function printRunSummary(run: RunState): void {
  console.log('');
  console.log(`Run: ${run.id}`);
  console.log(`Status: ${run.status}`);
  console.log(`Providers: ${run.provider}`);
  console.log(`Workspace: ${run.workspace}`);
  console.log(`Sprint: ${run.sprint}`);
  if (run.currentFeatureId) {
    console.log(`Current feature: ${run.currentFeatureId}`);
  }
  if (run.summary) {
    console.log(`Summary: ${run.summary}`);
  }
  if (run.lastError) {
    console.log(`Last error: ${run.lastError}`);
  }
  console.log(`Artifacts: ${run.runDir}`);
}

function printHelp(): void {
  console.log(`harness

Commands:
  harness init [--config harness.config.json]
  harness run "Build a ..." [--config file] [--provider claude-sdk|codex] [--workspace path]
  harness resume <runId> [--config file]
  harness status [runId] [--config file]

Flags:
  --config <path>       Config file path (default: ./harness.config.json)
  --provider <name>     Override provider from config
  --workspace <path>    Override workspace from config
  --run-root <path>     Override run root from config
  --approval <policy>   allow_once | allow_always | reject_once | reject_always
  --max-negotiation-rounds <N>  Max contract negotiation rounds (default: 3)
`);
}

function buildOverrides(flags: Record<string, string>): Partial<HarnessConfig> {
  const overrides: Partial<HarnessConfig> = {};
  if (flags.provider) overrides.provider = flags.provider as HarnessConfig['provider'];
  if (flags.workspace) overrides.workspace = flags.workspace;
  if (flags['run-root']) overrides.runRoot = flags['run-root'];
  if (flags.approval) overrides.approvalPolicy = flags.approval as HarnessConfig['approvalPolicy'];
  if (flags['max-negotiation-rounds']) overrides.maxNegotiationRounds = Number(flags['max-negotiation-rounds']);
  return overrides;
}

function parseArgv(argv: string[]): {
  command: string | undefined;
  positionals: string[];
  flags: Record<string, string>;
} {
  let command: string | undefined;
  const positionals: string[] = [];
  const flags: Record<string, string> = {};

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!command && !token.startsWith('--')) {
      command = token;
      continue;
    }
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const value = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true';
      flags[key] = value;
      continue;
    }
    positionals.push(token);
  }

  return { command, positionals, flags };
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
