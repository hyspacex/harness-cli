#!/usr/bin/env node
import path from 'node:path';
import { loadConfig, writeDefaultConfig } from './config.js';
import {
  buildDryJudgeResult,
  buildEvalRunPacket,
  buildPairwiseJudgePrompt,
  findEvalCase,
  listEvalCases,
  normalizeJudgeResult,
  parseJudgeJson,
  writeEvalRunPacket,
  writeJudgeComparisonArtifacts,
} from './evals.js';
import { HarnessRunner } from './harness.js';
import { createProvider } from './providers/index.js';
import { listDirectories, readJson, slugify } from './utils.js';
import type { HarnessConfig, ProviderName, RunState } from './types.js';

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
    case 'eval': {
      await handleEvalCommand(flags, positionals);
      return;
    }
    case 'help':
    case undefined:
    default:
      printHelp();
  }
}

async function handleEvalCommand(flags: Record<string, string>, positionals: string[]): Promise<void> {
  const subcommand = positionals[0] || 'help';

  switch (subcommand) {
    case 'list': {
      const cases = await listEvalCases(flags.cases || 'evals/cases');
      if (cases.length === 0) {
        console.log(`No eval cases found under ${flags.cases || 'evals/cases'}`);
        return;
      }
      for (const evalCase of cases) {
        console.log(`${evalCase.id}\n  category: ${evalCase.category}\n  title: ${evalCase.title}\n  path: ${evalCase.path}\n`);
      }
      return;
    }
    case 'packet': {
      const runDir = positionals[1];
      if (!runDir) {
        throw new Error('Provide a run directory. Example: harness eval packet .harness/runs/<run-id> --case my-case');
      }

      const evalCase = flags.case ? await findEvalCase(flags.case, flags.cases || 'evals/cases') : null;
      const packet = await buildEvalRunPacket({
        runDir,
        evalCase,
        workspace: flags.workspace || null,
        runObjectiveChecks: flagEnabled(flags, 'objective-checks'),
      });
      const outPath = path.resolve(flags.out || path.join(runDir, 'eval-packet.json'));
      const markdownPath = flags.markdown && flags.markdown !== 'false'
        ? path.resolve(flags.markdown === 'true' ? `${outPath.replace(/\.json$/i, '')}.md` : flags.markdown)
        : null;
      await writeEvalRunPacket(packet, outPath, markdownPath);
      console.log(`Wrote ${outPath}`);
      if (markdownPath) {
        console.log(`Wrote ${markdownPath}`);
      }
      return;
    }
    case 'compare': {
      await compareEvalRuns(flags, positionals);
      return;
    }
    case 'help':
    default:
      printEvalHelp();
  }
}

async function compareEvalRuns(flags: Record<string, string>, positionals: string[]): Promise<void> {
  const caseRef = flags.case || positionals[1];
  const runA = flags.a || flags['run-a'] || flags['baseline-run'];
  const runB = flags.b || flags['run-b'] || flags['candidate-run'];

  if (!caseRef) {
    throw new Error('Provide an eval case with --case <id|path>.');
  }
  if (!runA || !runB) {
    throw new Error('Provide both runs: harness eval compare --case <id> --a <runDir> --b <runDir>');
  }

  const evalCase = await findEvalCase(caseRef, flags.cases || 'evals/cases');
  const packetA = await buildEvalRunPacket({
    runDir: runA,
    evalCase,
    workspace: flags.workspace || null,
    runObjectiveChecks: flagEnabled(flags, 'objective-checks'),
  });
  const packetB = await buildEvalRunPacket({
    runDir: runB,
    evalCase,
    workspace: flags.workspace || null,
    runObjectiveChecks: flagEnabled(flags, 'objective-checks'),
  });
  const prompt = buildPairwiseJudgePrompt(evalCase, packetA, packetB);

  const outDir = path.resolve(
    flags.out ||
      path.join(
        '.harness',
        'evals',
        `${new Date().toISOString().replace(/[:.]/g, '-')}-${slugify(evalCase.id)}`,
      ),
  );

  const judgeProvider = parseProviderName(flags['judge-provider']);
  let judged = { result: buildDryJudgeResult(evalCase, packetA, packetB), rawText: null as string | null };
  let judgeError: Error | null = null;
  if (judgeProvider) {
    try {
      judged = await runLlmJudge(flags, judgeProvider, prompt, evalCase.id, packetA, packetB);
      console.log(`Judge completed with ${judgeProvider}`);
    } catch (error) {
      judgeError = error instanceof Error ? error : new Error(String(error));
      judged.result = {
        ...judged.result,
        judge: {
          provider: judgeProvider,
          model: null,
        },
        rationale: `Judge failed before producing a result: ${judgeError.message}`,
      };
    }
  }
  const judgeResult = judged.result;

  await writeJudgeComparisonArtifacts({
    outDir,
    packetA,
    packetB,
    prompt,
    result: judgeResult,
    rawJudgeText: judged.rawText,
  });

  console.log(`Comparison artifacts: ${outDir}`);
  console.log(`Winner: ${judgeResult.winner}`);
  console.log(`Confidence: ${judgeResult.confidence}`);
  console.log(`Judge: ${judgeResult.judge.provider}`);
  if (!judgeProvider) {
    console.log('No judge provider supplied; review judge-prompt.md or rerun with --judge-provider claude-sdk|codex.');
  }
  if (judgeError) {
    throw judgeError;
  }
}

