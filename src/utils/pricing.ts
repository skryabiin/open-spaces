import * as vscode from 'vscode';

const PRICING: Record<number, number> = {
  2: 0.18,
  4: 0.36,
  8: 0.72,
  16: 1.44,
  32: 2.88,
};

/**
 * Returns the estimated hourly price for a machine with the given CPU count.
 * Matches the closest entry in the pricing table at or above the given CPU count.
 */
export function getHourlyPrice(cpus: number): number | null {
  const sortedCores = Object.keys(PRICING)
    .map(Number)
    .sort((a, b) => a - b);
  for (const cores of sortedCores) {
    if (cpus <= cores) {
      return PRICING[cores];
    }
  }
  return null;
}

/**
 * Formats a price as a localized string.
 */
export function formatPrice(price: number): string {
  return vscode.l10n.t('~${0}/hr', price.toFixed(2));
}
