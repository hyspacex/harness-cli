import type { CeremonyConfig, HarnessConfig, RuntimeMode } from './types.js';

export type CeremonyLevel = RuntimeMode | 'custom';

type CeremonySource = Pick<HarnessConfig, 'runtimeMode' | 'maxNegotiationRounds'> & {
  ceremony?: Partial<CeremonyConfig>;
};

/**
 * Resolve the effective ceremony dials. `runtimeMode` provides the ladder
 * defaults (full -> flat -> minimal); explicit `ceremony` entries override
 * the mode-derived values dial by dial.
 */
export function resolveCeremony(config: CeremonySource): CeremonyConfig {
  const negotiated = Math.max(1, config.maxNegotiationRounds);
  const byMode: Record<RuntimeMode, CeremonyConfig> = {
    full: { researcher: true, planner: true, negotiationRounds: negotiated },
    flat: { researcher: false, planner: false, negotiationRounds: negotiated },
    minimal: { researcher: false, planner: false, negotiationRounds: 0 },
  };
  const base = byMode[config.runtimeMode] || byMode.full;
  const overrides = config.ceremony || {};

  return {
    researcher: typeof overrides.researcher === 'boolean' ? overrides.researcher : base.researcher,
    planner: typeof overrides.planner === 'boolean' ? overrides.planner : base.planner,
    negotiationRounds: isNonNegativeInteger(overrides.negotiationRounds)
      ? overrides.negotiationRounds
      : base.negotiationRounds,
  };
}

/** Classify resolved dials back onto the ladder, or 'custom' for mixed dials. */
export function classifyCeremonyLevel(ceremony: CeremonyConfig): CeremonyLevel {
  if (!ceremony.researcher && !ceremony.planner) {
    return ceremony.negotiationRounds < 1 ? 'minimal' : 'flat';
  }
  if (ceremony.researcher && ceremony.planner && ceremony.negotiationRounds >= 1) {
    return 'full';
  }
  return 'custom';
}

export function describeCeremony(ceremony: CeremonyConfig): string {
  return [
    `researcher=${ceremony.researcher ? 'on' : 'bootstrapped'}`,
    `planner=${ceremony.planner ? 'on' : 'bootstrapped'}`,
    ceremony.negotiationRounds < 1
      ? 'contract=harness-authored'
      : `negotiationRounds=${ceremony.negotiationRounds}`,
  ].join(', ');
}

export function parseRuntimeMode(value: string): RuntimeMode {
  if (value === 'full' || value === 'flat' || value === 'minimal') {
    return value;
  }
  throw new Error(`Invalid runtime mode "${value}". Expected full, flat, or minimal.`);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}
