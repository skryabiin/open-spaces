import * as vscode from 'vscode';
import * as ghCli from './ghCli';
import * as sshConfigManager from './sshConfigManager';
import { Codespace, GhCliError } from './types';
import { log } from './extension';
import { isTransitionalState } from './constants';
import { formatBytes } from './utils/formatting';
import { getHourlyPrice, formatPrice } from './utils/pricing';
import { getTemplates, saveTemplate, CodespaceTemplate } from './templateManager';

export interface PrerequisiteResult {
  ready: boolean;
  ghInstalled: boolean;
  authenticated: boolean;
  hasCodespaceScope: boolean;
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
      hasCodespaceScope: false,
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
      hasCodespaceScope: false,
      error: authResult.error,
    };
  }

  // Check if codespace scope is present
  if (!authResult.hasCodespaceScope) {
    return {
      ready: false,
      ghInstalled: true,
      authenticated: true,
      hasCodespaceScope: false,
      error: authResult.error,
    };
  }

  return {
    ready: true,
    ghInstalled: true,
    authenticated: true,
    hasCodespaceScope: true,
  };
}

/**
 * Polls briefly until the codespace state changes from its original state.
 * Used to ensure the UI can reflect transitional states.
 */
async function waitForStateChange(
  codespaceName: string,
  originalState: string,
  maxWaitMs = 10000,
  pollIntervalMs = 500
): Promise<void> {
  const startTime = Date.now();
  while (Date.now() - startTime < maxWaitMs) {
    const current = await ghCli.getCodespace(codespaceName);
    if (current && current.state !== originalState) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
}

/**
 * Triggers a refresh of the codespaces tree view.
 */
function triggerRefresh(): void {
  void vscode.commands.executeCommand('openSpaces.refresh');
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
          // Wait for transitional state and refresh UI to show 'Starting'
          await waitForStateChange(codespace.name, 'Shutdown');
          triggerRefresh();
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

  // Probe SSH readiness before handing off to remote-ssh
  const probeConfig = vscode.workspace.getConfiguration('openSpaces');
  const sshProbeRetries = probeConfig.get<number>('sshProbeRetries', 3);
  const sshProbeDelay = probeConfig.get<number>('sshProbeDelay', 3000);
  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: vscode.l10n.t('Verifying SSH connection to {0}...', codespace.displayName),
      cancellable: false,
    },
    async () => {
      await ghCli.waitForSshReady(codespace.name, sshProbeRetries, sshProbeDelay, log);
    }
  );

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
      // Wait for transitional state and refresh UI to show 'Starting'
      await waitForStateChange(codespace.name, 'Shutdown');
      triggerRefresh();
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
      // Wait for transitional state and refresh UI to show 'ShuttingDown'
      await waitForStateChange(codespace.name, 'Available');
      triggerRefresh();
      await ghCli.waitForState(codespace.name, 'Shutdown');
    }
  );

  void vscode.window.showInformationMessage(vscode.l10n.t('Codespace {0} stopped', codespace.displayName));
}

/**
 * Opens a terminal with the gh auth login command pre-filled.
 * @returns The created terminal
 */
export function openAuthTerminal(): vscode.Terminal {
  const terminal = vscode.window.createTerminal({
    name: 'GitHub CLI Auth',
  });
  terminal.show();
  terminal.sendText('gh auth login --scopes codespace');
  return terminal;
}

/**
 * Opens a terminal to add the codespace scope to an existing auth token.
 * @returns The created terminal
 */
