import * as vscode from 'vscode';
import { CodespaceTreeProvider } from './ui/codespaceTreeProvider';
import { CodespaceTreeItem } from './ui/treeItems';
import * as codespaceManager from './codespaceManager';
import * as ghCli from './ghCli';
import { ensureError } from './utils/errors';
import { Codespace } from './types';
import { findStaleCodespaces, promptStaleCleanup } from './staleDetector';
import { getTemplates, deleteTemplate } from './templateManager';
import { DevcontainerContentProvider, previewDevcontainer } from './devcontainerPreview';
import { ConnectionHealthMonitor } from './connectionHealthMonitor';
import { formatMachineSpecs } from './utils/formatting';
import { getIdleTimeRemaining } from './utils/formatting';

let treeProvider: CodespaceTreeProvider;
let outputChannel: vscode.OutputChannel;

// Auth polling state (module-level for cleanup in deactivate)
let authPollingInterval: NodeJS.Timeout | null = null;

// Status bar state (module-level for cleanup in deactivate)
let statusBarItem: vscode.StatusBarItem;
let statusUpdateInterval: NodeJS.Timeout | null = null;

// Connection health monitor (module-level for cleanup in deactivate)
let healthMonitor: ConnectionHealthMonitor | null = null;

function stopAuthPolling(): void {
  if (authPollingInterval) {
    clearInterval(authPollingInterval);
    authPollingInterval = null;
  }
}

/**
 * Logs a message to the Open Spaces output channel.
 * @param message - The message to log
 * @param error - Optional error to include in the log
 */
export function log(message: string, error?: Error): void {
  const timestamp = new Date().toISOString();
  outputChannel.appendLine(`[${timestamp}] ${message}`);
  if (error) {
    outputChannel.appendLine(`  Error: ${error.message}`);
    if (error.stack) {
      outputChannel.appendLine(`  Stack: ${error.stack}`);
    }
  }
}

function getStateLabel(state: string): string {
  switch (state) {
    case 'Available': return vscode.l10n.t('$(circle-filled) Running');
    case 'Shutdown': return vscode.l10n.t('$(circle-outline) Stopped');
    case 'Starting': return vscode.l10n.t('$(sync~spin) Starting');
    case 'ShuttingDown': return vscode.l10n.t('$(sync~spin) Stopping');
    default: return state;
  }
}

interface PickCodespaceOptions {
  title: string;
  stateFilter?: 'running' | 'stopped';
}

async function pickCodespace(options: PickCodespaceOptions): Promise<Codespace | undefined> {
  const allCodespaces = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: vscode.l10n.t('Loading codespaces...'),
      cancellable: false,
    },
    () => ghCli.listCodespaces()
  );

  if (allCodespaces.length === 0) {
    void vscode.window.showInformationMessage(vscode.l10n.t('No codespaces found'));
    return undefined;
  }

  // Filter codespaces based on state if specified
  let codespaces = allCodespaces;
  if (options.stateFilter === 'running') {
    codespaces = allCodespaces.filter((cs) => cs.state === 'Available');
    if (codespaces.length === 0) {
      void vscode.window.showInformationMessage(vscode.l10n.t('No running codespaces found'));
      return undefined;
    }
  } else if (options.stateFilter === 'stopped') {
    codespaces = allCodespaces.filter((cs) => cs.state === 'Shutdown');
    if (codespaces.length === 0) {
      void vscode.window.showInformationMessage(vscode.l10n.t('No stopped codespaces found'));
      return undefined;
    }
  }

  const items = codespaces.map((cs) => ({
    label: cs.displayName,
    description: getStateLabel(cs.state),
    detail: `${cs.repository} • ${cs.branch || 'default branch'}`,
    codespace: cs,
  }));

  const selected = await vscode.window.showQuickPick(items, {
    placeHolder: vscode.l10n.t('Select a codespace'),
    title: options.title,
  });

  return selected?.codespace;
}

function isInsideCodespace(): boolean {
  // Check environment variables that indicate we're in a codespace
  return (
    process.env.CODESPACES === 'true' ||
    !!process.env.CODESPACE_NAME ||
    vscode.env.remoteName === 'codespaces' ||
    vscode.env.remoteName === 'ssh-remote'
  );
}

function getCodespaceName(): string | undefined {
  return process.env.CODESPACE_NAME;
}

