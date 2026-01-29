import * as vscode from 'vscode';
import { Codespace, CodespaceState } from '../types';

function getStateIcon(state: CodespaceState): vscode.ThemeIcon {
  switch (state) {
    case 'Available':
      return new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('testing.iconPassed'));
    case 'Shutdown':
      return new vscode.ThemeIcon('circle-outline', new vscode.ThemeColor('disabledForeground'));
    case 'Starting':
    case 'Provisioning':
    case 'Rebuilding':
      return new vscode.ThemeIcon('sync~spin', new vscode.ThemeColor('progressBar.background'));
    case 'ShuttingDown':
    case 'Exporting':
    case 'Updating':
      return new vscode.ThemeIcon('sync~spin', new vscode.ThemeColor('disabledForeground'));
    case 'Failed':
    case 'Unavailable':
      return new vscode.ThemeIcon('error', new vscode.ThemeColor('testing.iconFailed'));
    default:
      return new vscode.ThemeIcon('circle-outline');
  }
}

function getStateDescription(state: CodespaceState): string {
  switch (state) {
    case 'Available':
      return 'Running';
    case 'Shutdown':
      return 'Stopped';
    case 'Starting':
      return 'Starting...';
    case 'ShuttingDown':
      return 'Stopping...';
    case 'Provisioning':
      return 'Provisioning...';
    case 'Rebuilding':
      return 'Rebuilding...';
    case 'Awaiting':
      return 'Awaiting...';
    case 'Unavailable':
      return 'Unavailable';
    case 'Failed':
      return 'Failed';
    case 'Exporting':
      return 'Exporting...';
    case 'Updating':
      return 'Updating...';
    default:
      return state;
  }
}

export class RepositoryTreeItem extends vscode.TreeItem {
  constructor(
    public readonly repository: string,
    public readonly codespaces: Codespace[]
  ) {
    super(repository, vscode.TreeItemCollapsibleState.Expanded);

    this.iconPath = new vscode.ThemeIcon('repo');
    this.contextValue = 'repository';
    this.description = `${codespaces.length} codespace${codespaces.length !== 1 ? 's' : ''}`;
  }

  getChildren(): CodespaceTreeItem[] {
    return this.codespaces.map((cs) => new CodespaceTreeItem(cs));
  }
}

export class CodespaceTreeItem extends vscode.TreeItem {
  constructor(public readonly codespace: Codespace) {
    super(codespace.displayName, vscode.TreeItemCollapsibleState.Collapsed);

    this.description = getStateDescription(codespace.state);
    this.iconPath = getStateIcon(codespace.state);
    this.tooltip = this.createTooltip();
    this.contextValue = `codespace-${codespace.state.toLowerCase()}`;
  }

  private createTooltip(): vscode.MarkdownString {
    const md = new vscode.MarkdownString();
    md.appendMarkdown(`**${this.codespace.displayName}**\n\n`);
    md.appendMarkdown(`- Repository: ${this.codespace.repository}\n`);
    md.appendMarkdown(`- Branch: ${this.codespace.branch || 'N/A'}\n`);
    md.appendMarkdown(`- State: ${this.codespace.state}\n`);
    md.appendMarkdown(`- Machine: ${this.codespace.machineName || 'N/A'}\n`);
    if (this.codespace.lastUsedAt) {
      const lastUsed = new Date(this.codespace.lastUsedAt);
      md.appendMarkdown(`- Last used: ${lastUsed.toLocaleString()}\n`);
    }
    return md;
  }

