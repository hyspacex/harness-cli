#!/usr/bin/env node
import path from 'node:path';
import { buildOverrides, flagEnabled, parseProviderName } from './cli-flags.js';
import { loadConfig, writeDefaultConfig } from './core/config.js';
import { findEvalCase, listEvalCases } from './lab/cases.js';
import {
  buildEvalRunPacket,
  redactSensitiveText,
  writeEvalRunPacket,
} from './lab/packet.js';
import {
  buildDryJudgeResult,
  buildPairwiseJudgePrompt,
  normalizeJudgeResult,
  parseJudgeJson,
  writeJudgeComparisonArtifacts,
} from './lab/judge.js';
import { buildCeremonyRoiReport, renderCeremonyRoiMarkdown } from './core/ceremony-roi.js';
import { runEvalMatrix } from './lab/eval-matrix.js';
import { HarnessRunner } from './core/harness.js';
import { loadRunHistory, recommendProfilesWithEvidence } from './core/history.js';
import { listExecutionProfiles } from './core/profiles.js';
import { createProvider } from './core/providers/index.js';
import { ensureDir, listDirectories, nowIso, readJson, slugify, writeJson, writeText } from './core/utils.js';
import type { HarnessConfig, ProviderName, RunState } from './core/types.js';

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
      const runner = await createRunner(flags, prompt);
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
    case 'profiles': {
      await printProfiles(flags);
      return;
    }
    case 'eval': {
      await handleEvalCommand(flags, positionals);
      return;
    }
    case 'lab': {
      await handleLabCommand(flags, positionals);
      return;
    }
    case 'help':
    case undefined:
      printHelp();
      return;
    default:
      throw new Error(`Unknown command: ${command}. Run "harness help" to see available commands.`);
  }
}

const LAB_SUBCOMMANDS = new Set(['list', 'packet', 'compare', 'matrix']);

async function handleLabCommand(flags: Record<string, string>, positionals: string[]): Promise<void> {
  const subcommand = positionals[0] || 'help';
  if (LAB_SUBCOMMANDS.has(subcommand)) {
    await dispatchLabSubcommand(subcommand, flags, positionals);
    return;
  }
  printLabHelp();
}

async function handleEvalCommand(flags: Record<string, string>, positionals: string[]): Promise<void> {
  const subcommand = positionals[0] || 'help';

  if (LAB_SUBCOMMANDS.has(subcommand)) {
    console.error(`harness eval ${subcommand} is deprecated; use harness lab ${subcommand}`);
    await dispatchLabSubcommand(subcommand, flags, positionals);
    return;
  }

  switch (subcommand) {
    case 'roi': {
      await writeCeremonyRoiReport(flags);
      return;
    }
    case 'help':
    default:
      printEvalHelp();
  }
}

