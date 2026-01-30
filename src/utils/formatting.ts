import { MachineInfo } from '../types';

/**
 * Formats bytes into a human-readable string (MB or GB).
 */
export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const gb = bytes / (1024 * 1024 * 1024);
  if (gb >= 1) {
    return `${Math.round(gb)} GB`;
  }
  const mb = bytes / (1024 * 1024);
  return `${Math.round(mb)} MB`;
}

/**
 * Formats machine specs as a human-readable string.
 */
export function formatMachineSpecs(machineInfo: MachineInfo): string {
  const parts: string[] = [];
  if (machineInfo.cpus > 0) {
    parts.push(`${machineInfo.cpus} ${machineInfo.cpus === 1 ? 'core' : 'cores'}`);
  }
  if (machineInfo.memoryInBytes > 0) {
    parts.push(`${formatBytes(machineInfo.memoryInBytes)} RAM`);
  }
  return parts.join(' • ') || machineInfo.displayName || 'Unknown';
}

/**
 * Returns a human-readable "time ago" string.
 */
export function getTimeAgo(date: Date): string {
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();

  // Handle clock skew or future dates
  if (diffMs < 0) {
    return 'Just now';
  }

  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffMins < 1) {
    return 'Just now';
  } else if (diffMins < 60) {
    return `${diffMins}m ago`;
  } else if (diffHours < 24) {
    return `${diffHours}h ago`;
  } else if (diffDays < 7) {
    return `${diffDays}d ago`;
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
    return { text: 'Auto-stop imminent', isLow: true };
  }

  const isLow = remainingMins <= 10;

  if (remainingMins < 60) {
    return { text: `Auto-stop in ${remainingMins}m`, isLow };
  }

  const hours = Math.floor(remainingMins / 60);
  const mins = remainingMins % 60;

  if (mins === 0) {
    return { text: `Auto-stop in ${hours}h`, isLow };
  }

  return { text: `Auto-stop in ${hours}h ${mins}m`, isLow };
}