function updateStatusBar(): void {
  if (!statusBarItem) {
    return;
  }
  const connected = treeProvider.getConnectedCodespace();
  if (!connected) {
    statusBarItem.hide();
    return;
  }

  const parts: string[] = [`$(circle-filled) ${connected.displayName}`];
  if (connected.machineInfo) {
    parts.push(formatMachineSpecs(connected.machineInfo));
  }
  if (connected.state === 'Available' && connected.idleTimeoutMinutes) {
    const idleInfo = getIdleTimeRemaining(connected.lastUsedAt, connected.idleTimeoutMinutes);
    if (idleInfo) {
      parts.push(idleInfo.text);
    }
  }

  statusBarItem.text = parts.join(' • ');
  statusBarItem.show();
}

export function activate(context: vscode.ExtensionContext) {
  // Create output channel for logging
  outputChannel = vscode.window.createOutputChannel('Open Spaces');
  context.subscriptions.push(outputChannel);

  log('Open Spaces extension activating');

  // Check for open-remote-ssh extension
  const remoteSshExtension = vscode.extensions.getExtension('jeanp413.open-remote-ssh');
  if (!remoteSshExtension) {
    void vscode.window.showWarningMessage(
      vscode.l10n.t('Open Remote - SSH extension is required to connect to codespaces.'),
      vscode.l10n.t('Install Extension')
    ).then(selection => {
      if (selection === vscode.l10n.t('Install Extension')) {
        void vscode.env.openExternal(vscode.Uri.parse('vscode:extension/jeanp413.open-remote-ssh'));
      }
    });
  }

  // Check for gh CLI
  void ghCli.checkInstalled().then(installed => {
    if (!installed) {
      void vscode.window.showErrorMessage(
        vscode.l10n.t('GitHub CLI (gh) is not installed. Install it to use this extension.'),
        vscode.l10n.t('Get GitHub CLI')
      ).then(selection => {
        if (selection === vscode.l10n.t('Get GitHub CLI')) {
          void vscode.env.openExternal(vscode.Uri.parse('https://cli.github.com/'));
        }
      });
    }
  });

  // Check if we're inside a codespace and set context
  const insideCodespace = isInsideCodespace();
  void vscode.commands.executeCommand('setContext', 'openSpaces.insideCodespace', insideCodespace);

  // Create tree provider
  treeProvider = new CodespaceTreeProvider();

  // When inside a codespace, only show the connected codespace
  const connectedCodespaceName = getCodespaceName();
  if (connectedCodespaceName) {
    treeProvider.setConnectedCodespace(connectedCodespaceName);
  }

  // Register tree view
  const treeView = vscode.window.createTreeView('openSpaces.codespaceTree', {
    treeDataProvider: treeProvider,
    showCollapseAll: false,
    canSelectMany: true,
  });

  context.subscriptions.push(treeView);
  context.subscriptions.push(treeProvider);

  // Track tree view visibility for proactive refresh
  context.subscriptions.push(
    treeView.onDidChangeVisibility((e) => {
      treeProvider.setVisible(e.visible);
    })
  );
  treeProvider.setVisible(treeView.visible);

  // --- Status Bar (Feature 2) ---
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBarItem.command = 'openSpaces.statusBarActions';
  context.subscriptions.push(statusBarItem);

  if (insideCodespace && connectedCodespaceName) {
    statusUpdateInterval = setInterval(() => updateStatusBar(), 60000);
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('openSpaces.statusBarActions', async () => {
      const actions = [
        { label: vscode.l10n.t('$(debug-disconnect) Disconnect'), action: 'disconnect' },
        { label: vscode.l10n.t('$(debug-stop) Stop Codespace'), action: 'stop' },
        { label: vscode.l10n.t('$(terminal) Open SSH Terminal'), action: 'terminal' },
      ];
      const selected = await vscode.window.showQuickPick(actions, {
        placeHolder: vscode.l10n.t('Codespace Actions'),
      });
      if (!selected) {
        return;
      }
      switch (selected.action) {
        case 'disconnect':
          await vscode.commands.executeCommand('openSpaces.disconnect');
          break;
        case 'stop': {
          const cs = treeProvider.getConnectedCodespace();
          if (cs) {
            await vscode.commands.executeCommand('openSpaces.stop');
          }
          break;
        }
        case 'terminal': {
          const cs = treeProvider.getConnectedCodespace();
          if (cs) {
            await codespaceManager.openSshTerminal(cs);
          }
          break;
        }
      }
    })
  );

  // --- Devcontainer Preview (Feature 7) ---
  const devcontainerProvider = new DevcontainerContentProvider();
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider('codespace-devcontainer', devcontainerProvider)
  );
  context.subscriptions.push(devcontainerProvider);

  // Register commands
  context.subscriptions.push(
    vscode.commands.registerCommand('openSpaces.refresh', () => {
      treeProvider.refresh();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('openSpaces.connect', async (item?: CodespaceTreeItem) => {
      const codespace = item?.codespace ?? await pickCodespace({ title: vscode.l10n.t('Connect to Codespace') });
      if (!codespace) {
        return;
      }

      try {
        await codespaceManager.connect(codespace);
      } catch (error) {
        const err = ensureError(error);
        log(`Failed to connect to codespace ${codespace.name}`, err);
        void vscode.window.showErrorMessage(vscode.l10n.t('Failed to connect: {0}', err.message));
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('openSpaces.start', async (item?: CodespaceTreeItem) => {
      const codespace = item?.codespace ?? await pickCodespace({ title: vscode.l10n.t('Start Codespace'), stateFilter: 'stopped' });
      if (!codespace) {
        return;
      }

      try {
        await codespaceManager.start(codespace);
        treeProvider.refresh();
      } catch (error) {
        const err = ensureError(error);
        log(`Failed to start codespace ${codespace.name}`, err);
        void vscode.window.showErrorMessage(vscode.l10n.t('Failed to start codespace: {0}', err.message));
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('openSpaces.stop', async (item?: CodespaceTreeItem) => {
      const codespace = item?.codespace ?? await pickCodespace({ title: vscode.l10n.t('Stop Codespace'), stateFilter: 'running' });
      if (!codespace) {
        return;
      }

      try {
        await codespaceManager.stop(codespace);
        treeProvider.refresh();
      } catch (error) {
        const err = ensureError(error);
        log(`Failed to stop codespace ${codespace.name}`, err);
        void vscode.window.showErrorMessage(vscode.l10n.t('Failed to stop codespace: {0}', err.message));
      }
    })
  );

  // Track active auth terminals and poll for auth completion
  const activeAuthTerminals = new Set<vscode.Terminal>();
  let wasAuthenticated = false;
  let authPollingStartTime: number | null = null;
  const AUTH_POLLING_TIMEOUT_MS = 60000; // 1 minute max

  function startAuthPolling(): void {
    if (authPollingInterval) {
      return;
    }
    // Capture current auth state before polling
    wasAuthenticated = false;
    authPollingStartTime = Date.now();
    authPollingInterval = setInterval(() => {
      void (async () => {
        // Stop polling after 1 minute
        if (authPollingStartTime && Date.now() - authPollingStartTime > AUTH_POLLING_TIMEOUT_MS) {
          stopAuthPolling();
          activeAuthTerminals.clear();
          return;
        }
        const authResult = await ghCli.checkAuth();
        const isAuthenticated = authResult.authenticated && authResult.hasCodespaceScope;
        if (isAuthenticated && !wasAuthenticated) {
          // Auth state changed from not authenticated to authenticated - refresh
          treeProvider.refresh();
          stopAuthPolling();
          activeAuthTerminals.clear();
        }
        wasAuthenticated = isAuthenticated;
      })();
    }, 2000);
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('openSpaces.openAuthTerminal', () => {
      const terminal = codespaceManager.openAuthTerminal();
      activeAuthTerminals.add(terminal);
      startAuthPolling();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('openSpaces.addCodespaceScope', () => {
      const terminal = codespaceManager.openScopeRefreshTerminal();
      activeAuthTerminals.add(terminal);
      startAuthPolling();
    })
  );

  // Clean up auth polling when terminals close
  context.subscriptions.push(
    vscode.window.onDidCloseTerminal((closedTerminal) => {
      if (activeAuthTerminals.has(closedTerminal)) {
        activeAuthTerminals.delete(closedTerminal);
        if (activeAuthTerminals.size === 0) {
          stopAuthPolling();
          // Final refresh in case auth completed just before close
          setTimeout(() => treeProvider.refresh(), 500);
        }
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('openSpaces.openSshTerminal', async (item?: CodespaceTreeItem) => {
      const codespace = item?.codespace ?? await pickCodespace({ title: vscode.l10n.t('Open SSH Terminal') });
      if (!codespace) {
        return;
      }

      try {
        await codespaceManager.openSshTerminal(codespace);
      } catch (error) {
        const err = ensureError(error);
        log(`Failed to open SSH terminal for codespace ${codespace.name}`, err);
        void vscode.window.showErrorMessage(vscode.l10n.t('Failed to open SSH terminal: {0}', err.message));
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('openSpaces.rebuild', async (item?: CodespaceTreeItem) => {
      const codespace = item?.codespace ?? await pickCodespace({ title: vscode.l10n.t('Rebuild Codespace') });
      if (!codespace) {
        return;
      }

      try {
        await codespaceManager.rebuild(codespace, false);
        treeProvider.refresh();
      } catch (error) {
        const err = ensureError(error);
        log(`Failed to rebuild codespace ${codespace.name}`, err);
        void vscode.window.showErrorMessage(vscode.l10n.t('Failed to rebuild codespace: {0}', err.message));
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('openSpaces.rebuildFull', async (item?: CodespaceTreeItem) => {
      const codespace = item?.codespace ?? await pickCodespace({ title: vscode.l10n.t('Full Rebuild Codespace') });
      if (!codespace) {
        return;
      }

      try {
        await codespaceManager.rebuild(codespace, true);
        treeProvider.refresh();
      } catch (error) {
        const err = ensureError(error);
        log(`Failed to full rebuild codespace ${codespace.name}`, err);
        void vscode.window.showErrorMessage(vscode.l10n.t('Failed to rebuild codespace: {0}', err.message));
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('openSpaces.delete', async (item?: CodespaceTreeItem) => {
      const codespace = item?.codespace ?? await pickCodespace({ title: vscode.l10n.t('Delete Codespace') });
      if (!codespace) {
        return;
      }

      try {
        await codespaceManager.deleteCodespace(codespace);
        treeProvider.refresh();
      } catch (error) {
        const err = ensureError(error);
        log(`Failed to delete codespace ${codespace.name}`, err);
        void vscode.window.showErrorMessage(vscode.l10n.t('Failed to delete codespace: {0}', err.message));
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('openSpaces.disconnect', async () => {
      const codespaceName = getCodespaceName();
      const message = codespaceName
        ? vscode.l10n.t('Disconnect from codespace {0}?', codespaceName)
        : vscode.l10n.t('Disconnect from remote?');

      const confirmed = await vscode.window.showWarningMessage(
        message,
        { modal: true },
        vscode.l10n.t('Disconnect')
      );

      if (confirmed === vscode.l10n.t('Disconnect')) {
        // Close the remote connection
        await vscode.commands.executeCommand('workbench.action.remote.close');
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('openSpaces.create', async () => {
      try {
        const codespaceName = await codespaceManager.createCodespace();
        if (codespaceName) {
          treeProvider.refresh();
        }
      } catch (error) {
        const err = ensureError(error);
        log('Failed to create codespace', err);
        void vscode.window.showErrorMessage(vscode.l10n.t('Failed to create codespace: {0}', err.message));
      }
    })
  );

  // --- Search & Filter Commands (Feature 3) ---
  context.subscriptions.push(
    vscode.commands.registerCommand('openSpaces.filterByText', async () => {
      const text = await vscode.window.showInputBox({
        placeHolder: vscode.l10n.t('Filter by name, repo, or branch'),
        title: vscode.l10n.t('Filter Codespaces'),
      });
      if (text !== undefined) {
        treeProvider.setFilterText(text);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('openSpaces.filterByState', async () => {
      const items = [
        { label: vscode.l10n.t('All'), state: 'all' as const },
        { label: vscode.l10n.t('Running'), state: 'running' as const },
        { label: vscode.l10n.t('Stopped'), state: 'stopped' as const },
      ];
      const selected = await vscode.window.showQuickPick(items, {
        placeHolder: vscode.l10n.t('Filter by state'),
        title: vscode.l10n.t('Filter Codespaces by State'),
      });
      if (selected) {
        treeProvider.setFilterState(selected.state);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('openSpaces.clearFilters', () => {
      treeProvider.clearFilters();
    })
  );

  // --- Bulk Operations (Feature 4) ---
  context.subscriptions.push(
    vscode.commands.registerCommand('openSpaces.bulkStop', async (_item?: CodespaceTreeItem, allItems?: CodespaceTreeItem[]) => {
      const items = allItems?.filter((i) => i.codespace.state === 'Available');
      if (!items || items.length === 0) {
        void vscode.window.showInformationMessage(vscode.l10n.t('No running codespaces selected'));
        return;
      }

      const confirmed = await vscode.window.showWarningMessage(
        vscode.l10n.t('Stop {0} codespace(s)?', items.length),
        { modal: true },
        vscode.l10n.t('Stop All')
      );

      if (confirmed !== vscode.l10n.t('Stop All')) {
        return;
      }

      let stopped = 0;
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: vscode.l10n.t('Stopping codespaces...'),
          cancellable: false,
        },
        async (progress) => {
          for (const item of items) {
            try {
              progress.report({ message: item.codespace.displayName });
              await ghCli.stopCodespace(item.codespace.name);
              await ghCli.waitForState(item.codespace.name, 'Shutdown');
              stopped++;
            } catch (error) {
              const err = ensureError(error);
              log(`Failed to stop codespace ${item.codespace.name}`, err);
            }
          }
        }
      );

      treeProvider.refresh();
      void vscode.window.showInformationMessage(
        vscode.l10n.t('{0} of {1} codespace(s) stopped', stopped, items.length)
      );
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('openSpaces.bulkDelete', async (_item?: CodespaceTreeItem, allItems?: CodespaceTreeItem[]) => {
      const items = allItems?.filter((i) => i.codespace);
      if (!items || items.length === 0) {
        return;
      }

      const confirmed = await vscode.window.showWarningMessage(
        vscode.l10n.t('Delete {0} codespace(s)? This cannot be undone.', items.length),
        { modal: true },
        vscode.l10n.t('Delete All')
      );

      if (confirmed !== vscode.l10n.t('Delete All')) {
        return;
      }

      let deleted = 0;
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: vscode.l10n.t('Deleting codespaces...'),
          cancellable: false,
        },
        async (progress) => {
          for (const item of items) {
            try {
              progress.report({ message: item.codespace.displayName });
              await ghCli.deleteCodespace(item.codespace.name);
              deleted++;
            } catch (error) {
              const err = ensureError(error);
              log(`Failed to delete codespace ${item.codespace.name}`, err);
            }
          }
        }
      );

      treeProvider.refresh();
      void vscode.window.showInformationMessage(
        vscode.l10n.t('{0} of {1} codespace(s) deleted', deleted, items.length)
      );
    })
  );

  // --- Manage Templates (Feature 5) ---
  context.subscriptions.push(
    vscode.commands.registerCommand('openSpaces.manageTemplates', async () => {
      const templates = getTemplates();
      if (templates.length === 0) {
        void vscode.window.showInformationMessage(
          vscode.l10n.t('No templates saved. Create a codespace to save a template.')
        );
        return;
      }

      const items = templates.map((t) => ({
        label: t.name,
        description: t.repo,
        detail: [t.branch, t.machineType].filter(Boolean).join(' • '),
        template: t,
      }));

      const selected = await vscode.window.showQuickPick(items, {
        placeHolder: vscode.l10n.t('Select a template to manage'),
        title: vscode.l10n.t('Manage Templates'),
      });

      if (!selected) {
        return;
      }

      const action = await vscode.window.showQuickPick(
        [
          { label: vscode.l10n.t('$(trash) Delete'), action: 'delete' },
        ],
        { placeHolder: vscode.l10n.t('Choose action for "{0}"', selected.template.name) }
      );

      if (action?.action === 'delete') {
        await deleteTemplate(selected.template.name);
        void vscode.window.showInformationMessage(
          vscode.l10n.t('Template "{0}" deleted', selected.template.name)
        );
      }
    })
  );

  // --- Devcontainer Preview Command (Feature 7) ---
  context.subscriptions.push(
    vscode.commands.registerCommand('openSpaces.previewDevcontainer', async (item?: CodespaceTreeItem) => {
      const codespace = item?.codespace ?? await pickCodespace({ title: vscode.l10n.t('Preview Devcontainer') });
      if (!codespace) {
        return;
      }
      await previewDevcontainer(codespace, devcontainerProvider);
    })
  );

  // Initial load
  void treeProvider.loadCodespaces().then(() => {
    // Update status bar after initial load
    if (insideCodespace) {
      updateStatusBar();
    }

    // --- Stale Codespace Detection (Feature 8) ---
    const config = vscode.workspace.getConfiguration('openSpaces');
    if (config.get<boolean>('detectStaleCodespaces', true)) {
      const staleThreshold = config.get<number>('staleThresholdDays', 14);
      const stale = findStaleCodespaces(treeProvider.getAllCodespaces(), staleThreshold);
      if (stale.length > 0) {
        void promptStaleCleanup(stale);
      }
    }
  });

  // --- Connection Health Monitor (Feature 9) ---
  if (insideCodespace && connectedCodespaceName) {
    const config = vscode.workspace.getConfiguration('openSpaces');
    const intervalSec = config.get<number>('connectionCheckInterval', 30);
    healthMonitor = new ConnectionHealthMonitor(connectedCodespaceName, intervalSec * 1000);
    healthMonitor.start();
    context.subscriptions.push(healthMonitor);
  }
}

export function deactivate() {
  stopAuthPolling();
  if (statusUpdateInterval) {
    clearInterval(statusUpdateInterval);
    statusUpdateInterval = null;
  }
  if (healthMonitor) {
    healthMonitor.dispose();
    healthMonitor = null;
  }
  if (treeProvider) {
    treeProvider.dispose();
  }
}
