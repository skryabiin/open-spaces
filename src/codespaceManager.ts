import * as vscode from 'vscode';
import * as ghCli from './ghCli';
import * as sshConfigManager from './sshConfigManager';
import { Codespace, GhCliError } from './types';
import { log } from './extension';
import { isTransitionalState } from './constants';
import { formatBytes } from './utils/formatting';

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
      error: new GhCliError('NOT_INSTALLED', vscode.l10n.t('GitHub CLI (gh) is not installed')),
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
 * Ensures a codespace is available (running). Starts it if needed.
 * @param codespace - The codespace to ensure is available
 * @returns The fresh codespace state
 * @throws {Error} If the codespace no longer exists or is in a failed state
 */
async function ensureCodespaceAvailable(codespace: Codespace): Promise<Codespace> {
  const freshCodespace = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: vscode.l10n.t('Checking codespace status...'),
      cancellable: false,
    },
    async () => {
      return await ghCli.getCodespace(codespace.name);
    }
  );

  if (!freshCodespace) {
    throw new Error(vscode.l10n.t('Codespace {0} no longer exists', codespace.displayName));
  }

  if (freshCodespace.state === 'Failed') {
    throw new Error(vscode.l10n.t('Codespace {0} is in a failed state. Please rebuild it.', codespace.displayName));
  }

  if (freshCodespace.state !== 'Available') {
    const isTransitional = isTransitionalState(freshCodespace.state);

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: isTransitional
          ? vscode.l10n.t('Waiting for codespace {0}...', codespace.displayName)
          : vscode.l10n.t('Starting codespace {0}...', codespace.displayName),
        cancellable: false,
      },
      async () => {
        if (freshCodespace.state === 'Shutdown') {
          await ghCli.startCodespace(codespace.name);
        }
        await ghCli.waitForState(codespace.name, 'Available');
      }
    );
  }

  return freshCodespace;
}

/**
 * Connects to a codespace by configuring SSH and opening the remote folder.
 * If the codespace is shutdown, it will be started first.
 * @param codespace - The codespace to connect to
 * @throws {Error} If connection fails or codespace has no repository
 */
export async function connect(codespace: Codespace): Promise<void> {
  await ensureCodespaceAvailable(codespace);

  // Get SSH config from gh CLI
  const sshConfigOutput = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: vscode.l10n.t('Getting SSH configuration for {0}...', codespace.displayName),
      cancellable: false,
    },
    async () => {
      return await ghCli.getSshConfig(codespace.name);
    }
  );

  // Parse the SSH config
  const entries = sshConfigManager.parseSshConfigOutput(sshConfigOutput);

  if (entries.length === 0) {
    throw new Error(vscode.l10n.t('Failed to get SSH configuration from GitHub CLI'));
  }

  const entry = entries[0];

  // Check if identity file exists, if not trigger key generation
  if (entry.identityFile && !sshConfigManager.identityFileExists(entry.identityFile)) {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: vscode.l10n.t('Setting up SSH keys for {0}...', codespace.displayName),
        cancellable: false,
      },
      async () => {
        await ghCli.ensureSshKeys(codespace.name);
      }
    );
  }

  // Write to SSH config
  sshConfigManager.setEntry(entry);

  // Refresh open-remote-ssh if available
  await vscode.commands.executeCommand('remote-ssh.refreshHosts').then(
    () => {},
    () => {} // Ignore if command doesn't exist
  );

  // Build the remote URI
  // Format: vscode-remote://ssh-remote+hostname/path
  const repoName = codespace.repository.split('/').pop();
  if (!repoName) {
    throw new Error(vscode.l10n.t('Codespace has no associated repository'));
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
    void vscode.window.showInformationMessage(vscode.l10n.t('Codespace {0} is already running', codespace.displayName));
    return;
  }

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: vscode.l10n.t('Starting codespace {0}...', codespace.displayName),
      cancellable: false,
    },
    async () => {
      await ghCli.startCodespace(codespace.name);
      await ghCli.waitForState(codespace.name, 'Available');
    }
  );

  void vscode.window.showInformationMessage(vscode.l10n.t('Codespace {0} started', codespace.displayName));
}

/**
 * Stops a running codespace.
 * @param codespace - The codespace to stop
 */
