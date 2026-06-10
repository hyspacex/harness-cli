import path from 'node:path';
import { exec as execCallback, execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { truncate } from '../core/utils.js';
import type { EvalObjectiveCheck, HarnessEvalCase } from './cases.js';
import { redactSensitiveText } from './packet.js';

const execAsync = promisify(execCallback);
const execFileAsync = promisify(execFileCallback);

const DEFAULT_COMMAND_TIMEOUT_MS = 120000;
const DEFAULT_COMMAND_BUFFER = 5 * 1024 * 1024;

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

/**
 * Objective checks must run against the executed run's workspace, not the
 * pristine case fixture — the fixture is the starting template and would make
 * every post-run behavior check fail (or pass) spuriously. The fixture is only
 * a last resort when the run state has no workspace recorded.
 */
export function resolveObjectiveWorkspace(
  evalCase: HarnessEvalCase | null | undefined,
  workspace: string | null | undefined,
  runWorkspace: string,
): string {
  if (workspace) {
    return path.resolve(workspace);
  }
  if (runWorkspace) {
    return path.resolve(runWorkspace);
  }
  if (evalCase?.workspaceFixture) {
    return path.resolve(evalCase.workspaceFixture);
  }
  return path.resolve('.');
}

export async function runObjectiveChecks(
  checks: EvalObjectiveCheck[],
  workspace: string,
): Promise<EvalObjectiveCheckResult[]> {
  const results: EvalObjectiveCheckResult[] = [];
  for (const [index, check] of checks.entries()) {
    const startedAt = Date.now();
    const expectedExitCode = check.expectedExitCode ?? 0;
    const id = check.id || `check-${index + 1}`;
    const display = renderCheckCommand(check);
    let cwd: string;
    try {
      cwd = resolveCheckCwd(workspace, check.cwd);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      results.push({
        id,
        command: display,
        cwd: workspace,
        required: check.required !== false,
        expectedExitCode,
        ok: false,
        exitCode: -1,
        durationMs: Date.now() - startedAt,
        stdout: '',
        stderr: redactSensitiveText(message) || '',
        failures: [message],
      });
      continue;
    }
    const timeout = check.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    try {
      const { stdout, stderr } = check.argv && check.argv.length > 0
        ? await execFileAsync(check.argv[0], check.argv.slice(1), {
            cwd,
            timeout,
            maxBuffer: DEFAULT_COMMAND_BUFFER,
          })
        : await execAsync(check.command || '', {
            cwd,
            timeout,
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
        id,
        command: display,
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
        id,
        command: display,
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

function renderCheckCommand(check: EvalObjectiveCheck): string {
  if (check.argv && check.argv.length > 0) {
    return check.argv.join(' ');
  }
  return check.command || '';
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

function resolveCheckCwd(workspace: string, checkCwd: string | undefined): string {
  const workspaceAbs = path.resolve(workspace);
  if (!checkCwd) {
    return workspaceAbs;
  }
  if (path.isAbsolute(checkCwd)) {
    throw new Error(`Objective check cwd must be relative to the workspace: "${checkCwd}"`);
  }
  const resolved = path.resolve(workspaceAbs, checkCwd);
  const relative = path.relative(workspaceAbs, resolved);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Objective check cwd escapes workspace: "${checkCwd}"`);
  }
  return resolved;
}
