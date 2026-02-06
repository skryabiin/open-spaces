import * as vscode from 'vscode';
import * as ghCli from '../ghCli';
import * as codespaceManager from '../codespaceManager';
import { Codespace, GhCliError } from '../types';
import { isTransitionalState } from '../constants';
import { ensureError } from '../utils/errors';
import { findStaleCodespaces } from '../staleDetector';
import {
  RepositoryTreeItem,
  CodespaceTreeItem,
  CodespaceDetailItem,
  GhNotInstalledTreeItem,
  AuthRequiredTreeItem,
  ScopeRequiredTreeItem,
  NoCodespacesTreeItem,
  LoadingTreeItem,
  ErrorTreeItem,
  NoFilterResultsTreeItem,
} from './treeItems';

type TreeItem =
  | RepositoryTreeItem
  | CodespaceTreeItem
  | CodespaceDetailItem
  | GhNotInstalledTreeItem
  | AuthRequiredTreeItem
  | ScopeRequiredTreeItem
  | NoCodespacesTreeItem
  | LoadingTreeItem
  | ErrorTreeItem
  | NoFilterResultsTreeItem;

export class CodespaceTreeProvider implements vscode.TreeDataProvider<TreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<TreeItem | undefined | null | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private codespaces: Codespace[] = [];
  private loading = true;
  private error: GhCliError | Error | null = null;
  private ghInstalled = true;
  private authenticated = true;
  private hasCodespaceScope = true;

  private isPolling = false;
  private pollTimer: NodeJS.Timeout | null = null;
  private pollInterval: number;

  private backgroundRefreshTimer: NodeJS.Timeout | null = null;
  private backgroundRefreshInterval: number;
  private isVisible = false;

  private connectedCodespaceName: string | undefined;

  // Filter state
  private filterText = '';
  private filterState: 'all' | 'running' | 'stopped' = 'all';

  constructor() {
    const config = vscode.workspace.getConfiguration('openSpaces');
    this.pollInterval = config.get<number>('pollingInterval', 5000);
    this.backgroundRefreshInterval = config.get<number>('backgroundRefreshInterval', 60000);

    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('openSpaces.pollingInterval')) {
        this.pollInterval = vscode.workspace
          .getConfiguration('openSpaces')
          .get<number>('pollingInterval', 5000);
      }
      if (e.affectsConfiguration('openSpaces.backgroundRefreshInterval')) {
        this.backgroundRefreshInterval = vscode.workspace
          .getConfiguration('openSpaces')
          .get<number>('backgroundRefreshInterval', 60000);
        this.stopBackgroundRefresh();
        if (this.isVisible) {
          this.startBackgroundRefresh();
        }
      }
    });
  }

  setConnectedCodespace(name: string): void {
    this.connectedCodespaceName = name;
  }

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
        this.hasCodespaceScope = prereq.hasCodespaceScope;
        this.error = prereq.error || null;
        this.codespaces = [];
        this.loading = false;
        this._onDidChangeTreeData.fire();
        return;
      }

      this.ghInstalled = true;
      this.authenticated = true;
      this.hasCodespaceScope = true;

      // Load codespaces
      if (this.connectedCodespaceName) {
        const cs = await ghCli.getCodespace(this.connectedCodespaceName);
        this.codespaces = cs ? [cs] : [];
      } else {
        this.codespaces = await ghCli.listCodespaces();
      }

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

    if (!this.hasCodespaceScope) {
      return Promise.resolve([new ScopeRequiredTreeItem()]);
    }

    if (this.error) {
      return Promise.resolve([new ErrorTreeItem(this.error.message)]);
    }

    if (this.codespaces.length === 0) {
      return Promise.resolve([new NoCodespacesTreeItem()]);
    }

    // When connected to a codespace, show it directly without repo grouping
    if (this.connectedCodespaceName) {
      return Promise.resolve(
        this.codespaces.map((cs) => new CodespaceTreeItem(cs, true))
      );
    }

    // Apply filters
    const filteredCodespaces = this.applyFilters(this.codespaces);

    if (filteredCodespaces.length === 0 && this.hasActiveFilters()) {
      return Promise.resolve([new NoFilterResultsTreeItem()]);
    }

    // Compute stale codespace names
    const config = vscode.workspace.getConfiguration('openSpaces');
    const staleThreshold = config.get<number>('staleThresholdDays', 14);
    const staleCodespaces = findStaleCodespaces(filteredCodespaces, staleThreshold);
    const staleNames = new Set(staleCodespaces.map((cs) => cs.name));

    // Group codespaces by repository
    const repoMap = new Map<string, Codespace[]>();
    for (const cs of filteredCodespaces) {
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
      sortedRepos.map(([repo, codespaces]) => new RepositoryTreeItem(repo, codespaces, staleNames))
    );
  }

  getCodespaceByName(name: string): Codespace | undefined {
    return this.codespaces.find((cs) => cs.name === name);
  }

  getAllCodespaces(): Codespace[] {
    return this.codespaces;
  }

  getConnectedCodespace(): Codespace | undefined {
    if (!this.connectedCodespaceName) {
      return undefined;
    }
    return this.codespaces.find((cs) => cs.name === this.connectedCodespaceName);
  }

  setFilterText(text: string): void {
    this.filterText = text.toLowerCase();
    this._onDidChangeTreeData.fire();
  }

  setFilterState(state: 'all' | 'running' | 'stopped'): void {
    this.filterState = state;
    this._onDidChangeTreeData.fire();
  }

  clearFilters(): void {
    this.filterText = '';
    this.filterState = 'all';
    this._onDidChangeTreeData.fire();
  }

  private applyFilters(codespaces: Codespace[]): Codespace[] {
    let filtered = codespaces;

    if (this.filterState === 'running') {
      filtered = filtered.filter((cs) => cs.state === 'Available');
    } else if (this.filterState === 'stopped') {
      filtered = filtered.filter((cs) => cs.state === 'Shutdown');
    }

    if (this.filterText) {
      filtered = filtered.filter(
        (cs) =>
          cs.displayName.toLowerCase().includes(this.filterText) ||
          cs.repository.toLowerCase().includes(this.filterText) ||
          cs.branch.toLowerCase().includes(this.filterText)
      );
    }

    return filtered;
  }

  private hasActiveFilters(): boolean {
    return this.filterText !== '' || this.filterState !== 'all';
  }

  dispose(): void {
    this.stopPolling();
    this.stopBackgroundRefresh();
    this._onDidChangeTreeData.dispose();
  }
}
