import path from 'node:path';
import type { AgentRole, HarnessConfig, HarnessProfileConfig, RoleProviderMap } from './types.js';
import { resolveExecutionProfile } from './profiles.js';
import { deepMerge, readJson, writeJson, toAbsolutePath } from './utils.js';

const ALL_ROLES: AgentRole[] = ['researcher', 'planner', 'generator', 'evaluator'];

function buildUniformRoleProviders(provider: HarnessConfig['provider']): RoleProviderMap {
  return Object.fromEntries(ALL_ROLES.map((role) => [role, provider])) as RoleProviderMap;
}

function normalizeConfigFragment<T extends Partial<HarnessConfig> | HarnessProfileConfig>(fragment: T): T {
  const provider = fragment.provider as HarnessConfig['provider'] | undefined;
  const roleProviders = fragment.roleProviders as Partial<RoleProviderMap> | undefined;

  return {
    ...fragment,
    ...(provider ? { roleProviders: { ...buildUniformRoleProviders(provider), ...(roleProviders || {}) } } : {}),
  } as T;
}

function normalizeFinalConfig(config: HarnessConfig): HarnessConfig {
  return {
    ...config,
    roleProviders: {
      ...buildUniformRoleProviders(config.provider),
      ...(config.roleProviders || {}),
    },
  };
}

export const DEFAULT_CONFIG: HarnessConfig = {
  provider: 'claude-sdk',
  roleProviders: buildUniformRoleProviders('claude-sdk'),
  workspace: '.',
  runRoot: '.harness',
  maxSprints: 8,
  maxRepairRounds: 2,
  maxNegotiationRounds: 3,
  failFast: true,
  approvalPolicy: 'allow_once',
  git: {
    autoCommit: false,
  },
  smoke: {
    install: null,
    start: null,
    test: null,
    stop: null,
    startTimeout: 15000,
    startReadyPattern: null,
  },
  skills: {},
  profiles: {},
  claudeSdk: {
    model: 'claude-opus-4-7',
    permissionMode: 'bypassPermissions',
    mcpServers: {},
    allowedTools: [],
    maxTurns: null,
    env: {},
    roleOverrides: {
      researcher: {
        settingSources: ['project'],
      },
      planner: {
        settingSources: ['project'],
      },
      generator: {
        settingSources: ['project'],
        allowedTools: ['Skill'],
      },
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
    command: 'codex',
    args: ['app-server'],
    env: {},
    model: 'gpt-5.5',
    effort: 'xhigh',
    summary: 'concise',
    serviceTier: 'fast',
    sandboxMode: 'workspaceWrite',
    writableRoots: [],
    networkAccess: true,
    approvalMode: 'on-request',
    assumePlaywrightMcp: false,
    roleOverrides: {
      researcher: {},
      planner: {},
      generator: {},
      evaluator: {},
    },
  },
};

export async function loadConfig(
  configPath?: string,
  overrides: Partial<HarnessConfig> = {},
  options: { profile?: string | null } = {},
): Promise<{ config: HarnessConfig; configPath: string }> {
  const absoluteConfigPath = configPath
    ? path.resolve(configPath)
    : path.resolve(process.cwd(), 'harness.config.json');

  const fileConfig = (await readJson<Partial<HarnessConfig>>(absoluteConfigPath, {} as Partial<HarnessConfig>)) || {};
  const normalizedFileConfig = normalizeConfigFragment(fileConfig);
  const normalizedOverrides = normalizeConfigFragment(overrides);

  const merged = deepMerge(DEFAULT_CONFIG, normalizedFileConfig) as HarnessConfig;
  const profileConfig = options.profile
    ? normalizeConfigFragment(resolveExecutionProfile(options.profile, merged.profiles).config)
    : {};
  const profiled = deepMerge(merged, profileConfig) as HarnessConfig;
  const finalConfig = normalizeFinalConfig(deepMerge(profiled, normalizedOverrides) as HarnessConfig);

  const configDir = path.dirname(absoluteConfigPath);
  finalConfig.workspace = toAbsolutePath(configDir, finalConfig.workspace);
  finalConfig.runRoot = toAbsolutePath(finalConfig.workspace, finalConfig.runRoot);
  finalConfig.codex.writableRoots = (finalConfig.codex.writableRoots || []).map((root) =>
    toAbsolutePath(finalConfig.workspace, root),
  );
  return { config: finalConfig, configPath: absoluteConfigPath };
}

export async function writeDefaultConfig(configPath?: string): Promise<string> {
  const absoluteConfigPath = path.resolve(configPath || 'harness.config.json');
  await writeJson(absoluteConfigPath, DEFAULT_CONFIG);
  return absoluteConfigPath;
}
