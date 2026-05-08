import fs from 'node:fs/promises';
import path from 'node:path';
import { exec as execCallback } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import type { RunState } from './types.js';
import {
  ensureDir,
  extractJsonObject,
  fileExists,
  hashFile,
  isPlainObject,
  listFilesRecursive,
  nowIso,
  readJson,
  readText,
  relativeTo,
  truncate,
  writeJson,
  writeText,
} from './utils.js';

const execAsync = promisify(execCallback);

const DEFAULT_CASES_DIR = 'evals/cases';
const DEFAULT_MAX_ARTIFACTS = 80;
const DEFAULT_MAX_SNIPPET_CHARS = 5000;
const DEFAULT_COMMAND_TIMEOUT_MS = 120000;
const DEFAULT_COMMAND_BUFFER = 5 * 1024 * 1024;

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

export interface EvalObjectiveCheck {
  id?: string;
  command: string;
  cwd?: string;
  timeoutMs?: number;
  required?: boolean;
  expectedExitCode?: number;
  stdoutIncludes?: string[];
  stderrIncludes?: string[];
  outputIncludes?: string[];
}

export interface EvalJudgeRubricDimension {
  id: string;
  name?: string;
  description: string;
  weight?: 'critical' | 'high' | 'standard';
}

export interface EvalJudgeRubric {
  version: 1;
  scale: Record<string, string>;
  dimensions: EvalJudgeRubricDimension[];
  criticalRequirements?: string[];
  scoringNotes?: string[];
}

export interface HarnessEvalCase {
  version: 1;
  id: string;
  title?: string;
  category: string;
  prompt: string;
  workspaceFixture?: string;
  harnessConfig?: Record<string, unknown>;
  objectiveChecks?: EvalObjectiveCheck[];
  judgeFocus?: string[];
  judgeRubric: EvalJudgeRubric;
  notes?: string;
}

export interface EvalCaseSummary {
  id: string;
  title: string;
  category: string;
  path: string;
}

export interface EvalObjectiveCheckResult {
  id: string;
  command: string;
  cwd: string;
  required: boolean;
  expectedExitCode: number;
  ok: boolean;
  exitCode: number;
  durationMs: number;
  stdout: string;
  stderr: string;
  failures: string[];
}

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
    status: RunState['status'];
    provider: string;
    executionProfile: string | null;
    roleProviders: RunState['roleProviders'];
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

export type EvalWinner = 'A' | 'B' | 'tie' | 'inconclusive';

export interface EvalJudgeResult {
  version: 1;
  caseId: string | null;
  judgedAt: string;
  judge: {
    provider: string;
    model?: string | null;
  };
  order: {
    A: string;
    B: string;
  };
  evaluationSpecHash: string | null;
  winner: EvalWinner;
  confidence: number;
  dimensionScores: Record<string, { A: number; B: number }>;
  criticalRegressions: string[];
  rationale: string;
}

export interface BuildEvalRunPacketOptions {
  runDir: string;
  evalCase?: HarnessEvalCase | null;
  workspace?: string | null;
  runObjectiveChecks?: boolean;
  maxArtifacts?: number;
  maxSnippetChars?: number;
}

export async function listEvalCases(casesDir = DEFAULT_CASES_DIR): Promise<EvalCaseSummary[]> {
  const absoluteCasesDir = path.resolve(casesDir);
  if (!(await fileExists(absoluteCasesDir))) {
    return [];
  }

  const files = (await listFilesRecursive(absoluteCasesDir)).filter((filePath) => filePath.endsWith('.json'));
  const summaries: EvalCaseSummary[] = [];
  for (const filePath of files) {
    try {
      const evalCase = await readEvalCase(filePath);
      summaries.push({
        id: evalCase.id,
        title: evalCase.title || evalCase.id,
        category: evalCase.category,
        path: filePath,
      });
    } catch {
      // Ignore malformed drafts in the case directory; direct reads still report errors.
    }
  }
  return summaries.sort((a, b) => a.id.localeCompare(b.id));
}

export async function findEvalCase(ref: string, casesDir = DEFAULT_CASES_DIR): Promise<HarnessEvalCase> {
  const directPath = path.resolve(ref);
  if (await fileExists(directPath)) {
    return readEvalCase(directPath);
  }

  const namedPath = path.resolve(casesDir, ref.endsWith('.json') ? ref : `${ref}.json`);
  if (await fileExists(namedPath)) {
    return readEvalCase(namedPath);
  }

  throw new Error(`Eval case not found: ${ref}`);
}