async function runLlmJudge(
  flags: Record<string, string>,
  judgeProvider: ProviderName,
  prompt: string,
  caseId: string,
  packetA: Awaited<ReturnType<typeof buildEvalRunPacket>>,
  packetB: Awaited<ReturnType<typeof buildEvalRunPacket>>,
) {
  const judgeFlags = { ...flags, provider: judgeProvider };
  const { config } = await loadConfig(flags.config, buildOverrides(judgeFlags));
  const providerRegistry = createProvider(config, {
    onStdErr: (chunk) => {
      const text = String(chunk || '').trim();
      if (text) {
        console.error(`[judge] ${text}`);
      }
    },
    onUpdate: (update) => {
      if (update?.sessionUpdate === 'tool_call' && update.title) {
        console.error(`[judge-tool] ${update.title}`);
      }
    },
  });
  const result = await providerRegistry.runTask({
    kind: 'evaluator',
    label: `meta-judge-${caseId}`,
    cwd: process.cwd(),
    prompt,
    artifacts: {},
  });
  const parsed = result.parsed || parseJudgeJson(result.rawText);
  return {
    result: normalizeJudgeResult(parsed, {
      caseId,
      provider: judgeProvider,
      model: judgeProvider === 'codex' ? config.codex.model : config.claudeSdk.model,
      packetA,
      packetB,
    }),
    rawText: result.rawText,
  };
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
  harness eval <list|packet|compare> [flags]

Flags:
  --config <path>       Config file path (default: ./harness.config.json)
  --provider <name>     Override provider from config
  --workspace <path>    Override workspace from config
  --run-root <path>     Override run root from config
  --approval <policy>   allow_once | allow_always | reject_once | reject_always
  --max-sprints <N>     Max features/sprints to run
  --max-repair-rounds <N>  Max repair rounds per sprint
  --max-negotiation-rounds <N>  Max contract negotiation rounds (default: 3)
`);
}

function printEvalHelp(): void {
  console.log(`harness eval

Commands:
  harness eval list [--cases evals/cases]
  harness eval packet <runDir> [--case id|path] [--out packet.json] [--markdown] [--objective-checks]
  harness eval compare --case id|path --a <runDir> --b <runDir> [--out dir] [--judge-provider claude-sdk|codex]

Notes:
  compare writes packet-a.json, packet-b.json, judge-prompt.md, and judge-result.json.
  If --judge-provider is omitted, compare runs in dry mode and only prepares the judge prompt.
  Add --objective-checks true to run case-defined commands while building packets.
`);
}

function buildOverrides(flags: Record<string, string>): Partial<HarnessConfig> {
  const overrides: Partial<HarnessConfig> = {};
  if (flags.provider) overrides.provider = flags.provider as HarnessConfig['provider'];
  if (flags.workspace) overrides.workspace = flags.workspace;
  if (flags['run-root']) overrides.runRoot = flags['run-root'];
  if (flags.approval) overrides.approvalPolicy = flags.approval as HarnessConfig['approvalPolicy'];
  if (flags['max-sprints']) overrides.maxSprints = Number(flags['max-sprints']);
  if (flags['max-repair-rounds']) overrides.maxRepairRounds = Number(flags['max-repair-rounds']);
  if (flags['max-negotiation-rounds']) overrides.maxNegotiationRounds = Number(flags['max-negotiation-rounds']);
  return overrides;
}

function flagEnabled(flags: Record<string, string>, name: string): boolean {
  const value = flags[name];
  if (value === undefined) return false;
  return value !== 'false' && value !== '0' && value !== 'no';
}

function parseProviderName(value: string | undefined): ProviderName | undefined {
  if (!value) return undefined;
  if (value === 'claude-sdk' || value === 'codex') return value;
  throw new Error(`Unsupported judge provider: ${value}`);
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
