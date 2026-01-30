import * as vscode from 'vscode';
import { MachineInfo } from '../types';

/**
 * Formats bytes into a human-readable string (MB or GB).
 */
export function formatBytes(bytes: number): string {
  if (bytes === 0) return vscode.l10n.t('0 B');
  const gb = bytes / (1024 * 1024 * 1024);
  if (gb >= 1) {
    return vscode.l10n.t('{0} GB', Math.round(gb));
  }
  const mb = bytes / (1024 * 1024);
  return vscode.l10n.t('{0} MB', Math.round(mb));
}

/**
 * Formats machine specs as a human-readable string.
 */
export function formatMachineSpecs(machineInfo: MachineInfo): string {
  const parts: string[] = [];
  if (machineInfo.cpus > 0) {
    parts.push(machineInfo.cpus === 1
      ? vscode.l10n.t('{0} core', machineInfo.cpus)
      : vscode.l10n.t('{0} cores', machineInfo.cpus));
  }
  if (machineInfo.memoryInBytes > 0) {
    parts.push(vscode.l10n.t('{0} RAM', formatBytes(machineInfo.memoryInBytes)));
  }
  return parts.join(' • ') || machineInfo.displayName || vscode.l10n.t('Unknown');
}

/**
 * Returns a human-readable "time ago" string.
 */
export function getTimeAgo(date: Date): string {
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();

  // Handle clock skew or future dates
  if (diffMs < 0) {
    return vscode.l10n.t('Just now');
  }

  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffMins < 1) {
    return vscode.l10n.t('Just now');
  } else if (diffMins < 60) {
    return vscode.l10n.t('{0}m ago', diffMins);
  } else if (diffHours < 24) {
    return vscode.l10n.t('{0}h ago', diffHours);
  } else if (diffDays < 7) {
    return vscode.l10n.t('{0}d ago', diffDays);
  } else {
    return date.toLocaleDateString();
  }
}

/**
 * Calculates idle time remaining for a running codespace.
 */
export function getIdleTimeRemaining(
  lastUsedAt: string,
  idleTimeoutMinutes: number
): { text: string; isLow: boolean } | null {
  if (!lastUsedAt || !idleTimeoutMinutes) {
    return null;
  }

  const lastUsed = new Date(lastUsedAt);
  const now = new Date();
  const elapsedMs = now.getTime() - lastUsed.getTime();
  const elapsedMins = Math.floor(elapsedMs / 60000);
  const remainingMins = idleTimeoutMinutes - elapsedMins;

  if (remainingMins <= 0) {
    return { text: vscode.l10n.t('Auto-stop imminent'), isLow: true };
  }

  const isLow = remainingMins <= 10;

  if (remainingMins < 60) {
    return { text: vscode.l10n.t('Auto-stop in {0}m', remainingMins), isLow };
  }

  const hours = Math.floor(remainingMins / 60);
  const mins = remainingMins % 60;

  if (mins === 0) {
    return { text: vscode.l10n.t('Auto-stop in {0}h', hours), isLow };
  }

  return { text: vscode.l10n.t('Auto-stop in {0}h {1}m', hours, mins), isLow };
}
