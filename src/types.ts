export type CodespaceState =
  | 'Available'
  | 'Shutdown'
  | 'Starting'
  | 'ShuttingDown'
  | 'Provisioning'
  | 'Rebuilding'
  | 'Awaiting'
  | 'Unavailable'
  | 'Deleted'
  | 'Moved'
  | 'Exporting'
  | 'Updating'
  | 'Failed';

export interface GitStatus {
  ref: string;
  ahead: number;
  behind: number;
  hasUncommittedChanges: boolean;
  hasUnpushedChanges: boolean;
}

export interface MachineInfo {
  cpus: number;
  memoryInBytes: number;
  storageInBytes: number;
  displayName: string;
}

export interface Codespace {
  name: string;
  displayName: string;
  state: CodespaceState;
  repository: string;
  owner: string;
  branch: string;
  lastUsedAt: string;
  createdAt: string;
  machineName: string;
  gitStatus: GitStatus;
  idleTimeoutMinutes?: number;
  machineInfo?: MachineInfo;
}

export type GhCliErrorType =
  | 'NOT_INSTALLED'
  | 'NOT_AUTHENTICATED'
  | 'SCOPE_REQUIRED'
  | 'COMMAND_FAILED'
  | 'PARSE_ERROR';

export class GhCliError extends Error {
  constructor(
    public readonly type: GhCliErrorType,
    message: string,
    public readonly stderr?: string
  ) {
    super(message);
    this.name = 'GhCliError';
  }
}

export interface SshConfigEntry {
  host: string;
  hostName: string;
  user: string;
  proxyCommand?: string;
  identityFile?: string;
  strictHostKeyChecking?: string;
  userKnownHostsFile?: string;
  logLevel?: string;
  controlMaster?: string;
  controlPath?: string;
  controlPersist?: string;
}

export interface CodespaceListResult {
  codespaces: Codespace[];
  error?: GhCliError;
}
