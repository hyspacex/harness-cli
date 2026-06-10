import { parseRuntimeMode } from './ceremony.js';
import type { HarnessConfig, ProviderName } from './types.js';

export function buildOverrides(flags: Record<string, string>): Partial<HarnessConfig> {
  const overrides: Partial<HarnessConfig> = {};
  if (flags.provider) overrides.provider = flags.provider as HarnessConfig['provider'];
  if (flags['runtime-mode']) overrides.runtimeMode = parseRuntimeMode(flags['runtime-mode']);
  if (flags.workspace) overrides.workspace = flags.workspace;
  if (flags['run-root']) overrides.runRoot = flags['run-root'];
  if (flags.approval) overrides.approvalPolicy = flags.approval as HarnessConfig['approvalPolicy'];
  if (flags['max-sprints']) overrides.maxSprints = parsePositiveInteger('--max-sprints', flags['max-sprints']);
  if (flags['max-repair-rounds']) overrides.maxRepairRounds = parsePositiveInteger('--max-repair-rounds', flags['max-repair-rounds']);
  if (flags['max-negotiation-rounds']) overrides.maxNegotiationRounds = parsePositiveInteger('--max-negotiation-rounds', flags['max-negotiation-rounds']);
  return overrides;
}

function parsePositiveInteger(name: string, raw: string): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    throw new Error(`Invalid value for ${name}: "${raw}". Expected a positive integer.`);
  }
  return value;
}

export function flagEnabled(flags: Record<string, string>, name: string): boolean {
  const value = flags[name];
  if (value === undefined) return false;
  return value !== 'false' && value !== '0' && value !== 'no';
}

export function parseProviderName(value: string | undefined): ProviderName | undefined {
  if (!value) return undefined;
  if (value === 'claude-sdk' || value === 'codex') return value;
  throw new Error(`Unsupported judge provider: ${value}`);
}
