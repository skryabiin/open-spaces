import * as vscode from 'vscode';
import { CodespaceTreeProvider } from './ui/codespaceTreeProvider';
import { CodespaceTreeItem } from './ui/treeItems';
import * as codespaceManager from './codespaceManager';
import * as ghCli from './ghCli';

let treeProvider: CodespaceTreeProvider;
let outputChannel: vscode.OutputChannel;

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

export function activate(context: vscode.ExtensionContext) {
  // Create output channel for logging
  outputChannel = vscode.window.createOutputChannel('Open Spaces');
  context.subscriptions.push(outputChannel);

  log('Open Spaces extension activating');

  // Check for open-remote-ssh extension
  const remoteSshExtension = vscode.extensions.getExtension('jeanp413.open-remote-ssh');
  if (!remoteSshExtension) {
    void vscode.window.showWarningMessage(
      'Open Remote - SSH extension is required to connect to codespaces.',
      'Install Extension'
    ).then(selection => {
      if (selection === 'Install Extension') {
        void vscode.env.openExternal(vscode.Uri.parse('vscode:extension/jeanp413.open-remote-ssh'));
      }
    });
  }

  // Check for gh CLI
  void ghCli.checkInstalled().then(installed => {
    if (!installed) {
      void vscode.window.showErrorMessage(
        'GitHub CLI (gh) is not installed. Install it to use this extension.',
        'Get GitHub CLI'
      ).then(selection => {
        if (selection === 'Get GitHub CLI') {
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
      if (!item?.codespace) {
        void vscode.window.showErrorMessage('No codespace selected');
        return;
      }

      try {
        await codespaceManager.connect(item.codespace);
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        log(`Failed to connect to codespace ${item.codespace.name}`, err);
        void vscode.window.showErrorMessage(`Failed to connect: ${err.message}`);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('openSpaces.start', async (item?: CodespaceTreeItem) => {
      if (!item?.codespace) {
        void vscode.window.showErrorMessage('No codespace selected');
        return;
      }

      try {
        await codespaceManager.start(item.codespace);
        treeProvider.refresh();
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        log(`Failed to start codespace ${item.codespace.name}`, err);
        void vscode.window.showErrorMessage(`Failed to start codespace: ${err.message}`);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('openSpaces.stop', async (item?: CodespaceTreeItem) => {
      if (!item?.codespace) {
        void vscode.window.showErrorMessage('No codespace selected');
        return;
      }

      try {
        await codespaceManager.stop(item.codespace);
        treeProvider.refresh();
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        log(`Failed to stop codespace ${item.codespace.name}`, err);
        void vscode.window.showErrorMessage(`Failed to stop codespace: ${err.message}`);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('openSpaces.openAuthTerminal', () => {
      void codespaceManager.openAuthTerminal();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('openSpaces.rebuild', async (item?: CodespaceTreeItem) => {
      if (!item?.codespace) {
        void vscode.window.showErrorMessage('No codespace selected');
        return;
      }

      try {
        await codespaceManager.rebuild(item.codespace, false);
        treeProvider.refresh();
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        log(`Failed to rebuild codespace ${item.codespace.name}`, err);
        void vscode.window.showErrorMessage(`Failed to rebuild codespace: ${err.message}`);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('openSpaces.rebuildFull', async (item?: CodespaceTreeItem) => {
      if (!item?.codespace) {
        void vscode.window.showErrorMessage('No codespace selected');
        return;
      }

      try {
        await codespaceManager.rebuild(item.codespace, true);
        treeProvider.refresh();
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        log(`Failed to full rebuild codespace ${item.codespace.name}`, err);
        void vscode.window.showErrorMessage(`Failed to rebuild codespace: ${err.message}`);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('openSpaces.delete', async (item?: CodespaceTreeItem) => {
      if (!item?.codespace) {
        void vscode.window.showErrorMessage('No codespace selected');
        return;
      }

      try {
        await codespaceManager.deleteCodespace(item.codespace);
        treeProvider.refresh();
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        log(`Failed to delete codespace ${item.codespace.name}`, err);
        void vscode.window.showErrorMessage(`Failed to delete codespace: ${err.message}`);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('openSpaces.disconnect', async () => {
      const codespaceName = getCodespaceName();
      const message = codespaceName
        ? `Disconnect from codespace ${codespaceName}?`
        : 'Disconnect from remote?';

      const confirmed = await vscode.window.showWarningMessage(
        message,
        { modal: true },
        'Disconnect'
      );

      if (confirmed === 'Disconnect') {
        // Close the remote connection
        await vscode.commands.executeCommand('workbench.action.remote.close');
      }
    })
  );

  // Initial load
  void treeProvider.loadCodespaces();
}

export function deactivate() {
  if (treeProvider) {
    treeProvider.dispose();
  }
}
