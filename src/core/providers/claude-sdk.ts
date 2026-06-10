import { query, type OutputFormat } from '@anthropic-ai/claude-agent-sdk';
import { extractJsonObject, isPlainObject } from '../utils.js';
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
    this.model = options.model || 'claude-opus-4-7';
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
    let structuredOutput: Record<string, unknown> | null = null;
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
          if (isPlainObject(msg.structured_output)) {
            structuredOutput = msg.structured_output;
          }
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
      parsed: structuredOutput || extractJsonObject(rawText),
      meta: { sessionId, structuredOutput: !!structuredOutput },
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

    const outputFormat = buildClaudeTaskOutputFormat(task);
    if (outputFormat) {
      options.outputFormat = outputFormat;
    }

    return options;
  }
}

export function buildClaudeTaskOutputFormat(task: Pick<TaskDefinition, 'kind' | 'label'>): OutputFormat {
  const summaryProperty = { type: 'string' };
  const stringArrayProperty = { type: 'array', items: { type: 'string' } };
  const schema: Record<string, unknown> = {
    type: 'object',
    additionalProperties: true,
    properties: {
      status: { type: 'string' },
      summary: summaryProperty,
      filesWritten: stringArrayProperty,
      filesTouched: stringArrayProperty,
      commandsRun: stringArrayProperty,
      risks: stringArrayProperty,
      feedback: stringArrayProperty,
      scores: {
        type: 'object',
        additionalProperties: { type: 'number' },
      },
      bugs: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: true,
        },
      },
      confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
      evidenceQuality: { type: 'string', enum: ['weak', 'adequate', 'strong'] },
    },
    required: ['summary'],
  };

  if (isPairwiseJudgeTask(task)) {
    schema.required = ['winner', 'confidence', 'dimensionScores', 'criticalRegressions', 'rationale'];
    Object.assign(schema.properties as Record<string, unknown>, {
      version: { type: 'number' },
      winner: { type: 'string', enum: ['A', 'B', 'tie', 'inconclusive'] },
      confidence: { type: 'number', minimum: 1, maximum: 5 },
      evaluationSpecHash: { type: 'string' },
      dimensionScores: {
        type: 'object',
        additionalProperties: {
          type: 'object',
          additionalProperties: false,
          properties: {
            A: { type: 'number', minimum: 1, maximum: 5 },
            B: { type: 'number', minimum: 1, maximum: 5 },
          },
          required: ['A', 'B'],
        },
      },
      criticalRegressions: stringArrayProperty,
      rationale: summaryProperty,
    });
  } else if (task.label.startsWith('contract-review')) {
    schema.required = ['status', 'summary', 'feedback'];
    (schema.properties as Record<string, unknown>).status = { type: 'string', enum: ['approved', 'revise'] };
  } else if (task.kind === 'evaluator') {
    schema.required = ['summary', 'confidence', 'evidenceQuality', 'scores', 'bugs'];
  } else if (task.label.startsWith('contract-draft')) {
    schema.required = ['status', 'summary', 'filesWritten'];
    Object.assign(schema.properties as Record<string, unknown>, {
      contractPath: { type: 'string' },
      contractJsonPath: { type: 'string' },
    });
  } else if (task.kind === 'researcher') {
    schema.required = ['status', 'summary', 'filesWritten'];
    Object.assign(schema.properties as Record<string, unknown>, {
      projectType: { type: 'string' },
      criteriaCount: { type: 'number' },
    });
  } else if (task.kind === 'planner') {
    schema.required = ['status', 'summary', 'filesWritten'];
    (schema.properties as Record<string, unknown>).featureCount = { type: 'number' };
  } else if (task.kind === 'generator') {
    schema.required = ['status', 'summary'];
    Object.assign(schema.properties as Record<string, unknown>, {
      selfCheck: {
        type: 'object',
        additionalProperties: true,
      },
      commit: {},
    });
  }

  return {
    type: 'json_schema',
    schema,
  };
}

function isPairwiseJudgeTask(task: Pick<TaskDefinition, 'label'>): boolean {
  return task.label.startsWith('meta-judge-') || task.label.startsWith('matrix-judge-');
}
