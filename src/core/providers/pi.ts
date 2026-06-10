import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { extractJsonObject, isPlainObject } from '../utils.js';
import type {
  AgentRole,
  PiConfig,
  PiOutputMode,
  PiRoleConfig,
  ProviderHooks,
  ProviderRuntime,
  TaskDefinition,
  TaskResult,
} from '../types.js';

const execFileAsync = promisify(execFileCallback);
const DEFAULT_MAX_BUFFER = 10 * 1024 * 1024;

export interface PiTransportRequest {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
}

export interface PiTransportResult {
  stdout: string;
  stderr: string;
  meta?: Record<string, unknown>;
}

export interface PiTransport {
  run(request: PiTransportRequest): Promise<PiTransportResult>;
}

class CliPiTransport implements PiTransport {
  async run(request: PiTransportRequest): Promise<PiTransportResult> {
    try {
      const { stdout, stderr } = await execFileAsync(request.command, request.args, {
        cwd: request.cwd,
        env: { ...process.env, ...request.env },
        timeout: request.timeoutMs,
        maxBuffer: DEFAULT_MAX_BUFFER,
      });
      return { stdout, stderr };
    } catch (error) {
      const execError = error as Error & { stdout?: string; stderr?: string; code?: number; signal?: string; killed?: boolean };
      const stdout = execError.stdout || '';
      const stderr = execError.stderr || '';
      const details = [
        `command: ${formatCommandForLog(request.command, redactPromptArgs(request.args))}`,
        `stdoutBytes: ${Buffer.byteLength(stdout, 'utf8')}`,
        `stderrBytes: ${Buffer.byteLength(stderr, 'utf8')}`,
        ...(execError.signal ? [`signal: ${execError.signal}`] : []),
        ...(execError.killed ? ['killed: true'] : []),
      ];
      throw new Error(
        `Pi provider exited with ${typeof execError.code === 'number' ? `code ${execError.code}` : 'an error'}:` +
          `\n${details.join('\n')}`,
      );
    }
  }
}

export class PiProvider implements ProviderRuntime {
  private command: string;
  private args: string[];
  private env: Record<string, string>;
  private provider: string | null;
  private model: string | null;
  private outputMode: PiOutputMode;
  private noSession: boolean;
  private sessionDir: string | null;
  private timeoutMs: number;
  private roleOverrides: Partial<Record<AgentRole, PiRoleConfig>>;
  private transport: PiTransport;
  private onStdErr: NonNullable<ProviderHooks['onStdErr']>;

  constructor(options: PiConfig, hooks: ProviderHooks = {}, transport: PiTransport = new CliPiTransport()) {
    this.command = options.command || 'pi';
    this.args = Array.isArray(options.args) ? options.args : [];
    this.env = options.env || {};
    this.provider = options.provider ?? null;
    this.model = options.model ?? null;
    this.outputMode = options.outputMode || 'json';
    this.noSession = options.noSession ?? false;
    this.sessionDir = options.sessionDir ?? null;
    this.timeoutMs = options.timeoutMs || 600000;
    this.roleOverrides = options.roleOverrides || {};
    this.transport = transport;
    this.onStdErr = hooks.onStdErr || (() => {});
  }

  async runTask(task: TaskDefinition): Promise<TaskResult> {
    if (task.kind !== 'generator') {
      throw new Error(`Pi provider spike currently supports generator tasks only, got ${task.kind}.`);
    }

    const roleConfig = this.resolveRoleConfig(task.kind);
    const args = this.buildArgs(task.prompt, roleConfig);
    const result = await this.transport.run({
      command: this.command,
      args,
      cwd: task.cwd,
      env: this.env,
      timeoutMs: this.timeoutMs,
    });

    if (result.stderr.trim()) {
      this.onStdErr(result.stderr, task);
    }

    const parsedOutput = parsePiOutput(result.stdout);
    const redactedArgs = redactPromptArgs(args);
    return {
      rawText: parsedOutput.text,
      parsed: extractJsonObject(parsedOutput.text),
      meta: {
        provider: 'pi',
        command: this.command,
        outputMode: roleConfig.outputMode,
        ...parsedOutput.meta,
        ...(result.meta || {}),
        args: redactedArgs,
      },
    };
  }

