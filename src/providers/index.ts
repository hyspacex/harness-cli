import type {
  AgentRole,
  ClaudeSdkSystemPrompt,
  HarnessConfig,
  ProviderName,
  ProviderHooks,
  ProviderRegistry,
  ProviderRuntime,
  RoleProviderMap,
  TaskCapabilities,
} from '../types.js';
import { SYSTEM_PROMPTS } from '../prompts.js';
import { ClaudeSdkProvider } from './claude-sdk.js';
import { CodexProvider } from './codex.js';

function mergeClaudeSystemPrompt(
  harnessPrompt: string,
  existing?: ClaudeSdkSystemPrompt,
): ClaudeSdkSystemPrompt {
  if (!existing) {
    return {
      type: 'preset',
      preset: 'claude_code',
      append: harnessPrompt,
    };
  }

  if (typeof existing === 'string') {
    return {
      type: 'preset',
      preset: 'claude_code',
      append: `${harnessPrompt}\n\n${existing}`,
    };
  }

  const appendedParts = [harnessPrompt, existing.append].filter(Boolean);
  return {
    ...existing,
    append: appendedParts.join('\n\n'),
  };
}

/**
 * Merge harness system prompts into Claude SDK role overrides so the provider gets
 * them without the harness having to pass them per-task. We use the Claude Code
 * preset so CLAUDE.md and project settings remain active.
 */
function injectClaudeSystemPrompts(config: HarnessConfig): HarnessConfig {
  const overrides = { ...config.claudeSdk.roleOverrides };
  for (const role of ['researcher', 'planner', 'generator', 'evaluator'] as AgentRole[]) {
    const existing = overrides[role] || {};
    overrides[role] = {
      ...existing,
      systemPrompt: mergeClaudeSystemPrompt(SYSTEM_PROMPTS[role], existing.systemPrompt),
    };
  }

  return {
    ...config,
    claudeSdk: { ...config.claudeSdk, roleOverrides: overrides },
  };
}

function createRuntime(
  providerName: ProviderName,
  config: HarnessConfig,
  hooks: ProviderHooks,
): ProviderRuntime {
  switch (providerName) {
    case 'claude-sdk':
      return new ClaudeSdkProvider(config.claudeSdk, hooks);
    case 'codex':
      return new CodexProvider(
        { ...config.codex, harnessApprovalPolicy: config.approvalPolicy },
        hooks,
      );
    default:
      throw new Error(`Unsupported provider: ${providerName}`);
  }
}

function createTaskCapabilities(
  config: HarnessConfig,
  role: AgentRole,
  provider: ProviderName,
): TaskCapabilities {
  const hasBrowserQa = role === 'evaluator'
    ? provider === 'claude-sdk'
      ? 'playwright' in (config.claudeSdk.roleOverrides.evaluator?.mcpServers || {})
      : config.codex.assumePlaywrightMcp
    : false;

  return {
    role,
    provider,
    hasBrowserQa,
    supportsSessionResume: provider === 'claude-sdk' || provider === 'codex',
  };
}

export function createProvider(config: HarnessConfig, hooks: ProviderHooks = {}): ProviderRegistry {
  const resolved = injectClaudeSystemPrompts(config);
  const routing: RoleProviderMap = { ...resolved.roleProviders };
  const runtimes = new Map<ProviderName, ProviderRuntime>();
  const capabilities = Object.fromEntries(
    (Object.keys(routing) as AgentRole[]).map((role) => [
      role,
      createTaskCapabilities(resolved, role, routing[role]),
    ]),
  ) as Record<AgentRole, TaskCapabilities>;

  for (const providerName of new Set(Object.values(routing))) {
    runtimes.set(providerName, createRuntime(providerName, resolved, hooks));
  }

  return {
    async runTask(task) {
      const taskCapabilities = task.capabilities || capabilities[task.kind];
      const runtime = runtimes.get(taskCapabilities.provider);
      if (!runtime) {
        throw new Error(`No provider runtime configured for ${taskCapabilities.provider}`);
      }

      const result = await runtime.runTask({
        ...task,
        capabilities: taskCapabilities,
      });

      return {
        ...result,
        meta: {
          ...result.meta,
          provider: taskCapabilities.provider,
        },
      };
    },
    getProviderName(role: AgentRole): ProviderName {
      return routing[role];
    },
    getTaskCapabilities(role: AgentRole): TaskCapabilities {
      return capabilities[role];
    },
    getRouting(): RoleProviderMap {
      return { ...routing };
    },
  };
}
