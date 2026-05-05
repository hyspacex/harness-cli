import type { ExecutionProfile, HarnessProfileConfig, ProviderName, RoleProviderMap } from './types.js';

const ALL_CLAUDE: RoleProviderMap = {
  researcher: 'claude-sdk',
  planner: 'claude-sdk',
  generator: 'claude-sdk',
  evaluator: 'claude-sdk',
};

const ALL_CODEX: RoleProviderMap = {
  researcher: 'codex',
  planner: 'codex',
  generator: 'codex',
  evaluator: 'codex',
};

const HYBRID_CODEX_GENERATOR: RoleProviderMap = {
  researcher: 'claude-sdk',
  planner: 'claude-sdk',
  generator: 'codex',
  evaluator: 'claude-sdk',
};

const HYBRID_CODEX_PLAN_AND_BUILD: RoleProviderMap = {
  researcher: 'claude-sdk',
  planner: 'codex',
  generator: 'codex',
  evaluator: 'claude-sdk',
};

export const BUILTIN_EXECUTION_PROFILES: ExecutionProfile[] = [
  {
    name: 'full-harness',
    description: 'Use the configured provider mix with the full research, plan, contract, build, eval, and repair loop.',
    tags: ['baseline', 'full-loop'],
    useWhen: ['You want the existing harness behavior without profile overrides.'],
    config: {},
  },
  {
    name: 'balanced',
    description: 'Claude owns research/planning/evaluation while Codex owns implementation.',
    tags: ['hybrid', 'default', 'quality'],
    useWhen: ['General application work where Codex generation and Claude QA complement each other.'],
    config: {
      provider: 'claude-sdk',
      roleProviders: HYBRID_CODEX_GENERATOR,
      maxRepairRounds: 2,
      maxNegotiationRounds: 3,
      codex: {
        effort: 'high',
        summary: 'concise',
        serviceTier: 'fast',
      },
    },
  },
  {
    name: 'visual-qa',
    description: 'Hybrid build with Claude/Playwright evaluation emphasized for UI-heavy work.',
    tags: ['hybrid', 'frontend', 'browser-qa'],
    useWhen: ['Frontend, dashboard, interaction, and visual QA cases.'],
    config: {
      provider: 'claude-sdk',
      roleProviders: HYBRID_CODEX_GENERATOR,
      maxRepairRounds: 2,
      claudeSdk: {
        roleOverrides: {
          evaluator: {
            settingSources: ['project'],
            mcpServers: {
              playwright: {
                command: 'npx',
                args: ['-y', '@playwright/mcp@latest'],
              },
            },
          },
        },
      },
      codex: {
        effort: 'high',
        summary: 'concise',
        serviceTier: 'fast',
      },
    },
  },
  {
    name: 'codex-planner-builder',
    description: 'Claude researches and evaluates; Codex plans and implements.',
    tags: ['hybrid', 'codex-heavy'],
    useWhen: ['You want to stress Codex on both decomposition and implementation while retaining Claude QA.'],
    config: {
      provider: 'claude-sdk',
      roleProviders: HYBRID_CODEX_PLAN_AND_BUILD,
      codex: {
        effort: 'high',
        summary: 'concise',
        serviceTier: 'fast',
      },
    },
  },
  {
    name: 'fast',
    description: 'Lower-cost scout pass with smaller sprint and repair budgets.',
    tags: ['fast', 'cheap', 'scout'],
    useWhen: ['Early exploration, prompt smoke tests, or quick signal before a full run.'],
    config: {
      provider: 'claude-sdk',
      roleProviders: HYBRID_CODEX_GENERATOR,
      maxSprints: 2,
      maxRepairRounds: 1,
      maxNegotiationRounds: 1,
      codex: {
        effort: 'medium',
        summary: 'concise',
        serviceTier: 'fast',
      },
      claudeSdk: {
        maxTurns: 25,
      },
    },
  },
  {
    name: 'claude-only',
    description: 'All roles run through the Claude Agent SDK.',
    tags: ['single-provider', 'claude'],
    useWhen: ['You want the strongest Claude SDK feature coverage and one-provider traces.'],
    config: {
      provider: 'claude-sdk',
      roleProviders: ALL_CLAUDE,
    },
  },
  {
    name: 'codex-only',
    description: 'All roles run through Codex app-server.',
    tags: ['single-provider', 'codex'],
    useWhen: ['You want to benchmark Codex end-to-end or isolate Claude SDK effects.'],
    config: {
      provider: 'codex',
      roleProviders: ALL_CODEX,
    },
  },
  {
    name: 'safe-ci',
    description: 'Conservative profile for CI-like dry runs and guarded automation.',
    tags: ['ci', 'safe', 'guarded'],
    useWhen: ['Automation where broad permissions, network access, and interactive approvals are undesirable.'],
    config: {
      provider: 'claude-sdk',
      roleProviders: ALL_CLAUDE,
      approvalPolicy: 'reject_once',
      claudeSdk: {
        permissionMode: 'default',
      },
      codex: {
        approvalMode: 'never',
        networkAccess: false,
        sandboxMode: 'workspaceWrite',
      },
    },
  },
];