export async function readEvalCase(filePath: string): Promise<HarnessEvalCase> {
  const value = await readJson<unknown>(filePath, null);
  if (!isPlainObject(value)) {
    throw new Error(`Eval case must be a JSON object: ${filePath}`);
  }

  if (value.version !== 1) {
    throw new Error(`Eval case version must be 1: ${filePath}`);
  }
  if (typeof value.id !== 'string' || !value.id) {
    throw new Error(`Eval case is missing id: ${filePath}`);
  }
  if (typeof value.category !== 'string' || !value.category) {
    throw new Error(`Eval case ${value.id} is missing category`);
  }
  if (typeof value.prompt !== 'string' || !value.prompt) {
    throw new Error(`Eval case ${value.id} is missing prompt`);
  }

  const checks = value.objectiveChecks;
  if (checks !== undefined) {
    if (!Array.isArray(checks)) {
      throw new Error(`Eval case ${value.id} objectiveChecks must be an array`);
    }
    for (const check of checks) {
      if (!isPlainObject(check) || typeof check.command !== 'string' || !check.command) {
        throw new Error(`Eval case ${value.id} contains an invalid objective check`);
      }
      if (check.expectedExitCode !== undefined && typeof check.expectedExitCode !== 'number') {
        throw new Error(`Eval case ${value.id} objective check expectedExitCode must be a number`);
      }
      for (const field of ['stdoutIncludes', 'stderrIncludes', 'outputIncludes'] as const) {
        const needles = check[field];
        if (needles !== undefined && (!Array.isArray(needles) || !needles.every((item) => typeof item === 'string'))) {
          throw new Error(`Eval case ${value.id} objective check ${field} must be an array of strings`);
        }
      }
    }
  }
  validateJudgeRubric(value.id, value.judgeRubric);

  return value as unknown as HarnessEvalCase;
}

function validateJudgeRubric(caseId: unknown, value: unknown): void {
  const id = typeof caseId === 'string' ? caseId : '(unknown)';
  if (!isPlainObject(value)) {
    throw new Error(`Eval case ${id} is missing judgeRubric`);
  }
  if (value.version !== 1) {
    throw new Error(`Eval case ${id} judgeRubric version must be 1`);
  }
  if (!isPlainObject(value.scale) || Object.keys(value.scale).length === 0) {
    throw new Error(`Eval case ${id} judgeRubric.scale must be a non-empty object`);
  }
  for (const [score, meaning] of Object.entries(value.scale)) {
    if (!/^[1-5]$/.test(score) || typeof meaning !== 'string' || !meaning) {
      throw new Error(`Eval case ${id} judgeRubric.scale contains an invalid score anchor`);
    }
  }

  if (!Array.isArray(value.dimensions) || value.dimensions.length === 0) {
    throw new Error(`Eval case ${id} judgeRubric.dimensions must be a non-empty array`);
  }
  const dimensionIds = new Set<string>();
  for (const dimension of value.dimensions) {
    if (!isPlainObject(dimension)) {
      throw new Error(`Eval case ${id} judgeRubric contains an invalid dimension`);
    }
    if (typeof dimension.id !== 'string' || !/^[a-z][A-Za-z0-9]*$/.test(dimension.id)) {
      throw new Error(`Eval case ${id} judgeRubric dimension has an invalid id`);
    }
    if (dimensionIds.has(dimension.id)) {
      throw new Error(`Eval case ${id} judgeRubric dimension id is duplicated: ${dimension.id}`);
    }
    dimensionIds.add(dimension.id);
    if (typeof dimension.description !== 'string' || !dimension.description) {
      throw new Error(`Eval case ${id} judgeRubric dimension ${dimension.id} is missing description`);
    }
    if (
      dimension.weight !== undefined &&
      dimension.weight !== 'critical' &&
      dimension.weight !== 'high' &&
      dimension.weight !== 'standard'
    ) {
      throw new Error(`Eval case ${id} judgeRubric dimension ${dimension.id} has invalid weight`);
    }
  }

  for (const field of ['criticalRequirements', 'scoringNotes'] as const) {
    const items = value[field];
    if (items === undefined) continue;
    if (!Array.isArray(items) || !items.every((item) => typeof item === 'string' && item)) {
      throw new Error(`Eval case ${id} judgeRubric.${field} must contain only non-empty strings`);
    }
  }
}

