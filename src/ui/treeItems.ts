import * as vscode from 'vscode';
import { Codespace, CodespaceState } from '../types';
import { formatBytes, formatMachineSpecs, getTimeAgo, getIdleTimeRemaining } from '../utils/formatting';

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
      return vscode.l10n.t('Running');
    case 'Shutdown':
      return vscode.l10n.t('Stopped');
    case 'Starting':
      return vscode.l10n.t('Starting...');
    case 'ShuttingDown':
      return vscode.l10n.t('Stopping...');
    case 'Provisioning':
      return vscode.l10n.t('Provisioning...');
    case 'Rebuilding':
      return vscode.l10n.t('Rebuilding...');
    case 'Awaiting':
      return vscode.l10n.t('Awaiting...');
    case 'Unavailable':
      return vscode.l10n.t('Unavailable');
    case 'Failed':
      return vscode.l10n.t('Failed');
    case 'Exporting':
      return vscode.l10n.t('Exporting...');
    case 'Updating':
      return vscode.l10n.t('Updating...');
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
    this.description = codespaces.length === 1
      ? vscode.l10n.t('{0} codespace', codespaces.length)
      : vscode.l10n.t('{0} codespaces', codespaces.length);
  }

  getChildren(): CodespaceTreeItem[] {
    return this.codespaces.map((cs) => new CodespaceTreeItem(cs));
  }
}

export class CodespaceTreeItem extends vscode.TreeItem {
  constructor(public readonly codespace: Codespace, connected = false) {
    super(
      codespace.displayName,
      connected ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed
    );

    this.description = connected ? vscode.l10n.t('Connected') : getStateDescription(codespace.state);
    this.iconPath = getStateIcon(codespace.state);
    this.tooltip = this.createTooltip();
    this.contextValue = connected ? 'codespace-connected' : `codespace-${codespace.state.toLowerCase()}`;
  }

  private createTooltip(): vscode.MarkdownString {
    const md = new vscode.MarkdownString();
    md.appendMarkdown(`**${this.codespace.displayName}**\n\n`);
    md.appendMarkdown(`- ${vscode.l10n.t('Repository: {0}', this.codespace.repository)}\n`);
    md.appendMarkdown(`- ${vscode.l10n.t('Branch: {0}', this.codespace.branch || vscode.l10n.t('N/A'))}\n`);
    md.appendMarkdown(`- ${vscode.l10n.t('State: {0}', this.codespace.state)}\n`);
    if (this.codespace.machineInfo) {
      md.appendMarkdown(`- ${vscode.l10n.t('Machine: {0}', formatMachineSpecs(this.codespace.machineInfo))}\n`);
      if (this.codespace.machineInfo.storageInBytes > 0) {
        md.appendMarkdown(`- ${vscode.l10n.t('Storage: {0}', formatBytes(this.codespace.machineInfo.storageInBytes))}\n`);
      }
    } else {
      md.appendMarkdown(`- ${vscode.l10n.t('Machine: {0}', this.codespace.machineName || vscode.l10n.t('N/A'))}\n`);
    }
    if (this.codespace.lastUsedAt) {
      const lastUsed = new Date(this.codespace.lastUsedAt);
      md.appendMarkdown(`- ${vscode.l10n.t('Last used: {0}', lastUsed.toLocaleString())}\n`);
    }
    if (this.codespace.state === 'Available' && this.codespace.idleTimeoutMinutes) {
      const idleInfo = getIdleTimeRemaining(
        this.codespace.lastUsedAt,
        this.codespace.idleTimeoutMinutes
      );
      if (idleInfo) {
        md.appendMarkdown(`- ${idleInfo.text}\n`);
      } else {
        const mins = this.codespace.idleTimeoutMinutes;
        const text = mins >= 60
          ? vscode.l10n.t('Idle timeout: {0}h', Math.floor(mins / 60))
          : vscode.l10n.t('Idle timeout: {0}m', mins);
        md.appendMarkdown(`- ${text}\n`);
      }
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
        statusParts.push(vscode.l10n.t('uncommitted changes'));
      }
      if (gitStatus.hasUnpushedChanges) {
        statusParts.push(vscode.l10n.t('unpushed commits'));
      }
      if (gitStatus.ahead > 0) {
        statusParts.push(vscode.l10n.t('{0} ahead', gitStatus.ahead));
      }
      if (gitStatus.behind > 0) {
        statusParts.push(vscode.l10n.t('{0} behind', gitStatus.behind));
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
        children.push(new CodespaceDetailItem('check', vscode.l10n.t('No pending changes'), 'gitStatus'));
      }
    }

