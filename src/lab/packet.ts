import fs from 'node:fs/promises';
import path from 'node:path';
import type { ArtifactRoleProviderMap, ArtifactRunStatus } from '../core/artifacts/schema.js';
import { readRunArtifactBundle } from '../core/artifacts/run-reader.js';
import {
  hashFile,
  listFilesRecursive,
  nowIso,
  readText,
  relativeTo,
  truncate,
  writeJson,
  writeText,
} from '../core/utils.js';
import { computeEvaluationSpecHash, type EvalJudgeRubric, type HarnessEvalCase } from './cases.js';
import {
  resolveObjectiveWorkspace,
  runObjectiveChecks,
  type EvalObjectiveCheckResult,
} from './objective-checks.js';
import { redactSensitiveText } from './redact.js';

export { redactSensitiveText };

const DEFAULT_MAX_ARTIFACTS = 80;
const DEFAULT_MAX_SNIPPET_CHARS = 5000;

const TEXT_EXTENSIONS = new Set([
  '.json',
  '.jsonl',
  '.md',
  '.ndjson',
  '.txt',
  '.log',
  '.yml',
  '.yaml',
]);

export interface EvalArtifactSummary {
  path: string;
  bytes: number;
  sha256: string;
  snippet: string | null;
  omittedReason: string | null;
}

export interface EvalRunPacket {
  version: 1;
  builtAt: string;
  case: {
    id: string | null;
    title: string | null;
    category: string | null;
    prompt: string | null;
    judgeFocus: string[];
    judgeRubric: EvalJudgeRubric | null;
    evaluationSpecHash: string | null;
  };
  run: {
    id: string;
    status: ArtifactRunStatus;
    provider: string;
    executionProfile: string | null;
    roleProviders: ArtifactRoleProviderMap;
    workspace: string;
    runDir: string;
    createdAt: string;
    updatedAt: string;
    sprint: number;
    currentFeatureId: string | null;
    summary: string | null;
    lastError: string | null;
  };
  objectiveChecks: EvalObjectiveCheckResult[];
  metrics: Record<string, unknown> | null;
  artifacts: EvalArtifactSummary[];
}

export interface BuildEvalRunPacketOptions {
  runDir: string;
  evalCase?: HarnessEvalCase | null;
  workspace?: string | null;
  runObjectiveChecks?: boolean;
  maxArtifacts?: number;
  maxSnippetChars?: number;
}

export async function buildEvalRunPacket(options: BuildEvalRunPacketOptions): Promise<EvalRunPacket> {
  const runDir = path.resolve(options.runDir);
  const runBundle = await readRunArtifactBundle(runDir);
  const run = runBundle.run;

  const objectiveWorkspace = resolveObjectiveWorkspace(options.evalCase, options.workspace, run.workspace);
  const objectiveChecks = options.runObjectiveChecks
    ? await runObjectiveChecks(options.evalCase?.objectiveChecks || [], objectiveWorkspace)
    : [];

  const artifacts = await collectRunArtifacts(
    runDir,
    options.maxArtifacts ?? DEFAULT_MAX_ARTIFACTS,
    options.maxSnippetChars ?? DEFAULT_MAX_SNIPPET_CHARS,
  );

  return {
    version: 1,
    builtAt: nowIso(),
    case: {
      id: options.evalCase?.id || null,
      title: options.evalCase?.title || null,
      category: options.evalCase?.category || null,
      prompt: options.evalCase?.prompt || null,
      judgeFocus: options.evalCase?.judgeFocus || [],
      judgeRubric: options.evalCase?.judgeRubric || null,
      evaluationSpecHash: options.evalCase ? computeEvaluationSpecHash(options.evalCase) : null,
    },
    run: {
      id: run.id,
      status: run.status,
      provider: run.provider,
      executionProfile: run.executionProfile || null,
      roleProviders: run.roleProviders,
      workspace: run.workspace,
      runDir,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
      sprint: run.sprint,
      currentFeatureId: run.currentFeatureId,
      summary: redactSensitiveText(run.summary),
      lastError: run.status === 'failed' ? redactSensitiveText(run.lastError) : null,
    },
    objectiveChecks,
    metrics: runBundle.metrics,
    artifacts,
  };
}

export async function writeEvalRunPacket(
  packet: EvalRunPacket,
  packetPath: string,
  markdownPath?: string | null,
): Promise<void> {
  await writeJson(packetPath, packet);
  if (markdownPath) {
    await writeText(markdownPath, renderEvalRunPacketMarkdown(packet));
  }
}