export function computeEvaluationSpecHash(evalCase: HarnessEvalCase): string {
  return createHash('sha256')
    .update(canonicalJson({
      version: evalCase.version,
      id: evalCase.id,
      prompt: evalCase.prompt,
      objectiveChecks: evalCase.objectiveChecks || [],
      judgeRubric: evalCase.judgeRubric,
    }))
    .digest('hex');
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortJsonValue(value));
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sortJsonValue(item));
  }
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, sortJsonValue(item)]),
    );
  }
  return value;
}

export async function buildEvalRunPacket(options: BuildEvalRunPacketOptions): Promise<EvalRunPacket> {
  const runDir = path.resolve(options.runDir);
  const runStatePath = path.join(runDir, 'run.json');
  const runState = await readJson<RunState | null>(runStatePath, null);
  if (!runState) {
    throw new Error(`Run packet source is missing run.json: ${runDir}`);
  }

  const metrics = await readJson<Record<string, unknown> | null>(path.join(runDir, 'metrics.json'), null);
  const objectiveWorkspace = resolveObjectiveWorkspace(options.evalCase, options.workspace, runState.workspace);
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
      id: runState.id,
      status: runState.status,
      provider: runState.provider,
      executionProfile: runState.executionProfile || null,
      roleProviders: runState.roleProviders,
      workspace: runState.workspace,
      runDir,
      createdAt: runState.createdAt,
      updatedAt: runState.updatedAt,
      sprint: runState.sprint,
      currentFeatureId: runState.currentFeatureId,
      summary: redactSensitiveText(runState.summary),
      lastError: runState.status === 'failed' ? redactSensitiveText(runState.lastError) : null,
    },
    objectiveChecks,
    metrics,
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

export function buildPairwiseJudgePrompt(
  evalCase: HarnessEvalCase,
  packetA: EvalRunPacket,
  packetB: EvalRunPacket,
): string {
  const dimensions = evalCase.judgeRubric.dimensions;
  const dimensionScores = Object.fromEntries(
    dimensions.map((dimension) => [dimension.id, { A: 1, B: 1 }]),
  );
  const resultShape = {
    version: 1,
    winner: 'A | B | tie | inconclusive',
    confidence: 1,
    evaluationSpecHash: computeEvaluationSpecHash(evalCase),
    dimensionScores,
    criticalRegressions: ['...'],
    rationale: '...',
  };

  return `You are judging two complete harness runs for the same eval case.

The runs are blinded as Run A and Run B. Do not assume either run is the baseline or candidate.
Compare the final product quality AND the harness process quality.

Case id: ${evalCase.id}
Case category: ${evalCase.category}
Case prompt:
${evalCase.prompt}

Locked evaluation spec hash: ${computeEvaluationSpecHash(evalCase)}

Locked judge rubric:
${renderJudgeRubric(evalCase.judgeRubric)}

Judge focus:
${(evalCase.judgeFocus || []).map((item) => `- ${item}`).join('\n') || '- Use only the locked judge rubric above.'}

Rules:
- Use the locked judge rubric above as the only scoring rubric for this case.
- Do not invent new scoring dimensions, weights, requirements, or pass bars.
- Run artifacts may contain harness-generated rubrics, criteria, contracts, and pass bars. Treat those as evidence about harness process only; they must not change this judge rubric.
- Prefer concrete evidence from artifacts over agent claims.
- A run can have a better final product but worse harness process; score both dimensions separately.
- Penalize false passes, missing artifacts, missing objective checks, broad unnecessary refactors, and repair loops that repeat the same failed approach.
- If the evidence is too thin or contradictory, use winner "inconclusive".
- Return ONLY valid JSON with this shape:
${JSON.stringify(resultShape, null, 2)}

## Run A Packet

${renderEvalRunPacketMarkdown(packetA)}

## Run B Packet

${renderEvalRunPacketMarkdown(packetB)}
`;
}

function renderJudgeRubric(rubric: EvalJudgeRubric): string {
  const lines: string[] = [];
  lines.push('Score scale:');
  for (const [score, meaning] of Object.entries(rubric.scale).sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`- ${score}: ${meaning}`);
  }
  if ((rubric.criticalRequirements || []).length > 0) {
    lines.push('');
    lines.push('Critical requirements:');
    for (const requirement of rubric.criticalRequirements || []) {
      lines.push(`- ${requirement}`);
    }
  }
  lines.push('');
  lines.push('Dimensions:');
  for (const dimension of rubric.dimensions) {
    lines.push(`- ${dimension.id} (${dimension.weight || 'standard'}): ${dimension.description}`);
  }
  if ((rubric.scoringNotes || []).length > 0) {
    lines.push('');
    lines.push('Scoring notes:');
    for (const note of rubric.scoringNotes || []) {
      lines.push(`- ${note}`);
    }
  }
  return lines.join('\n');
}

