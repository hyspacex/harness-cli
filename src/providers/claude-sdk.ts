import { query } from '@anthropic-ai/claude-agent-sdk';
import { extractJsonObject } from '../utils.js';
import type {
  AgentRole,
  ClaudeSdkConfig,
  ClaudeSdkRoleConfig,
  ProviderHooks,
  ProviderRuntime,
  TaskDefinition,
  TaskResult,
} from '../types.js';

export class ClaudeSdkProvider implements ProviderRuntime {
  private model: string;
  private permissionMode: string;
  private baseMcpServers: Record<string, unknown>;
  private baseAllowedTools: string[];
  private baseMaxTurns: number | null;
  private env: Record<string, string>;
  private roleOverrides: Partial<Record<AgentRole, ClaudeSdkRoleConfig>>;
  private onStdErr: NonNullable<ProviderHooks['onStdErr']>;
  private onUpdate: NonNullable<ProviderHooks['onUpdate']>;

  constructor(options: ClaudeSdkConfig, hooks: ProviderHooks = {}) {
    this.model = options.model || 'claude-sonnet-4-6';
    this.permissionMode = options.permissionMode || 'bypassPermissions';
    this.baseMcpServers = options.mcpServers || {};
    this.baseAllowedTools = options.allowedTools || [];
    this.baseMaxTurns = options.maxTurns ?? null;
    this.env = options.env || {};
    this.roleOverrides = options.roleOverrides || {};
    this.onStdErr = hooks.onStdErr || (() => {});
    this.onUpdate = hooks.onUpdate || (() => {});
  }

  async runTask(task: TaskDefinition): Promise<TaskResult> {
    const options = this.resolveOptionsForTask(task);

    let assistantText = '';
    let resultText = '';
    let isError = false;
    let sessionId: string | undefined;

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      for await (const message of query({ prompt: task.prompt, options } as any)) {
        const msg = message as Record<string, unknown>;

        if (msg.type === 'system' && msg.subtype === 'init') {
          sessionId = msg.session_id as string;
        }

        if (msg.type === 'assistant') {
          const content = (msg.message as Record<string, unknown>)?.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              const b = block as Record<string, unknown>;
              if (b.type === 'text') {
                assistantText += b.text as string;
              }
              if (b.type === 'tool_use') {
                this.onUpdate({ sessionUpdate: 'tool_call', title: b.name as string }, task);
              }
            }
          }
        }

        if (msg.type === 'result' && msg.subtype === 'success') {
          resultText = (msg.result as string) || '';
          isError = !!(msg.is_error);
        }

        if (msg.type === 'result' && msg.subtype === 'error') {
          resultText = (msg.result as string) || (msg.error as string) || '';
          isError = true;
        }
      }
    } catch (error) {
      // SDK process crashed — use whatever we collected so far.
      const partialText = (resultText || assistantText).trim();
      if (partialText) {
        const parsed = extractJsonObject(partialText);
        if (parsed) {
          return { rawText: partialText, parsed, meta: { sessionId, crashed: true } };
        }
      }
      throw error;
    }

    if (isError && resultText) {
      throw new Error(`Claude Agent SDK: ${resultText}`);
    }

    const rawText = (resultText || assistantText).trim();

    return {
      rawText,
      parsed: extractJsonObject(rawText),
      meta: { sessionId },
    };
  }

  /**
   * Merge base SDK config with per-role overrides to produce the final options
   * for a single query() call.
   */
  private resolveOptionsForTask(task: TaskDefinition): Record<string, unknown> {
    const role = task.kind;
    const overrides = this.roleOverrides[role] || {};

    const options: Record<string, unknown> = {
      model: this.model,
      cwd: task.cwd,
      permissionMode: this.permissionMode,
      stderr: (text: string) => this.onStdErr(text, task),
    };

    // ---- MCP servers: merge base + role overrides ----
    const mergedMcp = { ...this.baseMcpServers, ...(overrides.mcpServers || {}) };
    if (Object.keys(mergedMcp).length > 0) {
      options.mcpServers = mergedMcp;
    }

    // ---- Allowed tools: combine base + role overrides ----
    const mergedTools = [...this.baseAllowedTools, ...(overrides.allowedTools || [])];
    if (mergedTools.length > 0) {
      options.allowedTools = [...new Set(mergedTools)];
    }

    // ---- Max turns: role override takes precedence ----
    const maxTurns = overrides.maxTurns !== undefined ? overrides.maxTurns : this.baseMaxTurns;
    if (maxTurns != null) {
      options.maxTurns = maxTurns;
    }

    // ---- System prompt: role override ----
    if (overrides.systemPrompt) {
      options.systemPrompt = overrides.systemPrompt;
    }

    // ---- Setting sources: enables skill loading from .claude/skills/ ----
    if (overrides.settingSources && overrides.settingSources.length > 0) {
      options.settingSources = overrides.settingSources;
    }

    // ---- Session resume for repair rounds ----
    if (task.resumeSessionId) {
      options.resume = task.resumeSessionId;
    }

    // ---- Env: only explicit overrides from config ----
    if (Object.keys(this.env).length > 0) {
      options.env = this.env;
    }

    return options;
  }
}