async function dispatchLabSubcommand(
  subcommand: string,
  flags: Record<string, string>,
  positionals: string[],
): Promise<void> {
  switch (subcommand) {
    case 'list': {
      const cases = await listEvalCases(flags.cases || null);
      if (cases.length === 0) {
        console.log(`No eval cases found under ${flags.cases || 'lab/cases or evals/cases'}`);
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
        throw new Error('Provide a run directory. Example: harness lab packet .harness/runs/<run-id> --case my-case');
      }

      const evalCase = flags.case ? await findEvalCase(flags.case, flags.cases || null) : null;
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
    case 'matrix': {
      await runEvalMatrix(flags, positionals);
      return;
    }
    default:
      throw new Error(`Unknown lab subcommand: ${subcommand}`);
  }
}

async function writeCeremonyRoiReport(flags: Record<string, string>): Promise<void> {
  const { config } = await loadConfig(flags.config, buildOverrides(flags));
  const entries = await loadRunHistory(config.runRoot, config.profiles);
  const report = buildCeremonyRoiReport(entries, {
    runRoot: config.runRoot,
    builtAt: nowIso(),
  });

  const outDir = path.resolve(flags.out || path.join(config.runRoot, 'reports'));
  await ensureDir(outDir);
  const jsonPath = path.join(outDir, 'ceremony-roi.json');
  const markdownPath = path.join(outDir, 'ceremony-roi.md');
  await writeJson(jsonPath, report);
  await writeText(markdownPath, renderCeremonyRoiMarkdown(report));

  console.log(`Ceremony ROI report (${report.totalRuns} run(s) analyzed):`);
  for (const finding of report.findings) {
    console.log(`- ${finding}`);
  }
  console.log('');
  console.log(`Wrote ${jsonPath}`);
  console.log(`Wrote ${markdownPath}`);
}

async function printProfiles(flags: Record<string, string>): Promise<void> {
  const { config } = await loadConfig(flags.config, buildOverrides(flags));
  const profiles = listExecutionProfiles(config.profiles);

  if (flags.recommend) {
    const recommendation = await recommendProfilesWithEvidence({
      runRoot: config.runRoot,
      category: flags.category || null,
      prompt: flags.recommend === 'true' ? null : flags.recommend,
      customProfiles: config.profiles,
    });
    console.log(`Recommended profiles: ${recommendation.profiles.join(', ')}`);
    console.log(`Category: ${recommendation.category}`);
    if (recommendation.source === 'evidence') {
      console.log(`Source: run-history evidence (${recommendation.scope === 'category' ? 'matching category' : 'all runs'})`);
      for (const item of recommendation.evidence) {
        const firstRound = item.firstRoundPassRate === null
          ? 'n/a'
          : `${Math.round(item.firstRoundPassRate * 100)}%`;
        console.log(
          `  ${item.profile}: ${item.runs} run(s), ` +
            `${Math.round(item.completionRate * 100)}% completed, ` +
            `${item.avgTasksStarted.toFixed(1)} avg tasks/run, ` +
            `first-round pass ${firstRound}`,
        );
      }
    } else {
      console.log('Source: keyword heuristic (no comparable run history under this run root yet)');
    }
    console.log('');
    return;
  }

  for (const profile of profiles) {
    console.log(`${profile.name}`);
    console.log(`  tags: ${profile.tags.join(', ') || '(none)'}`);
    console.log(`  description: ${profile.description}`);
    if (profile.useWhen.length > 0) {
      console.log(`  use when: ${profile.useWhen.join(' ')}`);
    }
    console.log('');
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
    throw new Error('Provide both runs: harness lab compare --case <id> --a <runDir> --b <runDir>');
  }

  const evalCase = await findEvalCase(caseRef, flags.cases || null);
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
  const prompt = buildPairwiseJudgePrompt(evalCase, packetA, packetB, {
    blind: flagEnabled(flags, 'blind-judge'),
  });

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
  const { config } = await loadConfig(flags.config, buildOverrides(judgeFlags), {
    profile: flags['judge-profile'] || flags.profile || null,
  });
  if (flags['judge-model']) {
    if (judgeProvider === 'codex') {
      config.codex.model = flags['judge-model'];
    } else {
      config.claudeSdk.model = flags['judge-model'];
    }
  }
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
    prompt: redactSensitiveText(prompt) || '',
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

/**
 * `--profile adaptive` on `harness run` resolves to a concrete profile via
 * run-history evidence (cheapest within tolerance of the best), falling back
 * to the keyword heuristic until enough history exists.
 */
async function resolveRunProfile(
  flags: Record<string, string>,
  overrides: Partial<HarnessConfig>,
  prompt?: string,
): Promise<string | null> {
  if (flags.profile !== 'adaptive') {
    return flags.profile || null;
  }
  if (!prompt) {
    throw new Error('--profile adaptive needs a prompt; use a concrete profile name for resume/status.');
  }

  const { config } = await loadConfig(flags.config, overrides);
  const recommendation = await recommendProfilesWithEvidence({
    runRoot: config.runRoot,
    category: flags.category || null,
    prompt,
    customProfiles: config.profiles,
  });
  const chosen = recommendation.profiles[0];
  console.log(
    `Adaptive profile: ${chosen} (${recommendation.source === 'evidence'
      ? `run-history evidence, ${recommendation.scope === 'category' ? `${recommendation.category} runs` : 'all runs'}`
      : 'keyword heuristic — no comparable run history yet'})`,
  );
  return chosen;
}

async function createRunner(flags: Record<string, string>, prompt?: string): Promise<HarnessRunner> {
  const overrides = buildOverrides(flags);
  const profile = await resolveRunProfile(flags, overrides, prompt);
  const { config } = await loadConfig(flags.config, overrides, { profile });
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
  const { config } = await loadConfig(flags.config, overrides, { profile: flags.profile || null });

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
      `${run.id}\n  status: ${run.status}\n  providers: ${run.provider}\n  profile: ${run.executionProfile || '(none)'}\n  sprint: ${run.sprint}\n  summary: ${run.summary || '(none yet)'}\n`,
    );
  }
}

