import type { RunHistoryEntry } from './history.js';

export interface CeremonyRoiRow {
  generatorProvider: string;
  ceremonyLevel: string;
  profiles: string[];
  runs: number;
  completionRate: number;
  firstRoundPassRate: number | null;
  avgRepairRoundsToPass: number | null;
  avgTasksStarted: number;
  negotiationApprovalRate: number | null;
  finalRegressionFailures: number;
}

export interface CeremonyRoiReport {
  version: 1;
  builtAt: string;
  runRoot: string;
  totalRuns: number;
  rows: CeremonyRoiRow[];
  findings: string[];
}

const CEREMONY_ORDER = ['minimal', 'flat', 'custom', 'full', 'unknown'];
/** Pass-rate edge (percentage points / 100) ceremony must buy to count as paying for itself. */
const ROI_PASS_RATE_EDGE = 0.1;

export function buildCeremonyRoiReport(
  entries: RunHistoryEntry[],
  options: { runRoot: string; builtAt: string },
): CeremonyRoiReport {
  const groups = new Map<string, RunHistoryEntry[]>();
  for (const entry of entries) {
    const key = `${entry.generatorProvider}::${entry.ceremonyLevel}`;
    const existing = groups.get(key) || [];
    existing.push(entry);
    groups.set(key, existing);
  }

  const rows: CeremonyRoiRow[] = Array.from(groups.entries())
    .map(([key, groupEntries]) => {
      const [generatorProvider, ceremonyLevel] = key.split('::');
      const repairSamples = groupEntries.flatMap((entry) => entry.repairRoundsToPass);
      const approvalAttempts = sum(groupEntries.map((entry) => entry.contractApprovalAttempts));
      return {
        generatorProvider,
        ceremonyLevel,
        profiles: Array.from(
          new Set(groupEntries.map((entry) => entry.profile || '(none)')),
        ).sort(),
        runs: groupEntries.length,
        completionRate: ratio(groupEntries.filter((entry) => entry.completed).length, groupEntries.length),
        firstRoundPassRate: repairSamples.length > 0
          ? ratio(repairSamples.filter((rounds) => rounds === 0).length, repairSamples.length)
          : null,
        avgRepairRoundsToPass: repairSamples.length > 0 ? mean(repairSamples) : null,
        avgTasksStarted: mean(groupEntries.map((entry) => entry.totalTasksStarted)),
        negotiationApprovalRate: approvalAttempts > 0
          ? ratio(sum(groupEntries.map((entry) => entry.contractApprovalPasses)), approvalAttempts)
          : null,
        finalRegressionFailures: sum(groupEntries.map((entry) => entry.finalRegressionFailures)),
      };
    })
    .sort(
      (a, b) =>
        a.generatorProvider.localeCompare(b.generatorProvider) ||
        ceremonyRank(a.ceremonyLevel) - ceremonyRank(b.ceremonyLevel),
    );

  return {
    version: 1,
    builtAt: options.builtAt,
    runRoot: options.runRoot,
    totalRuns: entries.length,
    rows,
    findings: buildFindings(rows),
  };
}

/**
 * Per provider, compare each higher ceremony level against the cheapest level
 * with data: does the extra ceremony buy enough pass-rate to justify its cost?
 */
