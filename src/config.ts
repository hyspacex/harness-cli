import path from 'node:path';
import type { HarnessConfig } from './types.js';
import { deepMerge, readJson, writeJson, toAbsolutePath } from './utils.js';

export const DEFAULT_CONFIG: HarnessConfig = {
  provider: 'claude-sdk',
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
  claudeSdk: {
    model: 'claude-opus-4-6',
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
    model: 'gpt-5.4',
    effort: 'xhigh',
    summary: 'concise',
    serviceTier: 'fast',
    sandboxMode: 'workspaceWrite',
    networkAccess: true,
    approvalMode: 'onRequest',
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
): Promise<{ config: HarnessConfig; configPath: string }> {
  const absoluteConfigPath = configPath
    ? path.resolve(configPath)
    : path.resolve(process.cwd(), 'harness.config.json');

  const fileConfig = (await readJson<Partial<HarnessConfig>>(absoluteConfigPath, {} as Partial<HarnessConfig>)) || {};
  const merged = deepMerge(DEFAULT_CONFIG, fileConfig) as HarnessConfig;
  const finalConfig = deepMerge(merged, overrides) as HarnessConfig;

  const configDir = path.dirname(absoluteConfigPath);
  finalConfig.workspace = toAbsolutePath(configDir, finalConfig.workspace);
  finalConfig.runRoot = toAbsolutePath(finalConfig.workspace, finalConfig.runRoot);
  return { config: finalConfig, configPath: absoluteConfigPath };
}

export async function writeDefaultConfig(configPath?: string): Promise<string> {
  const absoluteConfigPath = path.resolve(configPath || 'harness.config.json');
  await writeJson(absoluteConfigPath, DEFAULT_CONFIG);
  return absoluteConfigPath;
}
