import { extractJsonObject } from '../utils.js';
import type {
  AgentRole,
  ApprovalPolicy,
  CodexConfig,
  CodexRoleConfig,
  CodexServiceTier,
  Provider,
  ProviderHooks,
  TaskDefinition,
  TaskResult,
} from '../types.js';
import { CodexAppServerClient } from './codex-client.js';

export class CodexProvider implements Provider {
  private command: string;
  private args: string[];
  private env: Record<string, string>;
  private model: string | null;
  private effort: string | null;
  private summary: string | null;
  private serviceTier: CodexServiceTier | null;
  private sandboxMode: CodexConfig['sandboxMode'];
  private networkAccess: boolean;
  private approvalMode: CodexConfig['approvalMode'];
  private roleOverrides: Partial<Record<AgentRole, CodexRoleConfig>>;
  private harnessApprovalPolicy: ApprovalPolicy;
  private onStdErr: NonNullable<ProviderHooks['onStdErr']>;
  private onUpdate: NonNullable<ProviderHooks['onUpdate']>;

  constructor(options: CodexConfig & { harnessApprovalPolicy?: ApprovalPolicy }, hooks: ProviderHooks = {}) {
    this.command = options.command || 'codex';
    this.args = Array.isArray(options.args) ? options.args : ['app-server'];
    this.env = options.env || {};
    this.model = options.model ?? null;
    this.effort = options.effort ?? null;
    this.summary = options.summary ?? null;
    this.serviceTier = options.serviceTier ?? null;
    this.sandboxMode = options.sandboxMode || 'workspaceWrite';
    this.networkAccess = options.networkAccess ?? true;
    this.approvalMode = options.approvalMode || 'onRequest';
    this.roleOverrides = options.roleOverrides || {};
    this.harnessApprovalPolicy = options.harnessApprovalPolicy || 'allow_once';
    this.onStdErr = hooks.onStdErr || (() => {});
    this.onUpdate = hooks.onUpdate || (() => {});
  }

  async runTask(task: TaskDefinition): Promise<TaskResult> {
    const client = new CodexAppServerClient({
      command: this.command,
      args: this.args,
      cwd: task.cwd,
      env: this.env,
      harnessApprovalPolicy: this.harnessApprovalPolicy,
      onStdErr: (chunk) => this.onStdErr(chunk, task),
      onUpdate: (update) => this.onUpdate(update, task),
    });

    const roleConfig = this.resolveRoleConfig(task.kind);

    try {
      const result = await client.runTurn({
        prompt: task.prompt,
        cwd: task.cwd,
        resumeThreadId: task.resumeSessionId,
        model: roleConfig.model,
        effort: roleConfig.effort,
        summary: roleConfig.summary,
        serviceTier: roleConfig.serviceTier,
        sandboxMode: this.sandboxMode,
        networkAccess: this.networkAccess,
        approvalMode: this.approvalMode,
      });

      return {
        rawText: result.text,
        parsed: extractJsonObject(result.text),
        meta: { sessionId: result.threadId, turnId: result.turnId, status: result.status },
      };
    } finally {
      await client.close();
    }
  }

  private resolveRoleConfig(role: AgentRole): CodexRoleConfig {
    const overrides = this.roleOverrides[role] || {};
    return {
      model: overrides.model !== undefined ? overrides.model : this.model,
      effort: overrides.effort !== undefined ? overrides.effort : this.effort,
      summary: overrides.summary !== undefined ? overrides.summary : this.summary,
      serviceTier: overrides.serviceTier !== undefined ? overrides.serviceTier : this.serviceTier,
    };
  }
}