export function listExecutionProfiles(customProfiles: Record<string, HarnessProfileConfig> = {}): ExecutionProfile[] {
  const custom = Object.entries(customProfiles).map(([name, config]) => ({
    name,
    description: 'Project-defined execution profile.',
    tags: ['custom'],
    useWhen: ['Defined in harness.config.json.'],
    config,
  }));

  const customNames = new Set(custom.map((profile) => profile.name));
  return [
    ...BUILTIN_EXECUTION_PROFILES.filter((profile) => !customNames.has(profile.name)),
    ...custom,
  ].sort((a, b) => a.name.localeCompare(b.name));
}

export function resolveExecutionProfile(
  name: string,
  customProfiles: Record<string, HarnessProfileConfig> = {},
): ExecutionProfile {
  const profile = listExecutionProfiles(customProfiles).find((candidate) => candidate.name === name);
  if (!profile) {
    const names = listExecutionProfiles(customProfiles).map((candidate) => candidate.name).join(', ');
    throw new Error(`Unknown execution profile "${name}". Available profiles: ${names}`);
  }
  return profile;
}

export function recommendExecutionProfiles(input: { category?: string | null; prompt?: string | null }): string[] {
  const category = String(input.category || '').toLowerCase();
  const prompt = String(input.prompt || '').toLowerCase();
  const haystack = `${category} ${prompt}`;

  if (category === 'frontend' || /ui|frontend|dashboard|browser|visual|accessib/.test(haystack)) {
    return ['fast', 'visual-qa'];
  }

  if (category === 'cli' || /cli|command|terminal|developer tool|harness/.test(haystack)) {
    return ['fast', 'balanced'];
  }

  if (category === 'backend' || /api|server|database|schema/.test(haystack)) {
    return ['fast', 'balanced'];
  }

  return ['fast', 'balanced'];
}

export function expandExecutionProfileSelection(
  selection: string | null | undefined,
  input: { category?: string | null; prompt?: string | null } = {},
  customProfiles: Record<string, HarnessProfileConfig> = {},
): string[] {
  const raw = selection && selection.trim() ? selection : 'adaptive';
  const names = raw === 'adaptive'
    ? recommendExecutionProfiles(input)
    : raw.split(',').map((name) => name.trim()).filter(Boolean);

  const uniqueNames = Array.from(new Set(names));
  for (const name of uniqueNames) {
    resolveExecutionProfile(name, customProfiles);
  }
  return uniqueNames;
}

export function providerMap(provider: ProviderName): RoleProviderMap {
  return {
    researcher: provider,
    planner: provider,
    generator: provider,
    evaluator: provider,
  };
}