export async function stop(codespace: Codespace): Promise<void> {
  if (codespace.state !== 'Available') {
    void vscode.window.showInformationMessage(vscode.l10n.t('Codespace {0} is not running', codespace.displayName));
    return;
  }

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: vscode.l10n.t('Stopping codespace {0}...', codespace.displayName),
      cancellable: false,
    },
    async () => {
      await ghCli.stopCodespace(codespace.name);
      await ghCli.waitForState(codespace.name, 'Shutdown');
    }
  );

  void vscode.window.showInformationMessage(vscode.l10n.t('Codespace {0} stopped', codespace.displayName));
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
 * Opens a terminal session connected to a codespace via SSH.
 * If the codespace is shutdown, it will be started first.
 * @param codespace - The codespace to connect to
 */
export async function openSshTerminal(codespace: Codespace): Promise<void> {
  await ensureCodespaceAvailable(codespace);

  // Create terminal with SSH connection
  const terminal = vscode.window.createTerminal({
    name: `SSH: ${codespace.displayName}`,
  });
  terminal.show();
  terminal.sendText(`gh codespace ssh -c ${codespace.name}`);
}

/**
 * Rebuilds a codespace container.
 * @param codespace - The codespace to rebuild
 * @param full - Whether to do a full rebuild without cache
 */
export async function rebuild(codespace: Codespace, full = false): Promise<void> {
  const fullText = full ? vscode.l10n.t(' (full)') : '';
  const confirmMessage = full
    ? vscode.l10n.t('Are you sure you want to fully rebuild {0}? This will rebuild without cache and may take longer.', codespace.displayName)
    : vscode.l10n.t('Are you sure you want to rebuild {0}?', codespace.displayName);

  const confirmed = await vscode.window.showWarningMessage(
    confirmMessage,
    { modal: true },
    vscode.l10n.t('Rebuild')
  );

  if (confirmed !== vscode.l10n.t('Rebuild')) {
    return;
  }

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: vscode.l10n.t('Rebuilding codespace{0} {1}...', fullText, codespace.displayName),
      cancellable: false,
    },
    async () => {
      await ghCli.rebuildCodespace(codespace.name, full);
    }
  );

  void vscode.window.showInformationMessage(
    vscode.l10n.t('Codespace {0} rebuild initiated. It will be available once the rebuild completes.', codespace.displayName)
  );
}

/**
 * Deletes a codespace.
 * @param codespace - The codespace to delete
 */
export async function deleteCodespace(codespace: Codespace): Promise<void> {
  const confirmed = await vscode.window.showWarningMessage(
    vscode.l10n.t('Are you sure you want to delete {0}? This action cannot be undone and any unsaved changes will be lost.', codespace.displayName),
    { modal: true },
    vscode.l10n.t('Delete')
  );

  if (confirmed !== vscode.l10n.t('Delete')) {
    return;
  }

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: vscode.l10n.t('Deleting codespace {0}...', codespace.displayName),
      cancellable: false,
    },
    async () => {
      await ghCli.deleteCodespace(codespace.name);
    }
  );

  void vscode.window.showInformationMessage(vscode.l10n.t('Codespace {0} deleted', codespace.displayName));
}

/**
 * Creates a new codespace with an interactive UI flow.
 * @returns The name of the created codespace, or undefined if cancelled
 */