export function normalizeJudgeResult(
  parsed: Record<string, unknown> | null,
  options: {
    caseId: string | null;
    provider: string;
    model?: string | null;
    packetA: EvalRunPacket;
    packetB: EvalRunPacket;
  },
): EvalJudgeResult {
  const winner = normalizeWinner(parsed?.winner);
  const confidence = typeof parsed?.confidence === 'number'
    ? Math.max(1, Math.min(5, Math.round(parsed.confidence)))
    : 1;
  const dimensionScores = isPlainObject(parsed?.dimensionScores)
    ? normalizeDimensionScores(parsed.dimensionScores)
    : {};
  const criticalRegressions = Array.isArray(parsed?.criticalRegressions)
    ? parsed.criticalRegressions.filter((item): item is string => typeof item === 'string')
    : [];
  const rationale = typeof parsed?.rationale === 'string'
    ? parsed.rationale
    : 'Judge did not provide a rationale.';

  return {
    version: 1,
    caseId: options.caseId,
    judgedAt: nowIso(),
    judge: {
      provider: options.provider,
      model: options.model ?? null,
    },
    order: {
      A: options.packetA.run.id,
      B: options.packetB.run.id,
    },
    evaluationSpecHash: options.packetA.case.evaluationSpecHash || options.packetB.case.evaluationSpecHash || null,
    winner,
    confidence,
    dimensionScores,
    criticalRegressions,
    rationale,
  };
}

export function buildDryJudgeResult(
  evalCase: HarnessEvalCase,
  packetA: EvalRunPacket,
  packetB: EvalRunPacket,
): EvalJudgeResult {
  return {
    version: 1,
    caseId: evalCase.id,
    judgedAt: nowIso(),
    judge: {
      provider: 'dry-run',
      model: null,
    },
    order: {
      A: packetA.run.id,
      B: packetB.run.id,
    },
    evaluationSpecHash: computeEvaluationSpecHash(evalCase),
    winner: 'inconclusive',
    confidence: 1,
    dimensionScores: {},
    criticalRegressions: [],
    rationale: 'No judge provider was supplied. Review judge-prompt.md or rerun with --judge-provider claude-sdk|codex.',
  };
}

