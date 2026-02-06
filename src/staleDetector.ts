import * as vscode from 'vscode';
import * as ghCli from './ghCli';
import { Codespace } from './types';

/**
 * Finds codespaces that have not been used within the given threshold.
 */
export function findStaleCodespaces(codespaces: Codespace[], thresholdDays: number): Codespace[] {
  const threshold = Date.now() - thresholdDays * 24 * 60 * 60 * 1000;
  return codespaces.filter(
    (cs) =>
      cs.state === 'Shutdown' && cs.lastUsedAt && new Date(cs.lastUsedAt).getTime() < threshold
  );
}

/**
 * Prompts the user to clean up stale codespaces.
 */
export async function promptStaleCleanup(stale: Codespace[]): Promise<void> {
  const message = vscode.l10n.t(
    '{0} codespace(s) unused for 14+ days. Stop or delete to save costs?',
    stale.length
  );

  const selection = await vscode.window.showWarningMessage(
    message,
    vscode.l10n.t('Delete All'),
    vscode.l10n.t('Dismiss')
  );

  if (selection === vscode.l10n.t('Delete All')) {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: vscode.l10n.t('Deleting stale codespaces...'),
        cancellable: false,
      },
      async () => {
        for (const cs of stale) {
          try {
            await ghCli.deleteCodespace(cs.name);
          } catch {
            // Continue with remaining codespaces
          }
        }
      }
    );
    void vscode.commands.executeCommand('openSpaces.refresh');
  }
}