  getChildren(): CodespaceDetailItem[] {
    const children: CodespaceDetailItem[] = [];

    children.push(new CodespaceDetailItem('repo', this.codespace.repository, 'repo'));

    if (this.codespace.branch) {
      children.push(new CodespaceDetailItem('git-branch', this.codespace.branch, 'branch'));
    }

    // Show git status (changes)
    const gitStatus = this.codespace.gitStatus;
    if (gitStatus) {
      const statusParts: string[] = [];

      if (gitStatus.hasUncommittedChanges) {
        statusParts.push('uncommitted changes');
      }
      if (gitStatus.hasUnpushedChanges) {
        statusParts.push('unpushed commits');
      }
      if (gitStatus.ahead > 0) {
        statusParts.push(`${gitStatus.ahead} ahead`);
      }
      if (gitStatus.behind > 0) {
        statusParts.push(`${gitStatus.behind} behind`);
      }

      if (statusParts.length > 0) {
        children.push(
          new CodespaceDetailItem(
            'git-commit',
            statusParts.join(', '),
            'gitStatus',
            new vscode.ThemeColor('gitDecoration.modifiedResourceForeground')
          )
        );
      } else {
        children.push(new CodespaceDetailItem('check', 'No pending changes', 'gitStatus'));
      }
    }

    children.push(
      new CodespaceDetailItem('server-environment', this.codespace.machineName || 'Unknown', 'machine')
    );

    if (this.codespace.lastUsedAt) {
      const lastUsed = new Date(this.codespace.lastUsedAt);
      const timeAgo = getTimeAgo(lastUsed);
      children.push(new CodespaceDetailItem('clock', timeAgo, 'lastUsed'));
    }

    return children;
  }
}

export class CodespaceDetailItem extends vscode.TreeItem {
  constructor(
    iconId: string,
    label: string,
    public readonly detailType: string,
    iconColor?: vscode.ThemeColor
  ) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.iconPath = new vscode.ThemeIcon(iconId, iconColor);
    this.contextValue = 'codespace-detail';
  }
}

function getTimeAgo(date: Date): string {
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();

  // Handle clock skew or future dates
  if (diffMs < 0) {
    return 'Just now';
  }

  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffMins < 1) {
    return 'Just now';
  } else if (diffMins < 60) {
    return `${diffMins}m ago`;
  } else if (diffHours < 24) {
    return `${diffHours}h ago`;
  } else if (diffDays < 7) {
    return `${diffDays}d ago`;
  } else {
    return date.toLocaleDateString();
  }
}

export class GhNotInstalledTreeItem extends vscode.TreeItem {
  constructor() {
    super('GitHub CLI not installed', vscode.TreeItemCollapsibleState.None);

    this.iconPath = new vscode.ThemeIcon('error', new vscode.ThemeColor('testing.iconFailed'));
    this.tooltip = new vscode.MarkdownString(
      'GitHub CLI (gh) is required.\n\nInstall from: https://cli.github.com/'
    );
    this.contextValue = 'gh-not-installed';
    this.description = 'Install gh CLI';
  }
}

export class AuthRequiredTreeItem extends vscode.TreeItem {
  constructor(message?: string) {
    super('Authentication required', vscode.TreeItemCollapsibleState.None);

    this.iconPath = new vscode.ThemeIcon('key', new vscode.ThemeColor('problemsWarningIcon.foreground'));
    this.tooltip = new vscode.MarkdownString(
      message || 'Run `gh auth login --scopes codespace` to authenticate'
    );
    this.contextValue = 'auth-required';
    this.description = 'Click to authenticate';
    this.command = {
      command: 'openSpaces.openAuthTerminal',
      title: 'Authenticate',
    };
  }
}

export class NoCodespacesTreeItem extends vscode.TreeItem {
  constructor() {
    super('No codespaces found', vscode.TreeItemCollapsibleState.None);

    this.iconPath = new vscode.ThemeIcon('info');
    this.tooltip = new vscode.MarkdownString(
      'No codespaces found for your account.\n\nCreate one at https://github.com/codespaces'
    );
    this.contextValue = 'no-codespaces';
    this.description = 'Create one on GitHub';
  }
}

export class LoadingTreeItem extends vscode.TreeItem {
  constructor() {
    super('Loading codespaces...', vscode.TreeItemCollapsibleState.None);

    this.iconPath = new vscode.ThemeIcon('sync~spin');
    this.contextValue = 'loading';
  }
}

export class ErrorTreeItem extends vscode.TreeItem {
  constructor(message: string) {
    super('Error', vscode.TreeItemCollapsibleState.None);

    this.iconPath = new vscode.ThemeIcon('error', new vscode.ThemeColor('testing.iconFailed'));
    this.tooltip = message;
    this.description = message;
    this.contextValue = 'error';
  }
}
