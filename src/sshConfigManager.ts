import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { SshConfigEntry } from './types';

const SSH_CONFIG_PATH = path.join(os.homedir(), '.ssh', 'config');
const SSH_DIR = path.join(os.homedir(), '.ssh');
const MARKER_START = '# >>> Open Spaces';
const MARKER_END = '# <<< Open Spaces';

/**
 * Validates an SSH config value to prevent injection attacks.
 * @param key - The config key name (for error messages)
 * @param value - The value to validate
 * @returns The validated value
 * @throws {Error} If the value contains newlines or control characters
 */
function validateSshConfigValue(key: string, value: string): string {
  // Reject values with newlines or control characters that could inject config
  // eslint-disable-next-line no-control-regex
  if (/[\n\r\x00-\x1f]/.test(value)) {
    throw new Error(`Invalid SSH config value for ${key}: contains control characters`);
  }
  return value;
}

function ensureSshDir(): void {
  if (!fs.existsSync(SSH_DIR)) {
    fs.mkdirSync(SSH_DIR, { mode: 0o700 });
  }
}

function readSshConfig(): string {
  ensureSshDir();
  if (!fs.existsSync(SSH_CONFIG_PATH)) {
    return '';
  }
  return fs.readFileSync(SSH_CONFIG_PATH, 'utf-8');
}

function writeSshConfig(content: string): void {
  ensureSshDir();
  fs.writeFileSync(SSH_CONFIG_PATH, content, { mode: 0o600 });
}

/**
 * Parses SSH config output from gh CLI into structured entries.
 * @param configOutput - Raw SSH config output string
 * @returns Array of parsed SSH config entries
 */
export function parseSshConfigOutput(configOutput: string): SshConfigEntry[] {
  const entries: SshConfigEntry[] = [];
  let currentEntry: Partial<SshConfigEntry> | null = null;

  const lines = configOutput.split('\n');

  for (const line of lines) {
    const trimmed = line.trim();

    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    const match = trimmed.match(/^(\S+)\s+(.+)$/);
    if (!match) {
      continue;
    }

    const [, key, value] = match;
    const keyLower = key.toLowerCase();

    if (keyLower === 'host') {
      if (currentEntry && currentEntry.host) {
        entries.push(currentEntry as SshConfigEntry);
      }
      currentEntry = { host: value };
    } else if (currentEntry) {
      switch (keyLower) {
        case 'hostname':
          currentEntry.hostName = value;
          break;
        case 'user':
          currentEntry.user = value;
          break;
        case 'proxycommand':
          currentEntry.proxyCommand = value;
          break;
        case 'identityfile':
          currentEntry.identityFile = value;
          break;
        case 'stricthostkeychecking':
          currentEntry.strictHostKeyChecking = value;
          break;
        case 'userknownhostsfile':
          currentEntry.userKnownHostsFile = value;
          break;
        case 'loglevel':
          currentEntry.logLevel = value;
          break;
        case 'controlmaster':
          currentEntry.controlMaster = value;
          break;
        case 'controlpath':
          currentEntry.controlPath = value;
          break;
        case 'controlpersist':
          currentEntry.controlPersist = value;
          break;
      }
    }
  }

  if (currentEntry && currentEntry.host) {
    entries.push(currentEntry as SshConfigEntry);
  }

  return entries;
}

/**
 * Formats an SSH config entry into the standard SSH config file format.
 * Validates all values before formatting to prevent injection attacks.
 * @param entry - The SSH config entry to format
 * @returns Formatted SSH config string
 * @throws {Error} If any value contains invalid characters
 */
