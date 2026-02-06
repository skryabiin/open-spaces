import * as vscode from 'vscode';
import * as ghCli from './ghCli';
import { Codespace } from './types';

const contentCache = new Map<string, string>();

export class DevcontainerContentProvider implements vscode.TextDocumentContentProvider {
  private _onDidChange = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this._onDidChange.event;

  provideTextDocumentContent(uri: vscode.Uri): string {
    return contentCache.get(uri.path) || '';
  }

  setContent(path: string, content: string): void {
    contentCache.set(path, content);
    this._onDidChange.fire(vscode.Uri.parse(`codespace-devcontainer:${path}`));
  }

  dispose(): void {
    this._onDidChange.dispose();
    contentCache.clear();
  }
}

/**
 * Fetches and previews the devcontainer.json for a codespace's repository.
 */
export async function previewDevcontainer(
  codespace: Codespace,
  provider: DevcontainerContentProvider
): Promise<void> {
  const paths = ['.devcontainer/devcontainer.json', '.devcontainer.json'];

  let content: string | null = null;

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: vscode.l10n.t('Fetching devcontainer.json...'),
      cancellable: false,
    },
    async () => {
      for (const filePath of paths) {
        content = await ghCli.getFileContents(
          codespace.repository,
          filePath,
          codespace.branch || undefined
        );
        if (content) {
          break;
        }
      }
    }
  );

  if (!content) {
    void vscode.window.showInformationMessage(
      vscode.l10n.t('No devcontainer.json found for {0}', codespace.repository)
    );
    return;
  }

  const docPath = `/${codespace.name}/devcontainer.json`;
  provider.setContent(docPath, content);

  const uri = vscode.Uri.parse(`codespace-devcontainer:${docPath}`);
  const doc = await vscode.workspace.openTextDocument(uri);
  await vscode.languages.setTextDocumentLanguage(doc, 'jsonc');
  await vscode.window.showTextDocument(doc, { preview: true });
}