    // Display machine specs if available, otherwise fall back to machine name
    if (this.codespace.machineInfo) {
      const specs = formatMachineSpecs(this.codespace.machineInfo);
      children.push(new CodespaceDetailItem('server-environment', specs, 'machine'));
      // Show storage as a separate detail if available
      if (this.codespace.machineInfo.storageInBytes > 0) {
        children.push(
          new CodespaceDetailItem(
            'database',
            vscode.l10n.t('{0} storage', formatBytes(this.codespace.machineInfo.storageInBytes)),
            'storage'
          )
        );
      }
    } else {
      children.push(
        new CodespaceDetailItem('server-environment', this.codespace.machineName || vscode.l10n.t('Unknown'), 'machine')
      );
    }

    if (this.codespace.lastUsedAt) {
      const lastUsed = new Date(this.codespace.lastUsedAt);
      const timeAgo = getTimeAgo(lastUsed);
      children.push(new CodespaceDetailItem('clock', timeAgo, 'lastUsed'));
    }

    // Show idle timeout remaining for running codespaces
    if (this.codespace.state === 'Available' && this.codespace.idleTimeoutMinutes) {
      const idleInfo = getIdleTimeRemaining(
        this.codespace.lastUsedAt,
        this.codespace.idleTimeoutMinutes
      );
      if (idleInfo) {
        children.push(
          new CodespaceDetailItem(
            'watch',
            idleInfo.text,
            'idleTimeout',
            idleInfo.isLow ? new vscode.ThemeColor('editorWarning.foreground') : undefined
          )
        );
      } else {
        // Fallback: show idle timeout value without countdown
        const mins = this.codespace.idleTimeoutMinutes;
        const text = mins >= 60
          ? vscode.l10n.t('Idle timeout: {0}h', Math.floor(mins / 60))
          : vscode.l10n.t('Idle timeout: {0}m', mins);
        children.push(new CodespaceDetailItem('watch', text, 'idleTimeout'));
      }
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

export class GhNotInstalledTreeItem extends vscode.TreeItem {
  constructor() {
    super(vscode.l10n.t('GitHub CLI not installed'), vscode.TreeItemCollapsibleState.None);

    this.iconPath = new vscode.ThemeIcon('error', new vscode.ThemeColor('testing.iconFailed'));
    this.tooltip = new vscode.MarkdownString(
      vscode.l10n.t('GitHub CLI (gh) is required.\n\nInstall from: https://cli.github.com/')
    );
    this.contextValue = 'gh-not-installed';
    this.description = vscode.l10n.t('Install gh CLI');
  }
}

export class AuthRequiredTreeItem extends vscode.TreeItem {
  constructor(message?: string) {
    super(vscode.l10n.t('Authentication required'), vscode.TreeItemCollapsibleState.None);

    this.iconPath = new vscode.ThemeIcon('key', new vscode.ThemeColor('problemsWarningIcon.foreground'));
    this.tooltip = new vscode.MarkdownString(
      message || vscode.l10n.t('Run `gh auth login --scopes codespace` to authenticate')
    );
    this.contextValue = 'auth-required';
    this.description = vscode.l10n.t('Click to authenticate');
    this.command = {
      command: 'openSpaces.openAuthTerminal',
      title: 'Authenticate',
    };
  }
}

export class ScopeRequiredTreeItem extends vscode.TreeItem {
  constructor() {
    super(vscode.l10n.t('Codespace scope required'), vscode.TreeItemCollapsibleState.None);

    this.iconPath = new vscode.ThemeIcon('shield', new vscode.ThemeColor('problemsWarningIcon.foreground'));
    this.tooltip = new vscode.MarkdownString(
      vscode.l10n.t('Your GitHub token needs the `codespace` scope to access codespaces.\n\nClick to add the scope.')
    );
    this.contextValue = 'scope-required';
    this.description = vscode.l10n.t('Click to add scope');
    this.command = {
      command: 'openSpaces.addCodespaceScope',
      title: vscode.l10n.t('Add Scope'),
    };
  }
}

export class NoCodespacesTreeItem extends vscode.TreeItem {
  constructor() {
    super(vscode.l10n.t('No codespaces found'), vscode.TreeItemCollapsibleState.None);

    this.iconPath = new vscode.ThemeIcon('info');
    this.tooltip = new vscode.MarkdownString(
      vscode.l10n.t('No codespaces found for your account.\n\nCreate one at https://github.com/codespaces')
    );
    this.contextValue = 'no-codespaces';
    this.description = vscode.l10n.t('Create one on GitHub');
  }
}

export class LoadingTreeItem extends vscode.TreeItem {
  constructor() {
    super(vscode.l10n.t('Loading codespaces...'), vscode.TreeItemCollapsibleState.None);

    this.iconPath = new vscode.ThemeIcon('sync~spin');
    this.contextValue = 'loading';
  }
}

export class ErrorTreeItem extends vscode.TreeItem {
  constructor(message: string) {
    super(vscode.l10n.t('Error'), vscode.TreeItemCollapsibleState.None);

    this.iconPath = new vscode.ThemeIcon('error', new vscode.ThemeColor('testing.iconFailed'));
    this.tooltip = message;
    this.description = message;
    this.contextValue = 'error';
  }
}