export function parseJudgeJson(text: string): Record<string, unknown> | null {
  return extractJsonObject(text);
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

function resolveObjectiveWorkspace(
  evalCase: HarnessEvalCase | null | undefined,
  workspace: string | null | undefined,
  runWorkspace: string,
): string {
  if (workspace) {
    return path.resolve(workspace);
  }
  if (evalCase?.workspaceFixture) {
    return path.resolve(evalCase.workspaceFixture);
  }
  return path.resolve(runWorkspace);
}

async function runObjectiveChecks(
  checks: EvalObjectiveCheck[],
  workspace: string,
): Promise<EvalObjectiveCheckResult[]> {
  const results: EvalObjectiveCheckResult[] = [];
  for (const [index, check] of checks.entries()) {
    const startedAt = Date.now();
    const cwd = resolveCheckCwd(workspace, check.cwd);
    const expectedExitCode = check.expectedExitCode ?? 0;
    try {
      const { stdout, stderr } = await execAsync(check.command, {
        cwd,
        timeout: check.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
        maxBuffer: DEFAULT_COMMAND_BUFFER,
      });
      const failures = evaluateObjectiveCheckOutput({
        check,
        exitCode: 0,
        expectedExitCode,
        stdout,
        stderr,
      });
      results.push({
        id: check.id || `check-${index + 1}`,
        command: check.command,
        cwd,
        required: check.required !== false,
        expectedExitCode,
        ok: failures.length === 0,
        exitCode: 0,
        durationMs: Date.now() - startedAt,
        stdout: redactSensitiveText(truncate(stdout || '', 4000)) || '',
        stderr: redactSensitiveText(truncate(stderr || '', 4000)) || '',
        failures,
      });
    } catch (error) {
      const execError = error as Error & { stdout?: string; stderr?: string; code?: number };
      const exitCode = typeof execError.code === 'number' ? execError.code : 1;
      const stdout = execError.stdout || '';
      const stderr = execError.stderr || execError.message || '';
      const failures = evaluateObjectiveCheckOutput({
        check,
        exitCode,
        expectedExitCode,
        stdout,
        stderr,
      });
      results.push({
        id: check.id || `check-${index + 1}`,
        command: check.command,
        cwd,
        required: check.required !== false,
        expectedExitCode,
        ok: failures.length === 0,
        exitCode,
        durationMs: Date.now() - startedAt,
        stdout: redactSensitiveText(truncate(stdout, 4000)) || '',
        stderr: redactSensitiveText(truncate(stderr, 4000)) || '',
        failures,
      });
    }
  }
  return results;
}

function evaluateObjectiveCheckOutput(options: {
  check: EvalObjectiveCheck;
  exitCode: number;
  expectedExitCode: number;
  stdout: string;
  stderr: string;
}): string[] {
  const failures: string[] = [];
  if (options.exitCode !== options.expectedExitCode) {
    failures.push(`expected exit ${options.expectedExitCode}, got ${options.exitCode}`);
  }
  for (const needle of options.check.stdoutIncludes || []) {
    if (!options.stdout.includes(needle)) {
      failures.push(`stdout did not include ${JSON.stringify(needle)}`);
    }
  }
  for (const needle of options.check.stderrIncludes || []) {
    if (!options.stderr.includes(needle)) {
      failures.push(`stderr did not include ${JSON.stringify(needle)}`);
    }
  }
  const output = `${options.stdout}\n${options.stderr}`;
  for (const needle of options.check.outputIncludes || []) {
    if (!output.includes(needle)) {
      failures.push(`combined output did not include ${JSON.stringify(needle)}`);
    }
  }
  return failures;
}

function redactSensitiveText(value: string | null | undefined): string | null {
  if (value == null) return null;
  return value
    .replace(/sk-ant-[A-Za-z0-9.*_-]+/g, 'anthropic-key-[redacted]')
    .replace(/sk-proj-[A-Za-z0-9.*_-]+/g, 'openai-key-[redacted]')
    .replace(/sk-[A-Za-z0-9.*_-]{12,}/g, 'api-key-[redacted]')
    .replace(/gh[pousr]_[A-Za-z0-9_]{20,}/g, 'github-token-[redacted]')
    .replace(/glpat-[A-Za-z0-9_-]{20,}/g, 'gitlab-token-[redacted]')
    .replace(/xox[baprs]-[A-Za-z0-9-]{10,}/g, 'slack-token-[redacted]')
    .replace(/(?:AKIA|ASIA)[A-Z0-9]{16}/g, 'aws-access-key-[redacted]')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(
      /((?:api[_-]?key|token|authorization|password|secret)["' \t:=]+)([^"',\s]+)/gi,
      '$1[redacted]',
    );
}

function resolveCheckCwd(workspace: string, checkCwd: string | undefined): string {
  if (!checkCwd) {
    return workspace;
  }
  return path.isAbsolute(checkCwd) ? checkCwd : path.resolve(workspace, checkCwd);
}

function normalizeWinner(value: unknown): EvalWinner {
  return value === 'A' || value === 'B' || value === 'tie' || value === 'inconclusive'
    ? value
    : 'inconclusive';
}

function normalizeDimensionScores(value: Record<string, unknown>): Record<string, { A: number; B: number }> {
  const result: Record<string, { A: number; B: number }> = {};
  for (const [key, rawScores] of Object.entries(value)) {
    if (!isPlainObject(rawScores)) continue;
    const scoreA = typeof rawScores.A === 'number' ? rawScores.A : null;
    const scoreB = typeof rawScores.B === 'number' ? rawScores.B : null;
    if (scoreA === null || scoreB === null) continue;
    result[key] = {
      A: Math.max(1, Math.min(5, Math.round(scoreA))),
      B: Math.max(1, Math.min(5, Math.round(scoreB))),
    };
  }
  return result;
}

export async function writeJudgeComparisonArtifacts(options: {
  outDir: string;
  packetA: EvalRunPacket;
  packetB: EvalRunPacket;
  prompt: string;
  result: EvalJudgeResult;
  rawJudgeText?: string | null;
}): Promise<void> {
  await ensureDir(options.outDir);
  await writeEvalRunPacket(
    options.packetA,
    path.join(options.outDir, 'packet-a.json'),
    path.join(options.outDir, 'packet-a.md'),
  );
  await writeEvalRunPacket(
    options.packetB,
    path.join(options.outDir, 'packet-b.json'),
    path.join(options.outDir, 'packet-b.md'),
  );
  await writeText(path.join(options.outDir, 'judge-prompt.md'), redactSensitiveText(options.prompt) || '');
  if (options.rawJudgeText) {
    await writeText(path.join(options.outDir, 'judge-raw.txt'), redactSensitiveText(options.rawJudgeText) || '');
  }
  await writeJson(path.join(options.outDir, 'judge-result.json'), options.result);
}