export async function createCodespace(): Promise<string | undefined> {
  // Step 1: Select repository
  const repos = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: vscode.l10n.t('Loading repositories (this may take a moment)...'),
      cancellable: false,
    },
    async () => {
      return await ghCli.listRepositories();
    }
  );

  const repoItems: vscode.QuickPickItem[] = repos.map((repo) => ({
    label: repo.nameWithOwner,
    description: repo.isPrivate ? vscode.l10n.t('$(lock) Private') : vscode.l10n.t('$(globe) Public'),
    detail: repo.description || undefined,
  }));

  // Add option to enter repository manually
  repoItems.push({
    label: vscode.l10n.t('$(edit) Enter repository manually...'),
    description: '',
    detail: vscode.l10n.t('Type owner/repo to use a repository not in the list'),
    alwaysShow: true,
  });

  const selectedRepo = await vscode.window.showQuickPick(repoItems, {
    placeHolder: vscode.l10n.t('Select a repository or enter manually'),
    title: vscode.l10n.t('Create Codespace - Select Repository'),
  });

  if (!selectedRepo) {
    return undefined;
  }

  let repo: string;
  if (selectedRepo.label === vscode.l10n.t('$(edit) Enter repository manually...')) {
    const manualRepo = await vscode.window.showInputBox({
      prompt: vscode.l10n.t('Enter the repository (owner/repo)'),
      placeHolder: 'owner/repo',
      title: vscode.l10n.t('Create Codespace - Enter Repository'),
      validateInput: (value) => {
        if (!value || !value.includes('/')) {
          return vscode.l10n.t('Please enter in format: owner/repo');
        }
        return undefined;
      },
    });

    if (!manualRepo) {
      return undefined;
    }
    repo = manualRepo;
  } else {
    repo = selectedRepo.label;
  }

  // Step 2: Select branch
  let branches: ghCli.Branch[] = [];
  try {
    branches = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: vscode.l10n.t('Loading branches...'),
        cancellable: false,
      },
      async () => {
        return await ghCli.listBranches(repo);
      }
    );
  } catch (error) {
    log('Failed to load branches, using default', error instanceof Error ? error : undefined);
  }

  let selectedBranch: string | undefined;
  if (branches.length > 0) {
    const branchItems: vscode.QuickPickItem[] = [
      { label: vscode.l10n.t('$(git-branch) Default branch'), description: vscode.l10n.t('Use the repository default branch') },
      ...branches.map((branch) => ({
        label: branch.name,
        description: '',
      })),
    ];

    const branchSelection = await vscode.window.showQuickPick(branchItems, {
      placeHolder: vscode.l10n.t('Select a branch'),
      title: vscode.l10n.t('Create Codespace - Select Branch'),
    });

    if (!branchSelection) {
      return undefined;
    }

    if (!branchSelection.label.startsWith('$(git-branch)')) {
      selectedBranch = branchSelection.label;
    }
  }

  // Step 3: Select machine type
  let machineTypes: ghCli.MachineType[] = [];
  try {
    machineTypes = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: vscode.l10n.t('Loading machine types...'),
        cancellable: false,
      },
      async () => {
        return await ghCli.listMachineTypes(repo, selectedBranch);
      }
    );
  } catch (error) {
    log('Failed to load machine types, using default', error instanceof Error ? error : undefined);
  }

  let selectedMachine: string | undefined;
  if (machineTypes.length > 0) {
    const machineItems: vscode.QuickPickItem[] = [
      { label: vscode.l10n.t('$(server) Default'), description: vscode.l10n.t('Use the repository default machine type') },
      ...machineTypes.map((machine) => ({
        label: machine.displayName,
        description: vscode.l10n.t('{0} cores, {1} RAM, {2} storage', machine.cpus, formatBytes(machine.memoryInBytes), formatBytes(machine.storageInBytes)),
        detail: machine.name,
      })),
    ];

    const machineSelection = await vscode.window.showQuickPick(machineItems, {
      placeHolder: vscode.l10n.t('Select a machine type'),
      title: vscode.l10n.t('Create Codespace - Select Machine Type'),
    });

    if (!machineSelection) {
      return undefined;
    }

    if (!machineSelection.label.startsWith('$(server)')) {
      selectedMachine = machineSelection.detail;
    }
  }

  // Step 4: Optional display name
  const displayName = await vscode.window.showInputBox({
    prompt: vscode.l10n.t('Enter a display name for the codespace (optional)'),
    placeHolder: 'my-codespace',
    title: vscode.l10n.t('Create Codespace - Display Name'),
  });

  // User pressed Escape on optional field - continue with creation
  // (showInputBox returns undefined for Escape, empty string for Enter with no input)

  // Create the codespace
  const codespaceName = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: vscode.l10n.t('Creating codespace for {0}...', repo),
      cancellable: false,
    },
    async () => {
      return await ghCli.createCodespace({
        repo,
        branch: selectedBranch,
        machineType: selectedMachine,
        displayName: displayName || undefined,
      });
    }
  );

  void vscode.window.showInformationMessage(vscode.l10n.t('Codespace created: {0}', codespaceName));
  return codespaceName;
}
