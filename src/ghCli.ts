import { execFile } from 'child_process';
import { promisify } from 'util';
import * as vscode from 'vscode';
import { Codespace, CodespaceState, GhCliError, GitStatus } from './types';

const execFileAsync = promisify(execFile);

interface ExecResult {
  stdout: string;
  stderr: string;
}

interface ExecError extends Error {
  code?: string;
  stderr?: string;
}

function isExecError(error: unknown): error is ExecError {
  return error instanceof Error && ('code' in error || 'stderr' in error);
}

/**
 * Validates that a codespace name is in the correct format.
 * @param name - The codespace name to validate
 * @throws {GhCliError} If the name is invalid
 */
function validateCodespaceName(name: string): void {
  if (!name || typeof name !== 'string') {
    throw new GhCliError('COMMAND_FAILED', 'Invalid codespace name');
  }
  // Codespace names should be alphanumeric with hyphens
  if (!/^[a-zA-Z0-9][-a-zA-Z0-9]*$/.test(name)) {
    throw new GhCliError('COMMAND_FAILED', `Invalid codespace name format: ${name}`);
  }
}

interface CodespaceResponse {
  name: string;
  displayName?: string;
  state: string;
  repository?: string;
  owner?: { login?: string };
  gitStatus?: {
    ref?: string;
    ahead?: number;
    behind?: number;
    hasUncommittedChanges?: boolean;
    hasUnpushedChanges?: boolean;
  };
  lastUsedAt?: string;
  createdAt?: string;
  machineName?: string;
}

function isCodespaceResponse(data: unknown): data is CodespaceResponse[] {
  return (
    Array.isArray(data) &&
    data.every((item): item is CodespaceResponse => {
      if (typeof item !== 'object' || item === null) {
        return false;
      }
      const obj = item as Record<string, unknown>;
      return (
        'name' in obj &&
        typeof obj.name === 'string' &&
        'state' in obj &&
        typeof obj.state === 'string'
      );
    })
  );
}

async function runGh(args: string[], timeout = 30000): Promise<ExecResult> {
  try {
    const result = await execFileAsync('gh', args, {
      timeout,
      maxBuffer: 10 * 1024 * 1024,
    });
    return { stdout: result.stdout, stderr: result.stderr };
  } catch (error: unknown) {
    if (isExecError(error) && error.code === 'ENOENT') {
      throw new GhCliError('NOT_INSTALLED', 'GitHub CLI (gh) is not installed');
    }
    throw error;
  }
}

/**
 * Checks if the GitHub CLI (gh) is installed.
 * @returns True if gh CLI is installed, false otherwise
 */
export async function checkInstalled(): Promise<boolean> {
  try {
    await runGh(['--version']);
    return true;
  } catch (error) {
    if (error instanceof GhCliError && error.type === 'NOT_INSTALLED') {
      return false;
    }
    throw error;
  }
}

/**
 * Checks if the user is authenticated with GitHub CLI.
 * @returns Object indicating authentication status and any error
 */
export async function checkAuth(): Promise<{ authenticated: boolean; error?: GhCliError }> {
  try {
    await runGh(['auth', 'status']);
    return { authenticated: true };
  } catch (error: unknown) {
    const stderr = isExecError(error)
      ? error.stderr || error.message || ''
      : error instanceof Error
        ? error.message
        : '';

    if (stderr.includes('not logged in')) {
      return {
        authenticated: false,
        error: new GhCliError('NOT_AUTHENTICATED', 'Not authenticated with GitHub CLI', stderr),
      };
    }

    if (stderr.includes('codespace') && stderr.includes('scope')) {
      return {
        authenticated: false,
        error: new GhCliError('SCOPE_REQUIRED', 'Codespace scope required', stderr),
      };
    }

    // If gh auth status exits non-zero but stderr doesn't indicate auth failure,
    // it might still be authenticated
    if (stderr.includes('Logged in to')) {
      return { authenticated: true };
    }

    return {
      authenticated: false,
      error: new GhCliError('NOT_AUTHENTICATED', 'Authentication check failed', stderr),
    };
  }
}