function buildFindings(rows: CeremonyRoiRow[]): string[] {
  const findings: string[] = [];
  const providers = Array.from(new Set(rows.map((row) => row.generatorProvider))).sort();

  for (const provider of providers) {
    const providerRows = rows
      .filter((row) => row.generatorProvider === provider && row.ceremonyLevel !== 'unknown')
      .sort((a, b) => ceremonyRank(a.ceremonyLevel) - ceremonyRank(b.ceremonyLevel));
    if (providerRows.length < 2) {
      findings.push(
        `${provider}: only ${providerRows.length} ceremony level(s) have run history — run the benchmark suite across the ladder to compare.`,
      );
      continue;
    }

    const baseline = providerRows[0];
    for (const candidate of providerRows.slice(1)) {
      const passDelta = rateDelta(candidate.firstRoundPassRate, baseline.firstRoundPassRate)
        ?? candidate.completionRate - baseline.completionRate;
      const passMetric = candidate.firstRoundPassRate !== null && baseline.firstRoundPassRate !== null
        ? 'first-round pass'
        : 'completion';
      const costDelta = candidate.avgTasksStarted - baseline.avgTasksStarted;
      const paysOff = passDelta > ROI_PASS_RATE_EDGE;
      findings.push(
        `${provider}: ${candidate.ceremonyLevel} ceremony vs ${baseline.ceremonyLevel} — ` +
          `${passMetric} ${formatPercent(passDelta, true)} at ${formatSigned(costDelta)} tasks/run; ` +
          (paysOff
            ? 'the extra ceremony is paying for itself.'
            : `the extra ceremony is NOT buying a ${Math.round(ROI_PASS_RATE_EDGE * 100)}pt pass-rate edge — prefer ${baseline.ceremonyLevel}.`),
      );
    }
  }

  if (findings.length === 0) {
    findings.push('No run history found. Run the harness (or the benchmark suite) first, then rebuild this report.');
  }
  return findings;
}

export function renderCeremonyRoiMarkdown(report: CeremonyRoiReport): string {
  const lines: string[] = [];
  lines.push('# Ceremony ROI Report');
  lines.push('');
  lines.push(`Built at: ${report.builtAt}`);
  lines.push(`Run root: ${report.runRoot}`);
  lines.push(`Runs analyzed: ${report.totalRuns}`);
  lines.push('');
  lines.push('Measures whether role separation and contract negotiation ceremony pays for itself per generator provider.');
  lines.push('Verification gates are mandatory at every ceremony level and are not part of this trade-off.');
  lines.push('');
  lines.push('## Findings');
  lines.push('');
  for (const finding of report.findings) {
    lines.push(`- ${finding}`);
  }
  lines.push('');
  lines.push('## Per Provider × Ceremony Level');
  lines.push('');
  lines.push('| Provider | Ceremony | Runs | Completion | First-round pass | Avg repair rounds | Avg tasks/run | Negotiation approval | Final regression failures | Profiles |');
  lines.push('|---|---|---|---|---|---|---|---|---|---|');
  for (const row of report.rows) {
    lines.push(
      `| ${row.generatorProvider} | ${row.ceremonyLevel} | ${row.runs} ` +
        `| ${formatPercent(row.completionRate)} ` +
        `| ${row.firstRoundPassRate === null ? 'n/a' : formatPercent(row.firstRoundPassRate)} ` +
        `| ${row.avgRepairRoundsToPass === null ? 'n/a' : row.avgRepairRoundsToPass.toFixed(2)} ` +
        `| ${row.avgTasksStarted.toFixed(1)} ` +
        `| ${row.negotiationApprovalRate === null ? 'n/a' : formatPercent(row.negotiationApprovalRate)} ` +
        `| ${row.finalRegressionFailures} ` +
        `| ${row.profiles.join(', ')} |`,
    );
  }
  lines.push('');
  return `${lines.join('\n')}`;
}

function ceremonyRank(level: string): number {
  const index = CEREMONY_ORDER.indexOf(level);
  return index === -1 ? CEREMONY_ORDER.length : index;
}

function rateDelta(a: number | null, b: number | null): number | null {
  return a !== null && b !== null ? a - b : null;
}

function formatPercent(value: number, signed = false): string {
  const points = Math.round(value * 100);
  return signed ? `${points >= 0 ? '+' : ''}${points}pt` : `${points}%`;
}

function formatSigned(value: number): string {
  return `${value >= 0 ? '+' : ''}${value.toFixed(1)}`;
}

function ratio(numerator: number, denominator: number): number {
  return denominator > 0 ? numerator / denominator : 0;
}

function mean(values: number[]): number {
  return values.length > 0 ? values.reduce((total, value) => total + value, 0) / values.length : 0;
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}
