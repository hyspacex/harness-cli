import { spawn, type ChildProcess } from 'node:child_process';
import readline from 'node:readline';
import { nowIso } from '../utils.js';
import type {
  ApprovalPolicy,
  CodexApprovalMode,
  CodexSandboxMode,
  CodexServiceTier,
  ProviderHooks,
} from '../types.js';

interface CodexAppServerClientOptions {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  harnessApprovalPolicy?: ApprovalPolicy;
  clientInfo?: { name: string; title: string; version: string };
  onStdErr?: (chunk: string) => void;
  onUpdate?: (update: Record<string, unknown>) => void;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  method: string;
  createdAt: string;
}

interface RunTurnOptions {
  prompt: string;
  cwd: string;
  resumeThreadId?: string;
  model?: string | null;
  effort?: string | null;
  summary?: string | null;
  serviceTier?: CodexServiceTier | null;
  sandboxMode: CodexSandboxMode;
  networkAccess: boolean;
  approvalMode: CodexApprovalMode;
}

interface RunTurnResult {
  threadId: string;
  turnId: string;
  status: string;
  text: string;
}

type NotificationListener = (message: Record<string, unknown>) => void;

export class CodexAppServerClient {
  private command: string;
  private args: string[];
  private cwd: string | undefined;
  private env: Record<string, string>;
  private harnessApprovalPolicy: ApprovalPolicy;
  private clientInfo: { name: string; title: string; version: string };
  private onStdErr: (chunk: string) => void;
  private onUpdate: (update: Record<string, unknown>) => void;

  private seq = 1;
  private pending = new Map<number, PendingRequest>();
  private notificationListeners = new Set<NotificationListener>();
  private child: ChildProcess | null = null;
  private rl: readline.Interface | null = null;
  private started = false;
  private activeThreadId: string | null = null;

  constructor(options: CodexAppServerClientOptions) {
    this.command = options.command;
    this.args = Array.isArray(options.args) ? options.args : [];
    this.cwd = options.cwd;
    this.env = options.env || {};
    this.harnessApprovalPolicy = options.harnessApprovalPolicy || 'allow_once';
    this.clientInfo = options.clientInfo || {
      name: 'harness-cli',
      title: 'Harness CLI',
      version: '0.3.0',
    };
    this.onStdErr = options.onStdErr || (() => {});
    this.onUpdate = options.onUpdate || (() => {});
  }

