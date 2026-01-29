import * as vscode from 'vscode';
import * as ghCli from './ghCli';
import * as sshConfigManager from './sshConfigManager';
import { Codespace, GhCliError } from './types';

export interface PrerequisiteResult {
  ready: boolean;
  ghInstalled: boolean;
  authenticated: boolean;
  error?: GhCliError;
}

/**
 * Checks if all prerequisites for using codespaces are met.
 * @returns Result indicating if gh CLI is installed and user is authenticated
 */
export async function checkPrerequisites(): Promise<PrerequisiteResult> {
  // Check if gh is installed
  const installed = await ghCli.checkInstalled();
  if (!installed) {
    return {
      ready: false,
      ghInstalled: false,
      authenticated: false,
      error: new GhCliError('NOT_INSTALLED', 'GitHub CLI (gh) is not installed'),
    };
  }

  // Check if authenticated
  const authResult = await ghCli.checkAuth();
  if (!authResult.authenticated) {
    return {
      ready: false,
      ghInstalled: true,
      authenticated: false,
      error: authResult.error,
    };
  }

  return {
    ready: true,
    ghInstalled: true,
    authenticated: true,
  };
}

/**
 * Connects to a codespace by configuring SSH and opening the remote folder.
 * If the codespace is shutdown, it will be started first.
 * @param codespace - The codespace to connect to
 * @throws {Error} If connection fails or codespace has no repository
 */
export async function connect(codespace: Codespace): Promise<void> {
  // If codespace is shutdown, start it first
  if (codespace.state === 'Shutdown') {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Starting codespace ${codespace.displayName}...`,
        cancellable: false,
      },
      async () => {
        await ghCli.startCodespace(codespace.name);
        await ghCli.waitForState(codespace.name, 'Available');
      }
    );
  }

  // Get SSH config from gh CLI
  const sshConfigOutput = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Getting SSH configuration for ${codespace.displayName}...`,
      cancellable: false,
    },
    async () => {
      return await ghCli.getSshConfig(codespace.name);
    }
  );

  // Parse the SSH config
  const entries = sshConfigManager.parseSshConfigOutput(sshConfigOutput);

  if (entries.length === 0) {
    throw new Error('Failed to get SSH configuration from GitHub CLI');
  }

  const entry = entries[0];

  // Check if identity file exists, if not trigger key generation
  if (entry.identityFile && !sshConfigManager.identityFileExists(entry.identityFile)) {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Setting up SSH keys for ${codespace.displayName}...`,
        cancellable: false,
      },
      async () => {
        await ghCli.ensureSshKeys(codespace.name);
      }
    );
  }

  // Write to SSH config
  sshConfigManager.addOrUpdateEntry(entry);

  // Refresh open-remote-ssh if available
  await vscode.commands.executeCommand('remote-ssh.refreshHosts').then(
    () => {},
    () => {} // Ignore if command doesn't exist
  );

  // Build the remote URI
  // Format: vscode-remote://ssh-remote+hostname/path
  const repoName = codespace.repository.split('/').pop();
  if (!repoName) {
    throw new Error('Codespace has no associated repository');
  }
  const remotePath = `/workspaces/${repoName}`;
  const remoteUri = vscode.Uri.parse(`vscode-remote://ssh-remote+${entry.host}${remotePath}`);

  // Open the remote folder
  await vscode.commands.executeCommand('vscode.openFolder', remoteUri, {
    forceNewWindow: false,
  });
}

/**
 * Starts a codespace.
 * @param codespace - The codespace to start
 */
export async function start(codespace: Codespace): Promise<void> {
  if (codespace.state !== 'Shutdown') {
    void vscode.window.showInformationMessage(`Codespace ${codespace.displayName} is already running`);
    return;
  }

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Starting codespace ${codespace.displayName}...`,
      cancellable: false,
    },
    async () => {
      await ghCli.startCodespace(codespace.name);
      await ghCli.waitForState(codespace.name, 'Available');
    }
  );

  void vscode.window.showInformationMessage(`Codespace ${codespace.displayName} started`);
}

/**
 * Stops a running codespace.
 * @param codespace - The codespace to stop
 */
export async function stop(codespace: Codespace): Promise<void> {
  if (codespace.state !== 'Available') {
    void vscode.window.showInformationMessage(`Codespace ${codespace.displayName} is not running`);
    return;
  }

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Stopping codespace ${codespace.displayName}...`,
      cancellable: false,
    },
    async () => {
      await ghCli.stopCodespace(codespace.name);
      await ghCli.waitForState(codespace.name, 'Shutdown');
    }
  );

  void vscode.window.showInformationMessage(`Codespace ${codespace.displayName} stopped`);
}

/**
 * Opens a terminal with the gh auth login command pre-filled.
 */
export function openAuthTerminal(): void {
  const terminal = vscode.window.createTerminal({
    name: 'GitHub CLI Auth',
  });
  terminal.show();
  terminal.sendText('gh auth login --scopes codespace');
}

/**
 * Rebuilds a codespace container.
 * @param codespace - The codespace to rebuild
 * @param full - Whether to do a full rebuild without cache
 */
export async function rebuild(codespace: Codespace, full = false): Promise<void> {
  const fullText = full ? ' (full)' : '';
  const confirmMessage = full
    ? `Are you sure you want to fully rebuild ${codespace.displayName}? This will rebuild without cache and may take longer.`
    : `Are you sure you want to rebuild ${codespace.displayName}?`;

  const confirmed = await vscode.window.showWarningMessage(
    confirmMessage,
    { modal: true },
    'Rebuild'
  );

  if (confirmed !== 'Rebuild') {
    return;
  }

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Rebuilding codespace${fullText} ${codespace.displayName}...`,
      cancellable: false,
    },
    async () => {
      await ghCli.rebuildCodespace(codespace.name, full);
    }
  );

  void vscode.window.showInformationMessage(
    `Codespace ${codespace.displayName} rebuild initiated. It will be available once the rebuild completes.`
  );
}