export function renderEvalRunPacketMarkdown(packet: EvalRunPacket): string {
  const lines: string[] = [];
  lines.push(`# Eval Run Packet: ${packet.run.id}`);
  lines.push('');
  lines.push(`Built at: ${packet.builtAt}`);
  lines.push(`Case: ${packet.case.id || '(none)'}`);
  lines.push(`Category: ${packet.case.category || '(unknown)'}`);
  lines.push(`Status: ${packet.run.status}`);
  lines.push(`Provider: ${packet.run.provider}`);
  if (packet.run.executionProfile) {
    lines.push(`Profile: ${packet.run.executionProfile}`);
  }
  lines.push(`Sprint: ${packet.run.sprint}`);
  lines.push(`Summary: ${packet.run.summary || '(none)'}`);
  if (packet.run.lastError) {
    lines.push(`Last error: ${packet.run.lastError}`);
  }
  lines.push('');

  if (packet.case.prompt) {
    lines.push('## Case Prompt');
    lines.push(packet.case.prompt);
    lines.push('');
  }

  if (packet.case.judgeFocus.length > 0) {
    lines.push('## Judge Focus');
    for (const item of packet.case.judgeFocus) {
      lines.push(`- ${item}`);
    }
    lines.push('');
  }

  if (packet.case.judgeRubric) {
    lines.push('## Locked Judge Rubric');
    lines.push(`Evaluation spec hash: ${packet.case.evaluationSpecHash}`);
    lines.push('');
    lines.push('### Score Scale');
    for (const [score, meaning] of Object.entries(packet.case.judgeRubric.scale)) {
      lines.push(`- ${score}: ${meaning}`);
    }
    lines.push('');
    if ((packet.case.judgeRubric.criticalRequirements || []).length > 0) {
      lines.push('### Critical Requirements');
      for (const requirement of packet.case.judgeRubric.criticalRequirements || []) {
        lines.push(`- ${requirement}`);
      }
      lines.push('');
    }
    lines.push('### Dimensions');
    for (const dimension of packet.case.judgeRubric.dimensions) {
      lines.push(`- ${dimension.id} (${dimension.weight || 'standard'}): ${dimension.description}`);
    }
    lines.push('');
    if ((packet.case.judgeRubric.scoringNotes || []).length > 0) {
      lines.push('### Scoring Notes');
      for (const note of packet.case.judgeRubric.scoringNotes || []) {
        lines.push(`- ${note}`);
      }
      lines.push('');
    }
  }

  lines.push('## Objective Checks');
  if (packet.objectiveChecks.length === 0) {
    lines.push('No objective checks were run for this packet.');
  } else {
    for (const check of packet.objectiveChecks) {
      lines.push(`- ${check.id}: ${check.ok ? 'pass' : 'fail'} (${check.durationMs}ms)`);
      if (!check.ok) {
        lines.push(`  command: ${check.command}`);
        lines.push(`  expected exit: ${check.expectedExitCode}; actual exit: ${check.exitCode}`);
        for (const failure of check.failures) {
          lines.push(`  failure: ${failure}`);
        }
        lines.push(`  stderr: ${truncate(check.stderr || '(empty)', 500)}`);
      }
    }
  }
  lines.push('');

  lines.push('## Metrics');
  lines.push('```json');
  lines.push(JSON.stringify(packet.metrics || {}, null, 2));
  lines.push('```');
  lines.push('');

  lines.push('## Artifact Snippets');
  for (const artifact of packet.artifacts) {
    lines.push(`### ${artifact.path}`);
    lines.push(`bytes: ${artifact.bytes}`);
    lines.push(`sha256: ${artifact.sha256}`);
    if (artifact.snippet !== null) {
      lines.push('```');
      lines.push(artifact.snippet);
      lines.push('```');
    } else {
      lines.push(`omitted: ${artifact.omittedReason || 'not text'}`);
    }
    lines.push('');
  }

  return `${lines.join('\n')}\n`;
}

async function collectRunArtifacts(
  runDir: string,
  maxArtifacts: number,
  maxSnippetChars: number,
): Promise<EvalArtifactSummary[]> {
  const files = (await listFilesRecursive(runDir))
    .map((filePath) => ({ filePath, relPath: relativeTo(runDir, filePath) }))
    .filter(({ relPath }) => shouldIncludeArtifact(relPath))
    .sort((a, b) => artifactSortKey(a.relPath).localeCompare(artifactSortKey(b.relPath)))
    .slice(0, maxArtifacts);

  const artifacts: EvalArtifactSummary[] = [];
  for (const { filePath, relPath } of files) {
    const stats = await fs.stat(filePath);
    const textLike = isTextArtifact(filePath);
    artifacts.push({
      path: relPath,
      bytes: stats.size,
      sha256: await hashFile(filePath),
      snippet: textLike ? await readSnippet(filePath, maxSnippetChars) : null,
      omittedReason: textLike ? null : 'non-text artifact',
    });
  }
  return artifacts;
}

function shouldIncludeArtifact(relPath: string): boolean {
  if (relPath.includes('/evidence/') || relPath.includes('/evidence-frozen/')) {
    return relPath.endsWith('manifest.json') || isTextArtifact(relPath);
  }
  if (relPath.endsWith('.raw.txt')) return false;
  if (relPath.startsWith('logs/') && !relPath.endsWith('.parsed.json') && !relPath.endsWith('.log')) {
    return false;
  }

  return (
    relPath === 'run.json' ||
    relPath === 'metrics.json' ||
    relPath === 'events.ndjson' ||
    relPath === 'prompt.md' ||
    relPath === 'progress.md' ||
    relPath.startsWith('plan/') ||
    relPath.startsWith('contracts/') ||
    relPath.startsWith('evals/') ||
    relPath.startsWith('verdicts/') ||
    relPath.startsWith('repair-directives/') ||
    relPath.startsWith('handoff/') ||
    relPath.startsWith('logs/')
  );
}

function artifactSortKey(relPath: string): string {
  const priority = relPath === 'run.json'
    ? '00'
    : relPath === 'metrics.json'
      ? '01'
      : relPath.startsWith('plan/')
        ? '10'
        : relPath.startsWith('contracts/')
          ? '20'
          : relPath.startsWith('evals/')
            ? '30'
            : relPath.startsWith('verdicts/')
              ? '40'
              : relPath.startsWith('repair-directives/')
                ? '50'
                : relPath.startsWith('logs/')
                  ? '60'
                  : '99';
  return `${priority}:${relPath}`;
}

function isTextArtifact(filePath: string): boolean {
  return TEXT_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

async function readSnippet(filePath: string, maxSnippetChars: number): Promise<string> {
  const text = redactSensitiveText(await readText(filePath, '')) || '';
  if (text.length <= maxSnippetChars) {
    return text;
  }
  return `${text.slice(0, maxSnippetChars)}\n... [truncated ${text.length - maxSnippetChars} chars]`;
}
