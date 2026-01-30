import * as vscode from 'vscode';
import * as ghCli from '../ghCli';
import * as codespaceManager from '../codespaceManager';
import { Codespace, GhCliError } from '../types';
import { isTransitionalState } from '../constants';
import { ensureError } from '../utils/errors';
import {
  RepositoryTreeItem,
  CodespaceTreeItem,
  CodespaceDetailItem,
  GhNotInstalledTreeItem,
  AuthRequiredTreeItem,
  NoCodespacesTreeItem,
  LoadingTreeItem,
  ErrorTreeItem,
} from './treeItems';

type TreeItem =
  | RepositoryTreeItem
  | CodespaceTreeItem
  | CodespaceDetailItem
  | GhNotInstalledTreeItem
  | AuthRequiredTreeItem
  | NoCodespacesTreeItem
  | LoadingTreeItem
  | ErrorTreeItem;

export class CodespaceTreeProvider implements vscode.TreeDataProvider<TreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<TreeItem | undefined | null | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private codespaces: Codespace[] = [];
  private loading = true;
  private error: GhCliError | Error | null = null;
  private ghInstalled = true;
  private authenticated = true;

  private isPolling = false;
  private pollTimer: NodeJS.Timeout | null = null;
  private pollInterval = 5000;

  private backgroundRefreshTimer: NodeJS.Timeout | null = null;
  private backgroundRefreshInterval = 60000;
  private isVisible = false;

  constructor() {}

  refresh(): void {
    this.loading = true;
    this._onDidChangeTreeData.fire();
    void this.loadCodespaces();
  }

  async loadCodespaces(): Promise<void> {
    this.stopPolling();
    await this.loadCodespacesInternal();
    this.startPollingIfNeeded();
  }

  private async loadCodespacesInternal(): Promise<void> {
    try {
      // Check prerequisites
      const prereq = await codespaceManager.checkPrerequisites();

      if (!prereq.ready) {
        this.ghInstalled = prereq.ghInstalled;
        this.authenticated = prereq.authenticated;
        this.error = prereq.error || null;
        this.codespaces = [];
        this.loading = false;
        this._onDidChangeTreeData.fire();
        return;
      }

      this.ghInstalled = true;
      this.authenticated = true;

      // Load codespaces
      this.codespaces = await ghCli.listCodespaces();

      // Fetch additional info for running codespaces (idle timeout, machine specs)
      const runningCodespaces = this.codespaces.filter((cs) => cs.state === 'Available');
      await Promise.all(
        runningCodespaces.map(async (cs) => {
          const [idleInfo, machineInfo] = await Promise.all([
            ghCli.getCodespaceIdleTimeout(cs.name),
            ghCli.getCodespaceMachineInfo(cs.name),
          ]);
          if (idleInfo) {
            cs.idleTimeoutMinutes = idleInfo.idleTimeoutMinutes;
            // Update lastUsedAt if the view command returns a more recent value
            if (idleInfo.lastUsedAt) {
              cs.lastUsedAt = idleInfo.lastUsedAt;
            }
          }
          if (machineInfo) {
            cs.machineInfo = machineInfo;
          }
        })
      );

      // Fetch machine info for stopped codespaces too
      const stoppedCodespaces = this.codespaces.filter((cs) => cs.state === 'Shutdown');
      await Promise.all(
        stoppedCodespaces.map(async (cs) => {
          const machineInfo = await ghCli.getCodespaceMachineInfo(cs.name);
          if (machineInfo) {
            cs.machineInfo = machineInfo;
          }
        })
      );

      this.error = null;
      this.loading = false;
      this._onDidChangeTreeData.fire();
    } catch (err) {
      this.error = ensureError(err);
      this.codespaces = [];
      this.loading = false;
      this._onDidChangeTreeData.fire();
    }
  }

  private startPollingIfNeeded(): void {
    if (this.isPolling) {
      return;
    }

    const hasTransitional = this.codespaces.some((cs) => isTransitionalState(cs.state));

    if (hasTransitional) {
      this.isPolling = true;
      this.pollTimer = setInterval(() => {
        if (this.isPolling) {
          void this.loadCodespacesInternal();
        }
      }, this.pollInterval);
    }
  }

  private stopPolling(): void {
    this.isPolling = false;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  setVisible(visible: boolean): void {
    const wasVisible = this.isVisible;
    this.isVisible = visible;

    if (visible && !wasVisible) {
      // Pane just became visible - refresh immediately and start background refresh
      this.refresh();
      this.startBackgroundRefresh();
    } else if (!visible && wasVisible) {
      // Pane is now hidden - stop background refresh
      this.stopBackgroundRefresh();
    }
  }

  private startBackgroundRefresh(): void {
    if (this.backgroundRefreshTimer) {
      return;
    }

    this.backgroundRefreshTimer = setInterval(() => {
      if (this.isVisible) {
        void this.loadCodespacesInternal();
      }
    }, this.backgroundRefreshInterval);
  }

  private stopBackgroundRefresh(): void {
    if (this.backgroundRefreshTimer) {
      clearInterval(this.backgroundRefreshTimer);
      this.backgroundRefreshTimer = null;
    }
  }

  getTreeItem(element: TreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: TreeItem): Thenable<TreeItem[]> {
    if (element instanceof RepositoryTreeItem) {
      return Promise.resolve(element.getChildren());
    }

    if (element instanceof CodespaceTreeItem) {
      return Promise.resolve(element.getChildren());
    }

    if (element) {
      return Promise.resolve([]);
    }

    if (this.loading) {
      return Promise.resolve([new LoadingTreeItem()]);
    }

    if (!this.ghInstalled) {
      return Promise.resolve([new GhNotInstalledTreeItem()]);
    }

    if (!this.authenticated) {
      const message =
        this.error instanceof GhCliError ? this.error.message : 'Authentication required';
      return Promise.resolve([new AuthRequiredTreeItem(message)]);
    }

    if (this.error) {
      return Promise.resolve([new ErrorTreeItem(this.error.message)]);
    }

    if (this.codespaces.length === 0) {
      return Promise.resolve([new NoCodespacesTreeItem()]);
    }

    // Group codespaces by repository
    const repoMap = new Map<string, Codespace[]>();
    for (const cs of this.codespaces) {
      const repo = cs.repository || 'Unknown';
      const existing = repoMap.get(repo);
      if (existing) {
        existing.push(cs);
      } else {
        repoMap.set(repo, [cs]);
      }
    }

    // Sort codespaces within each repo: running first, then by last used
    for (const codespaces of repoMap.values()) {
      codespaces.sort((a, b) => {
        if (a.state === 'Available' && b.state !== 'Available') return -1;
        if (a.state !== 'Available' && b.state === 'Available') return 1;
        const aTime = a.lastUsedAt ? new Date(a.lastUsedAt).getTime() : 0;
        const bTime = b.lastUsedAt ? new Date(b.lastUsedAt).getTime() : 0;
        return bTime - aTime;
      });
    }

    // Sort repositories: those with running codespaces first, then alphabetically
    const sortedRepos = [...repoMap.entries()].sort((a, b) => {
      const aHasRunning = a[1].some((cs) => cs.state === 'Available');
      const bHasRunning = b[1].some((cs) => cs.state === 'Available');
      if (aHasRunning && !bHasRunning) return -1;
      if (!aHasRunning && bHasRunning) return 1;
      return a[0].localeCompare(b[0]);
    });

    return Promise.resolve(
      sortedRepos.map(([repo, codespaces]) => new RepositoryTreeItem(repo, codespaces))
    );
  }

  getCodespaceByName(name: string): Codespace | undefined {
    return this.codespaces.find((cs) => cs.name === name);
  }

  dispose(): void {
    this.stopPolling();
    this.stopBackgroundRefresh();
    this._onDidChangeTreeData.dispose();
  }
}