/**
 * Lists all codespaces for the authenticated user.
 * @returns Array of Codespace objects
 * @throws {GhCliError} If gh CLI is not installed or user not authenticated
 */
export async function listCodespaces(): Promise<Codespace[]> {
  const result = await runGh([
    'codespace',
    'list',
    '--json',
    'name,displayName,state,repository,owner,gitStatus,lastUsedAt,createdAt,machineName',
  ]);

  try {
    const data: unknown = JSON.parse(result.stdout);
    if (!isCodespaceResponse(data)) {
      throw new GhCliError('PARSE_ERROR', 'Invalid codespace list response structure');
    }
    return data.map((cs) => {
      const gitStatusRaw = cs.gitStatus;
      const gitStatus: GitStatus = {
        ref: gitStatusRaw?.ref || '',
        ahead: gitStatusRaw?.ahead || 0,
        behind: gitStatusRaw?.behind || 0,
        hasUncommittedChanges: gitStatusRaw?.hasUncommittedChanges || false,
        hasUnpushedChanges: gitStatusRaw?.hasUnpushedChanges || false,
      };
      return {
        name: cs.name,
        displayName: cs.displayName || cs.name,
        state: cs.state as CodespaceState,
        repository: cs.repository || '',
        owner: cs.owner?.login || '',
        branch: gitStatus.ref,
        lastUsedAt: cs.lastUsedAt || '',
        createdAt: cs.createdAt || '',
        machineName: cs.machineName || '',
        gitStatus,
      };
    });
  } catch (error) {
    if (error instanceof GhCliError) {
      throw error;
    }
    throw new GhCliError('PARSE_ERROR', 'Failed to parse codespace list output');
  }
}

/**
 * Gets the SSH configuration for a codespace from gh CLI.
 * @param codespaceName - The name of the codespace
 * @returns SSH config output string
 * @throws {GhCliError} If the codespace name is invalid or command fails
 */
export async function getSshConfig(codespaceName: string): Promise<string> {
  validateCodespaceName(codespaceName);
  const result = await runGh(['codespace', 'ssh', '--config', '-c', codespaceName], 60000);
  return result.stdout;
}

/**
 * Ensures SSH keys are generated for connecting to a codespace.
 * @param codespaceName - The name of the codespace
 * @param log - Optional logging function for error reporting
 */
export async function ensureSshKeys(
  codespaceName: string,
  log?: (message: string, error?: Error) => void
): Promise<void> {
  validateCodespaceName(codespaceName);
  // Running ssh with 'exit' command triggers key generation if needed
  try {
    await runGh(['codespace', 'ssh', '-c', codespaceName, '--', 'exit'], 120000);
  } catch (error) {
    // Log but don't throw - key generation may still succeed
    // The command may exit with non-zero if the codespace isn't ready,
    // but the keys should still be generated. We'll verify the identity file separately.
    if (log) {
      log(
        'SSH key setup command returned non-zero (keys may still be generated)',
        error instanceof Error ? error : undefined
      );
    }
  }
}

/**
 * Starts a codespace.
 * @param codespaceName - The name of the codespace to start
 * @throws {GhCliError} If the codespace name is invalid or command fails
 */
export async function startCodespace(codespaceName: string): Promise<void> {
  validateCodespaceName(codespaceName);
  await runGh(['api', '-X', 'POST', `/user/codespaces/${codespaceName}/start`], 60000);
}

/**
 * Stops a codespace.
 * @param codespaceName - The name of the codespace to stop
 * @throws {GhCliError} If the codespace name is invalid or command fails
 */
export async function stopCodespace(codespaceName: string): Promise<void> {
  validateCodespaceName(codespaceName);
  await runGh(['api', '-X', 'POST', `/user/codespaces/${codespaceName}/stop`], 60000);
}

/**
 * Rebuilds a codespace container.
 * @param codespaceName - The name of the codespace to rebuild
 * @param full - Whether to do a full rebuild (without cache)
 * @throws {GhCliError} If the codespace name is invalid or command fails
 */
