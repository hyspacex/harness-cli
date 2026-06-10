/**
 * Scrub structured secrets (API keys, tokens, bearer credentials) from text
 * before it is written into eval packets, judge prompts, or objective-check
 * output. Pure string transform with no lab-internal dependencies, so it can be
 * shared by packet.ts and objective-checks.ts without an import cycle.
 */
export function redactSensitiveText(value: string | null | undefined): string | null {
  if (value == null) return null;
  return value
    .replace(/sk-ant-[A-Za-z0-9.*_-]+/g, 'anthropic-key-[redacted]')
    .replace(/sk-proj-[A-Za-z0-9.*_-]+/g, 'openai-key-[redacted]')
    .replace(/sk-[A-Za-z0-9.*_-]{12,}/g, 'api-key-[redacted]')
    .replace(/gh[pousr]_[A-Za-z0-9_]{20,}/g, 'github-token-[redacted]')
    .replace(/glpat-[A-Za-z0-9_-]{20,}/g, 'gitlab-token-[redacted]')
    .replace(/xox[baprs]-[A-Za-z0-9-]{10,}/g, 'slack-token-[redacted]')
    .replace(/(?:AKIA|ASIA)[A-Z0-9]{16}/g, 'aws-access-key-[redacted]')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(
      /((?:api[_-]?key|token|authorization|password|secret)["' \t]*[:=]\s*["']?)([A-Za-z0-9._\-+/=]{8,})/gi,
      '$1[redacted]',
    );
}