  private buildArgs(prompt: string, roleConfig: Required<PiRoleConfig>): string[] {
    const args = [...this.args];
    if (roleConfig.outputMode) {
      args.push('--mode', roleConfig.outputMode);
    }
    if (this.noSession) {
      args.push('--no-session');
    }
    if (this.sessionDir) {
      args.push('--session-dir', this.sessionDir);
    }
    if (roleConfig.provider) {
      args.push('--provider', roleConfig.provider);
    }
    if (roleConfig.model) {
      args.push('--model', roleConfig.model);
    }
    args.push('-p', prompt);
    return args;
  }

  private resolveRoleConfig(role: AgentRole): Required<PiRoleConfig> {
    const overrides = this.roleOverrides[role] || {};
    return {
      provider: overrides.provider !== undefined ? overrides.provider : this.provider,
      model: overrides.model !== undefined ? overrides.model : this.model,
      outputMode: overrides.outputMode !== undefined && overrides.outputMode !== null
        ? overrides.outputMode
        : this.outputMode,
    };
  }
}

function redactPromptArgs(args: string[]): string[] {
  const redacted: string[] = [];
  let redactNext = false;

  for (const arg of args) {
    if (redactNext) {
      redacted.push('[redacted prompt]');
      redactNext = false;
      continue;
    }

    if (arg === '-p' || arg === '--prompt') {
      redacted.push(arg);
      redactNext = true;
      continue;
    }

    if (arg.startsWith('--prompt=')) {
      redacted.push('--prompt=[redacted prompt]');
      continue;
    }

    redacted.push(arg);
  }

  return redacted;
}

function formatCommandForLog(command: string, args: string[]): string {
  return [command, ...args].map(formatArgForLog).join(' ');
}

function formatArgForLog(value: string): string {
  if (/^[A-Za-z0-9_./:=@-]+$/.test(value)) {
    return value;
  }
  return JSON.stringify(value);
}

function parsePiOutput(stdout: string): { text: string; meta: Record<string, unknown> } {
  const raw = stdout.trim();
  if (!raw) {
    return { text: '', meta: {} };
  }

  const jsonLines = raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => parseJsonLine(line));

  if (jsonLines.length > 0 && jsonLines.every((line) => line !== null)) {
    return parsePiJsonEvents(jsonLines as Record<string, unknown>[], raw);
  }

  return { text: raw, meta: {} };
}

function parsePiJsonEvents(events: Record<string, unknown>[], fallback: string): { text: string; meta: Record<string, unknown> } {
  let streamingText = '';
  let lastText: string | null = null;
  const meta: Record<string, unknown> = {};

  for (const event of events) {
    collectPiMeta(event, meta);

    const responseText = textFromResponse(event);
    if (responseText !== null) {
      lastText = responseText;
      continue;
    }

    const eventText = textFromMessageEvent(event);
    if (eventText.kind === 'final') {
      lastText = eventText.text;
    } else if (eventText.kind === 'delta') {
      streamingText += eventText.text;
    }
  }

  return {
    text: (lastText || streamingText || fallback).trim(),
    meta,
  };
}

function parseJsonLine(line: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(line) as unknown;
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function collectPiMeta(event: Record<string, unknown>, meta: Record<string, unknown>): void {
  const data = isPlainObject(event.data) ? event.data : null;
  if (typeof event.sessionId === 'string') meta.sessionId = event.sessionId;
  if (typeof data?.sessionId === 'string') meta.sessionId = data.sessionId;
  if (typeof data?.sessionFile === 'string') meta.sessionFile = data.sessionFile;
  if (typeof event.type === 'string') meta.lastEventType = event.type;
}

function textFromResponse(event: Record<string, unknown>): string | null {
  if (event.type !== 'response') return null;
  const data = isPlainObject(event.data) ? event.data : null;
  if (typeof data?.text === 'string') return data.text;
  if (typeof data?.result === 'string') return data.result;
  return null;
}

function textFromMessageEvent(event: Record<string, unknown>): { kind: 'none' } | { kind: 'delta' | 'final'; text: string } {
  const messageEvent = isPlainObject(event.assistantMessageEvent)
    ? event.assistantMessageEvent
    : isPlainObject(event.messageEvent)
      ? event.messageEvent
      : null;
  if (!messageEvent) return { kind: 'none' };

  if (typeof messageEvent.delta === 'string') {
    return { kind: 'delta', text: messageEvent.delta };
  }
  if (typeof messageEvent.text === 'string') {
    return { kind: 'final', text: messageEvent.text };
  }
  if (typeof messageEvent.content === 'string') {
    return { kind: 'final', text: messageEvent.content };
  }
  return { kind: 'none' };
}
