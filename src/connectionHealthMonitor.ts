import * as vscode from 'vscode';
import { runGh } from './ghCli';

/**
 * Periodically checks SSH connectivity to the connected codespace.
 * Shows a warning notification when the connection is lost.
 */
export class ConnectionHealthMonitor implements vscode.Disposable {
  private timer: NodeJS.Timeout | null = null;
  private consecutiveFailures = 0;
  private readonly maxFailures = 3;

  constructor(
    private codespaceName: string,
    private intervalMs: number
  ) {}

  start(): void {
    this.timer = setInterval(() => void this.check(), this.intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async check(): Promise<void> {
    try {
      await runGh(['codespace', 'ssh', '-c', this.codespaceName, '--', 'echo', 'ok'], 10000);
      this.consecutiveFailures = 0;
    } catch {
      this.consecutiveFailures++;
      if (this.consecutiveFailures >= this.maxFailures) {
        this.stop();
        this.showDisconnectedNotification();
      }
    }
  }

  private showDisconnectedNotification(): void {
    void vscode.window
      .showWarningMessage(
        vscode.l10n.t('Connection to codespace {0} appears to be lost.', this.codespaceName),
        vscode.l10n.t('Reconnect'),
        vscode.l10n.t('Disconnect')
      )
      .then((selection) => {
        if (selection === vscode.l10n.t('Reconnect')) {
          this.consecutiveFailures = 0;
          this.start();
        } else if (selection === vscode.l10n.t('Disconnect')) {
          void vscode.commands.executeCommand('workbench.action.remote.close');
        }
      });
  }

  dispose(): void {
    this.stop();
  }
}