export function formatSshConfigEntry(entry: SshConfigEntry): string {
  const lines: string[] = [`Host ${validateSshConfigValue('Host', entry.host)}`];

  if (entry.hostName) {
    lines.push(`  HostName ${validateSshConfigValue('HostName', entry.hostName)}`);
  }
  if (entry.user) {
    lines.push(`  User ${validateSshConfigValue('User', entry.user)}`);
  }
  if (entry.proxyCommand) {
    lines.push(`  ProxyCommand ${validateSshConfigValue('ProxyCommand', entry.proxyCommand)}`);
  }
  if (entry.identityFile) {
    lines.push(`  IdentityFile ${validateSshConfigValue('IdentityFile', entry.identityFile)}`);
  }
  if (entry.strictHostKeyChecking) {
    lines.push(
      `  StrictHostKeyChecking ${validateSshConfigValue('StrictHostKeyChecking', entry.strictHostKeyChecking)}`
    );
  }
  if (entry.userKnownHostsFile) {
    lines.push(
      `  UserKnownHostsFile ${validateSshConfigValue('UserKnownHostsFile', entry.userKnownHostsFile)}`
    );
  }
  if (entry.logLevel) {
    lines.push(`  LogLevel ${validateSshConfigValue('LogLevel', entry.logLevel)}`);
  }
  if (entry.controlMaster) {
    lines.push(`  ControlMaster ${validateSshConfigValue('ControlMaster', entry.controlMaster)}`);
  }
  if (entry.controlPath) {
    lines.push(`  ControlPath ${validateSshConfigValue('ControlPath', entry.controlPath)}`);
  }
  if (entry.controlPersist) {
    lines.push(`  ControlPersist ${validateSshConfigValue('ControlPersist', entry.controlPersist)}`);
  }

  return lines.join('\n');
}

/**
 * Updates the managed section of the SSH config file.
 * The managed section is marked with special comments and won't affect other SSH config.
 * @param newEntries - Array of SSH config entries to write
 */
export function updateManagedSection(newEntries: SshConfigEntry[]): void {
  const existingConfig = readSshConfig();

  // Remove existing managed section
  const markerStartIndex = existingConfig.indexOf(MARKER_START);
  const markerEndIndex = existingConfig.indexOf(MARKER_END);

  let beforeSection = existingConfig;
  let afterSection = '';

  if (markerStartIndex !== -1 && markerEndIndex !== -1) {
    beforeSection = existingConfig.substring(0, markerStartIndex).trimEnd();
    afterSection = existingConfig.substring(markerEndIndex + MARKER_END.length).trimStart();
  }

  // Build new managed section
  const managedSection = [
    MARKER_START,
    '# This section is managed by Open Spaces extension',
    '# Do not edit manually - changes will be overwritten',
    '',
    ...newEntries.map((entry) => formatSshConfigEntry(entry)),
    '',
    MARKER_END,
  ].join('\n');

  // Combine sections
  const parts: string[] = [];

  if (beforeSection.trim()) {
    parts.push(beforeSection);
  }

  if (newEntries.length > 0) {
    parts.push(managedSection);
  }

  if (afterSection.trim()) {
    parts.push(afterSection);
  }

  const newConfig = parts.join('\n\n') + '\n';
  writeSshConfig(newConfig);
}

/**
 * Sets the SSH config entry in the managed section.
 * Only keeps a single entry to avoid accumulating stale configs.
 * @param entry - The SSH config entry to set
 */
export function setEntry(entry: SshConfigEntry): void {
  updateManagedSection([entry]);
}

/**
 * Clears all SSH config entries from the managed section.
 */
export function clearEntries(): void {
  updateManagedSection([]);
}

/**
 * Returns the SSH host from the managed section, if any.
 * Used to verify the current SSH remote matches a codespace we connected to.
 */
export function getManagedHost(): string | undefined {
  const config = readSshConfig();
  const startIdx = config.indexOf(MARKER_START);
  const endIdx = config.indexOf(MARKER_END);
  if (startIdx === -1 || endIdx === -1) {
    return undefined;
  }
  const managed = config.substring(startIdx, endIdx);
  const match = managed.match(/Host\s+(\S+)/);
  return match ? match[1] : undefined;
}

/**
 * Checks if an SSH identity file exists.
 * @param identityFile - Path to the identity file (supports ~ expansion)
 * @returns True if the identity file exists
 */
export function identityFileExists(identityFile: string): boolean {
  // Expand ~ to home directory
  const expandedPath = identityFile.replace(/^~/, os.homedir());
  return fs.existsSync(expandedPath);
}