  async start(): Promise<void> {
    if (this.started) return;

    this.child = spawn(this.command, this.args, {
      cwd: this.cwd,
      env: { ...process.env, ...this.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.child.stdout?.setEncoding('utf8');
    this.child.stderr?.setEncoding('utf8');

    this.rl = readline.createInterface({ input: this.child.stdout! });
    this.rl.on('line', (line) => {
      const trimmed = String(line || '').trim();
      if (!trimmed) return;
      this.handleMessage(trimmed);
    });

    this.child.stderr?.on('data', (chunk: string | Buffer) => {
      this.onStdErr(String(chunk));
    });

    this.child.on('error', (error: Error) => {
      this.rejectAllPending(error);
    });

    this.child.on('close', (code: number | null) => {
      if (code !== 0 && this.pending.size > 0) {
        this.rejectAllPending(new Error(`Codex app-server exited with code ${code}`));
      }
    });

    this.started = true;

    await this.request('initialize', {
      clientInfo: this.clientInfo,
    });
    this.notify('initialized', {});
  }

  async runTurn(options: RunTurnOptions): Promise<RunTurnResult> {
    await this.start();
    await this.ensureAuth();

    const threadId = await this.startOrResumeThread(options);
    this.activeThreadId = threadId;
    return this.startTurn(threadId, options);
  }

  async close(): Promise<void> {
    if (!this.started || !this.child) return;

    if (this.activeThreadId) {
      try {
        await this.request('thread/unsubscribe', { threadId: this.activeThreadId });
      } catch {
        // Ignore best-effort cleanup failures.
      }
    }

    try {
      this.child.stdin?.end();
    } catch {
      // ignore
    }

    if (!this.child.killed) {
      this.child.kill('SIGTERM');
    }

    this.started = false;
    this.activeThreadId = null;
    this.rl?.close();
    this.rl = null;
  }

  request(method: string, params: unknown): Promise<unknown> {
    const id = this.seq++;
    const payload = { id, method, params };

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method, createdAt: nowIso() });
      this.send(payload);
    });
  }

  private notify(method: string, params: unknown): void {
    this.send({ method, params });
  }

  private send(message: unknown): void {
    if (!this.child?.stdin?.writable) {
      throw new Error('Codex app-server stdin is not writable');
    }
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private async ensureAuth(): Promise<void> {
    const result = (await this.request('account/read', { refreshToken: false })) as {
      account?: { type?: string } | null;
      requiresOpenaiAuth?: boolean;
    };

    if (result?.account) {
      return;
    }

    if (!result?.requiresOpenaiAuth) {
      return;
    }

    await this.startChatGptLogin();
  }

  private async startChatGptLogin(): Promise<void> {
    const login = (await this.request('account/login/start', { type: 'chatgpt' })) as {
      type?: string;
      loginId?: string;
      authUrl?: string;
    };

    const authUrl = asString(login?.authUrl);
    if (!authUrl) {
      throw new Error('Codex ChatGPT login did not return an auth URL.');
    }

    const loginId = asString(login?.loginId);
    const details = loginId ? ` (loginId: ${loginId})` : '';
    this.onStdErr(
      `Codex ChatGPT login required. Open this URL in a browser and complete sign-in${details}: ${authUrl}\n`,
    );
    await this.waitForChatGptLoginCompletion(loginId, authUrl);
  }

  private waitForChatGptLoginCompletion(loginId: string | null, authUrl: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        reject(
          new Error(
            `Timed out waiting for Codex ChatGPT login to complete. Retry and finish sign-in while the harness is still running: ${authUrl}`,
          ),
        );
      }, 5 * 60_000);

      const cleanup = (): void => {
        clearTimeout(timeout);
        this.notificationListeners.delete(listener);
      };

      const listener: NotificationListener = (message) => {
        const method = asString(message.method);
        const params = asRecord(message.params);

        if (method === 'account/updated' && asString(params?.authMode) === 'chatgpt') {
          cleanup();
          resolve();
          return;
        }

        if (method !== 'account/login/completed') {
          return;
        }

        const completedLoginId = asString(params?.loginId);
        if (loginId && completedLoginId && completedLoginId !== loginId) {
          return;
        }

        cleanup();
        if (params?.success === true) {
          resolve();
          return;
        }

        const errorText = asString(params?.error) || 'unknown error';
        reject(new Error(`Codex ChatGPT login failed: ${errorText}`));
      };

      this.notificationListeners.add(listener);
    });
  }

  private async startOrResumeThread(options: RunTurnOptions): Promise<string> {
    if (options.resumeThreadId) {
      const resumed = (await this.request('thread/resume', {
        threadId: options.resumeThreadId,
        ...(options.model ? { model: options.model } : {}),
        ...(options.serviceTier ? { serviceTier: options.serviceTier } : {}),
      })) as { thread?: { id?: string } };
      const threadId = resumed?.thread?.id;
      if (!threadId) throw new Error('Codex thread/resume did not return a thread id');
      return threadId;
    }

    const started = (await this.request('thread/start', {
      cwd: options.cwd,
      ...(options.model ? { model: options.model } : {}),
      ...(options.serviceTier ? { serviceTier: options.serviceTier } : {}),
      approvalPolicy: options.approvalMode,
      sandbox: this.buildThreadSandbox(options.sandboxMode),
      serviceName: 'harness-cli',
    })) as { thread?: { id?: string } };

    const threadId = started?.thread?.id;
    if (!threadId) throw new Error('Codex thread/start did not return a thread id');
    return threadId;
  }

  private async startTurn(threadId: string, options: RunTurnOptions): Promise<RunTurnResult> {
    let turnId: string | null = null;
    let completed = false;
    let completedResult: RunTurnResult | null = null;
    let buffered: Record<string, unknown>[] = [];
    let deltaText = '';
    let latestAgentText = '';
    let finalAnswerText = '';
    let failureMessage: string | null = null;

    const handleTurnMessage = (message: Record<string, unknown>): void => {
      const method = asString(message.method);
      if (!method) return;
      const params = asRecord(message.params);

      if (method === 'turn/plan/updated') {
        const entries = Array.isArray(params?.plan)
          ? params.plan.map((entry) => {
              const record = asRecord(entry);
              return { content: `${asString(record?.status) || 'pending'}: ${asString(record?.step) || ''}`.trim() };
            })
          : [];
        if (entries.length > 0) {
          this.onUpdate({ sessionUpdate: 'plan', entries });
        }
        return;
      }

      if (method === 'item/agentMessage/delta') {
        const chunk =
          asString(params?.delta) ||
          asString(params?.text) ||
          asString(params?.textDelta) ||
          '';
        deltaText += chunk;
        return;
      }

      if (method === 'item/started') {
        const item = asRecord(params?.item);
        const title = item ? describeToolLikeItem(item) : null;
        if (title) {
          this.onUpdate({ sessionUpdate: 'tool_call', title });
        }
        return;
      }

      if (method === 'item/completed') {
        const item = asRecord(params?.item);
        if (!item) return;
        if (item.type === 'agentMessage') {
          const text = asString(item.text) || '';
          if (text) {
            latestAgentText = text;
          }
          if (item.phase === 'final_answer' && text) {
            finalAnswerText = text;
          }
        }
        return;
      }

      if (method === 'turn/completed') {
        const turn = asRecord(params?.turn);
        const finishedTurnId = asString(turn?.id);
        if (!turn || !turnId || !finishedTurnId || finishedTurnId !== turnId) {
          return;
        }

        const status = asString(turn.status) || 'failed';
        if (status !== 'completed') {
          const error = asRecord(turn.error);
          failureMessage = asString(error?.message) || `Codex turn ended with status ${status}`;
        }

        completed = true;
        completedResult = {
          threadId,
          turnId,
          status,
          text: (finalAnswerText || latestAgentText || deltaText).trim(),
        };
      }
    };

    const listener: NotificationListener = (message) => {
      if (!turnId) {
        buffered.push(message);
        return;
      }
      handleTurnMessage(message);
    };

    this.notificationListeners.add(listener);

    try {
      const turnStart = (await this.request('turn/start', {
        threadId,
        input: [{ type: 'text', text: options.prompt }],
        cwd: options.cwd,
        approvalPolicy: options.approvalMode,
        sandboxPolicy: this.buildSandboxPolicy(options.sandboxMode, options.cwd, options.networkAccess),
        ...(options.model ? { model: options.model } : {}),
        ...(options.effort ? { effort: options.effort } : {}),
        ...(options.summary ? { summary: options.summary } : {}),
        ...(options.serviceTier ? { serviceTier: options.serviceTier } : {}),
      })) as { turn?: { id?: string } };

      turnId = turnStart?.turn?.id || null;
      if (!turnId) {
        throw new Error('Codex turn/start did not return a turn id');
      }

      const bufferedMessages = buffered;
      buffered = [];
      for (const message of bufferedMessages) {
        handleTurnMessage(message);
      }

      while (!completed) {
        await sleep(25);
      }

      const finalResult = completedResult as RunTurnResult | null;
      if (!finalResult) {
        throw new Error('Codex turn completed without a result');
      }

      if (finalResult.status !== 'completed') {
        throw new Error(failureMessage || `Codex turn ended with status ${finalResult.status}`);
      }

      return finalResult;
    } finally {
      this.notificationListeners.delete(listener);
    }
  }

  private buildSandboxPolicy(
    sandboxMode: CodexSandboxMode,
    cwd: string,
    networkAccess: boolean,
  ): Record<string, unknown> {
    switch (sandboxMode) {
      case 'dangerFullAccess':
        return { type: 'dangerFullAccess' };
      case 'readOnly':
        return { type: 'readOnly' };
      case 'workspaceWrite':
      default:
        return {
          type: 'workspaceWrite',
          writableRoots: [cwd],
          networkAccess,
        };
    }
  }

  private buildThreadSandbox(sandboxMode: CodexSandboxMode): string {
    switch (sandboxMode) {
      case 'dangerFullAccess':
        return 'danger-full-access';
      case 'readOnly':
        return 'read-only';
      case 'workspaceWrite':
      default:
        return 'workspace-write';
    }
  }

  private handleMessage(line: string): void {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(line) as Record<string, unknown>;
    } catch (error) {
      this.onStdErr(`Codex app-server parse error: ${String(error)}\n${line}\n`);
      return;
    }

    const id = typeof message.id === 'number' ? message.id : null;
    const method = asString(message.method);

    if (id !== null && this.pending.has(id) && !method) {
      const pending = this.pending.get(id)!;
      this.pending.delete(id);
      if (message.error) {
        const err = asRecord(message.error);
        pending.reject(new Error(`Codex ${pending.method} failed: ${asString(err?.message) || JSON.stringify(err)}`));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (id !== null && method) {
      this.handleServerRequest(message).catch((error) => {
        this.onStdErr(`Codex server request failed: ${String(error)}\n`);
      });
      return;
    }

    for (const listener of this.notificationListeners) {
      listener(message);
    }
  }

  private async handleServerRequest(message: Record<string, unknown>): Promise<void> {
    const id = typeof message.id === 'number' ? message.id : null;
    const method = asString(message.method);
    if (id === null || !method) return;

    if (method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval') {
      this.send({ id, result: approvalDecisionForPolicy(this.harnessApprovalPolicy) });
      return;
    }

    if (method === 'account/chatgptAuthTokens/refresh') {
      this.send({
        id,
        error: {
          code: -32601,
          message: 'External ChatGPT token refresh is not supported by this harness.',
        },
      });
      return;
    }

    this.send({
      id,
      error: {
        code: -32601,
        message: `Unsupported Codex server request: ${method}`,
      },
    });
  }

  private rejectAllPending(error: Error): void {
    for (const [, pending] of this.pending) {
      pending.reject(error);
    }
    this.pending.clear();
  }
}

function approvalDecisionForPolicy(policy: ApprovalPolicy): string {
  switch (policy) {
    case 'allow_always':
      return 'acceptForSession';
    case 'allow_once':
      return 'accept';
    case 'reject_always':
      return 'decline';
    case 'reject_once':
    default:
      return 'decline';
  }
}

function describeToolLikeItem(item: Record<string, unknown>): string | null {
  switch (item.type) {
    case 'commandExecution': {
      if (Array.isArray(item.command)) {
        return (item.command as unknown[]).map((part) => String(part)).join(' ');
      }
      return asString(item.command) || 'commandExecution';
    }
    case 'mcpToolCall': {
      const server = asString(item.server) || 'mcp';
      const tool = asString(item.tool) || 'tool';
      return `${server}.${tool}`;
    }
    case 'dynamicToolCall':
      return asString(item.tool) || 'dynamicToolCall';
    case 'webSearch':
      return `webSearch: ${asString(item.query) || ''}`.trim();
    case 'imageView':
      return `imageView: ${asString(item.path) || ''}`.trim();
    default:
      return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
