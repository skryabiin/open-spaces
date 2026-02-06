import * as vscode from 'vscode';

export interface CodespaceTemplate {
  name: string;
  repo: string;
  branch?: string;
  machineType?: string;
  idleTimeoutMinutes?: number;
  displayName?: string;
}

/**
 * Returns all saved codespace templates from global config.
 */
export function getTemplates(): CodespaceTemplate[] {
  const config = vscode.workspace.getConfiguration('openSpaces');
  return config.get<CodespaceTemplate[]>('templates', []);
}

/**
 * Saves a new template to global config.
 */
export async function saveTemplate(template: CodespaceTemplate): Promise<void> {
  const config = vscode.workspace.getConfiguration('openSpaces');
  const templates = [...getTemplates()];
  templates.push(template);
  await config.update('templates', templates, vscode.ConfigurationTarget.Global);
}

/**
 * Removes a template by name from global config.
 */
export async function deleteTemplate(name: string): Promise<void> {
  const config = vscode.workspace.getConfiguration('openSpaces');
  const templates = getTemplates().filter((t) => t.name !== name);
  await config.update('templates', templates, vscode.ConfigurationTarget.Global);
}