export function openScopeRefreshTerminal(): vscode.Terminal {
  const terminal = vscode.window.createTerminal({
    name: 'Add Codespace Scope',
  });
  terminal.show();
  terminal.sendText('gh auth refresh --scopes codespace');
  return terminal;
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
      const originalState = codespace.state;
      await ghCli.rebuildCodespace(codespace.name, full);
      // Wait for transitional state so the UI can reflect the change
      await waitForStateChange(codespace.name, originalState);
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
  // Step 0: Check for templates
  const templates = getTemplates();
  let selectedTemplate: CodespaceTemplate | undefined;

  if (templates.length > 0) {
    const templateItems: vscode.QuickPickItem[] = [
      {
        label: vscode.l10n.t('$(add) Create from scratch'),
        description: vscode.l10n.t('Configure all options manually'),
      },
      ...templates.map((t) => ({
        label: t.name,
        description: t.repo,
        detail: [
          t.branch ? vscode.l10n.t('Branch: {0}', t.branch) : '',
          t.machineType || '',
        ]
          .filter(Boolean)
          .join(' • '),
      })),
    ];

    const templateSelection = await vscode.window.showQuickPick(templateItems, {
      placeHolder: vscode.l10n.t('Select a template or create from scratch'),
      title: vscode.l10n.t('Create Codespace'),
    });

    if (!templateSelection) {
      return undefined;
    }

    if (!templateSelection.label.startsWith('$(add)')) {
      selectedTemplate = templates.find((t) => t.name === templateSelection.label);
    }
  }

  const config = vscode.workspace.getConfiguration('openSpaces');
  const defaultMachineType = config.get<string>('defaultMachineType', '');
  const defaultIdleTimeout = config.get<number>('defaultIdleTimeout', 0);

  // Step 1: Select repository (skip if template provides one)
  let repo: string;
  if (selectedTemplate?.repo) {
    repo = selectedTemplate.repo;
  } else {
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

    const repoItems: vscode.QuickPickItem[] = repos.map((r) => ({
      label: r.nameWithOwner,
      description: r.isPrivate ? vscode.l10n.t('$(lock) Private') : vscode.l10n.t('$(globe) Public'),
      detail: r.description || undefined,
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
  }

  // Step 2: Select branch (skip if template provides one)
  let selectedBranch: string | undefined = selectedTemplate?.branch;
  if (!selectedBranch) {
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
  }

  // Step 3: Select machine type
  let selectedMachine: string | undefined = selectedTemplate?.machineType;
  if (!selectedMachine) {
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

    if (machineTypes.length > 0) {
      const machineItems: vscode.QuickPickItem[] = [
        { label: vscode.l10n.t('$(server) Default'), description: vscode.l10n.t('Use the repository default machine type') },
        ...machineTypes.map((machine) => {
          const price = getHourlyPrice(machine.cpus);
          const costStr = price !== null ? ` • ${formatPrice(price)}` : '';
          return {
            label: machine.displayName,
            description: vscode.l10n.t('{0} cores, {1} RAM, {2} storage', machine.cpus, formatBytes(machine.memoryInBytes), formatBytes(machine.storageInBytes)) + costStr,
            detail: machine.name,
            picked: defaultMachineType ? machine.name === defaultMachineType : false,
          };
        }),
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
  }

  // Step 4: Optional display name
  const displayName = await vscode.window.showInputBox({
    prompt: vscode.l10n.t('Enter a display name for the codespace'),
    placeHolder: selectedTemplate?.displayName || vscode.l10n.t('Generated if left blank'),
    title: vscode.l10n.t('Create Codespace - Display Name'),
    value: selectedTemplate?.displayName || '',
  });

  // User pressed Escape on optional field - continue with creation
  // (showInputBox returns undefined for Escape, empty string for Enter with no input)

  // Determine idle timeout
  const idleTimeout = selectedTemplate?.idleTimeoutMinutes || defaultIdleTimeout || undefined;

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
        idleTimeoutMinutes: idleTimeout,
      });
    }
  );

  void vscode.window.showInformationMessage(vscode.l10n.t('Codespace created: {0}', codespaceName));

  // Offer to save as template if not already using one
  if (!selectedTemplate) {
    const saveAsTemplate = await vscode.window.showInformationMessage(
      vscode.l10n.t('Save this configuration as a template?'),
      vscode.l10n.t('Save Template'),
      vscode.l10n.t('No')
    );

    if (saveAsTemplate === vscode.l10n.t('Save Template')) {
      const templateName = await vscode.window.showInputBox({
        prompt: vscode.l10n.t('Enter a name for the template'),
        placeHolder: vscode.l10n.t('My Template'),
        title: vscode.l10n.t('Save Template'),
      });

      if (templateName) {
        await saveTemplate({
          name: templateName,
          repo,
          branch: selectedBranch,
          machineType: selectedMachine,
          idleTimeoutMinutes: idleTimeout,
          displayName: displayName || undefined,
        });
      }
    }
  }

  return codespaceName;
}