export async function rebuildCodespace(codespaceName: string, full = false): Promise<void> {
  validateCodespaceName(codespaceName);
  const args = ['codespace', 'rebuild', '-c', codespaceName];
  if (full) {
    args.push('--full');
  }
  // Rebuild can take a while to initiate
  await runGh(args, 120000);
}

/**
 * Gets a specific codespace by name.
 * @param codespaceName - The name of the codespace to retrieve
 * @returns The Codespace object or null if not found
 * @throws {GhCliError} If the codespace name is invalid or there's a network/parse error
 */
export async function getCodespace(codespaceName: string): Promise<Codespace | null> {
  validateCodespaceName(codespaceName);
  const result = await runGh([
    'codespace',
    'list',
    '--json',
    'name,displayName,state,repository,owner,gitStatus,lastUsedAt,createdAt,machineName',
  ]);

  let data: unknown;
  try {
    data = JSON.parse(result.stdout);
  } catch {
    throw new GhCliError('PARSE_ERROR', 'Failed to parse codespace data');
  }

  if (!isCodespaceResponse(data)) {
    throw new GhCliError('PARSE_ERROR', 'Invalid codespace response structure');
  }

  const cs = data.find((c) => c.name === codespaceName);

  if (!cs) {
    return null;
  }

  const gitStatusRaw = cs.gitStatus;
  const gitStatus: GitStatus = {
    ref: gitStatusRaw?.ref || '',
    ahead: gitStatusRaw?.ahead || 0,
    behind: gitStatusRaw?.behind || 0,
    hasUncommittedChanges: gitStatusRaw?.hasUncommittedChanges || false,
    hasUnpushedChanges: gitStatusRaw?.hasUnpushedChanges || false,
  };

  return {
    name: cs.name,
    displayName: cs.displayName || cs.name,
    state: cs.state as CodespaceState,
    repository: cs.repository || '',
    owner: cs.owner?.login || '',
    branch: gitStatus.ref,
    lastUsedAt: cs.lastUsedAt || '',
    createdAt: cs.createdAt || '',
    machineName: cs.machineName || '',
    gitStatus,
  };
}

/**
 * Deletes a codespace.
 * @param codespaceName - The name of the codespace to delete
 * @throws {GhCliError} If the codespace name is invalid or command fails
 */
export async function deleteCodespace(codespaceName: string): Promise<void> {
  validateCodespaceName(codespaceName);
  await runGh(['api', '-X', 'DELETE', `/user/codespaces/${codespaceName}`], 60000);
}

/**
 * Waits for a codespace to reach a target state.
 * @param codespaceName - The name of the codespace
 * @param targetState - The state to wait for
 * @param timeoutMs - Maximum time to wait in milliseconds (default: 300000)
 * @param pollIntervalMs - Interval between state checks in milliseconds (default: 3000)
 * @param token - Optional cancellation token to abort the operation
 * @returns The Codespace object once it reaches the target state
 * @throws {GhCliError} If timeout, cancellation, or codespace enters failed state
 */
export async function waitForState(
  codespaceName: string,
  targetState: CodespaceState,
  timeoutMs = 300000,
  pollIntervalMs = 3000,
  token?: vscode.CancellationToken
): Promise<Codespace> {
  validateCodespaceName(codespaceName);
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    if (token?.isCancellationRequested) {
      throw new GhCliError('COMMAND_FAILED', 'Operation cancelled');
    }

    const codespace = await getCodespace(codespaceName);

    if (!codespace) {
      throw new GhCliError('COMMAND_FAILED', `Codespace ${codespaceName} not found`);
    }

    if (codespace.state === targetState) {
      return codespace;
    }

    if (codespace.state === 'Failed') {
      throw new GhCliError('COMMAND_FAILED', `Codespace ${codespaceName} is in failed state`);
    }

    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  throw new GhCliError(
    'COMMAND_FAILED',
    `Timeout waiting for codespace ${codespaceName} to reach state ${targetState}`
  );
}
