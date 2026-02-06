import * as vscode from 'vscode';
import { CodespaceTreeProvider } from './ui/codespaceTreeProvider';
import { CodespaceTreeItem } from './ui/treeItems';
import * as codespaceManager from './codespaceManager';
import * as ghCli from './ghCli';
import * as sshConfigManager from './sshConfigManager';
import { ensureError } from './utils/errors';
import { Codespace } from './types';

let treeProvider: CodespaceTreeProvider;
let outputChannel: vscode.OutputChannel;

// Auth polling state (module-level for cleanup in deactivate)
let authPollingInterval: NodeJS.Timeout | null = null;

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

function getConnectedCodespaceName(context: vscode.ExtensionContext): string | undefined {
  if (vscode.env.remoteName !== 'ssh-remote') {
    return undefined;
  }

  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    return undefined;
  }

  const remoteHost = folders[0].uri.authority.replace('ssh-remote+', '');
  const managedHost = sshConfigManager.getManagedHost();
  if (remoteHost && managedHost && remoteHost === managedHost) {
    return context.globalState.get<string>('connectedCodespaceName');
  }

  return undefined;
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

  // When connected to a codespace, only show that codespace
  const connectedCodespaceName = getConnectedCodespaceName(context);
  if (connectedCodespaceName) {
    treeProvider.setConnectedCodespace(connectedCodespaceName);
  }

  // Register tree view
  const treeView = vscode.window.createTreeView('openSpaces.codespaceTree', {
    treeDataProvider: treeProvider,
    showCollapseAll: false,
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
        // Store codespace name before connect (window reloads after openFolder)
        await context.globalState.update('connectedCodespaceName', codespace.name);
        await codespaceManager.connect(codespace);
      } catch (error) {
        await context.globalState.update('connectedCodespaceName', undefined);
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
      const codespaceName = getConnectedCodespaceName(context);
      const message = codespaceName
        ? vscode.l10n.t('Disconnect from codespace {0}?', codespaceName)
        : vscode.l10n.t('Disconnect from remote?');

      const confirmed = await vscode.window.showWarningMessage(
        message,
        { modal: true },
        vscode.l10n.t('Disconnect')
      );

      if (confirmed === vscode.l10n.t('Disconnect')) {
        await context.globalState.update('connectedCodespaceName', undefined);
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

  // Initial load
  void treeProvider.loadCodespaces();
}

export function deactivate() {
  stopAuthPolling();
  if (treeProvider) {
    treeProvider.dispose();
  }
}
