import type {
  AgentRole,
  ClaudeSdkSystemPrompt,
  HarnessConfig,
  Provider,
  ProviderHooks,
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
  if (config.provider !== 'claude-sdk') return config;

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

export function createProvider(config: HarnessConfig, hooks: ProviderHooks = {}): Provider {
  const resolved = injectClaudeSystemPrompts(config);

  switch (resolved.provider) {
    case 'claude-sdk':
      return new ClaudeSdkProvider(resolved.claudeSdk, hooks);
    case 'codex':
      return new CodexProvider(
        { ...resolved.codex, harnessApprovalPolicy: resolved.approvalPolicy },
        hooks,
      );
    default:
      throw new Error(`Unsupported provider: ${resolved.provider}`);
  }
}