function printRunSummary(run: RunState): void {
  console.log('');
  console.log(`Run: ${run.id}`);
  console.log(`Status: ${run.status}`);
  console.log(`Providers: ${run.provider}`);
  if (run.executionProfile) {
    console.log(`Profile: ${run.executionProfile}`);
  }
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
  harness profiles [--config file] [--recommend "prompt" [--category name]]
  harness run "Build a ..." [--config file] [--profile name|adaptive] [--provider claude-sdk|codex] [--workspace path]
  harness resume <runId> [--config file] [--profile name]
  harness status [runId] [--config file] [--profile name]
  harness lab <list|packet|compare|matrix> [flags]   Model/provider characterization instrument
  harness eval <roi> [flags]                         Product self-measurement (old eval subcommands moved to lab)

Flags:
  --config <path>       Config file path (default: ./harness.config.json)
  --profile <name>      Execution profile to apply (run/status) or one matrix profile
  --provider <name>     Override provider from config
  --runtime-mode <mode> Ceremony ladder rung: full | flat | minimal
  --workspace <path>    Override workspace from config
  --run-root <path>     Override run root from config
  --approval <policy>   allow_once | allow_always | reject_once | reject_always
  --max-sprints <N>     Max features/sprints to run
  --max-repair-rounds <N>  Max repair rounds per sprint
  --max-negotiation-rounds <N>  Max contract negotiation rounds (default: 3)

Ceremony ladder:
  full     separate researcher + planner, negotiated contracts
  flat     bootstrapped plan artifacts, generator-drafted contract, one review
  minimal  bootstrapped plan artifacts, harness-authored contract, zero negotiation
  Verification gates (verdicts, frozen evidence, smoke, final regression) run at every rung.
  "harness profiles --recommend" picks the cheapest rung the run history supports.
`);
}

function printEvalHelp(): void {
  console.log(`harness eval

Product self-measurement of the harness itself.

Commands:
  harness eval roi [--run-root path] [--out dir]

Notes:
  roi aggregates run history into a ceremony ROI report: per provider, does role/negotiation ceremony pay for itself?
  The old eval subcommands (list, packet, compare, matrix) moved to "harness lab" and remain as deprecated aliases here.
`);
}

function printLabHelp(): void {
  console.log(`harness lab

The lab is the model/provider characterization instrument: fixed eval cases,
locked judge rubrics, and benchmark suites for measuring how much harness
ceremony each model actually needs.

Commands:
  harness lab list [--cases dir]
  harness lab packet <runDir> [--case id|path] [--out packet.json] [--markdown] [--objective-checks]
  harness lab compare --case id|path --a <runDir> --b <runDir> [--out dir] [--judge-provider claude-sdk|codex]
  harness lab matrix --case id|path|all [--profiles adaptive|name,name] [--out dir] [--execute true] [--judge-provider claude-sdk|codex]
  harness lab matrix --suite [lab/suites/ceremony-ladder-v1.json] [--out dir] [--execute true]
  harness lab matrix report --from <matrixOutDir> [--judge-provider claude-sdk|codex]

Notes:
  list scans lab/cases/ and evals/cases/ by default (lab/cases wins on id collision); --cases scans one dir only.
  compare writes packet-a.json, packet-b.json, judge-prompt.md, and judge-result.json.
  If --judge-provider is omitted, compare runs in dry mode and only prepares the judge prompt.
  matrix defaults to dry mode and writes matrix-plan.json plus matrix-plan.md.
  When executed, matrix writes per-profile packets, matrix-result.md, and pairwise comparison prompts/results.
  matrix report rebuilds packets, matrix-result.md, and comparisons from an existing matrix-plan.json.
  matrix --suite runs the fixed benchmark grid (cases x ceremony-ladder profiles) and freezes results under lab/results/frozen/.
  Add --objective-checks true to run case-defined commands while building packets.
  Add --blind-judge true to redact profile/provider/model identifiers from judge prompts.
  Add --judge-model <model> to override the judge's model (e.g. a non-participant model for fairness).
`);
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
