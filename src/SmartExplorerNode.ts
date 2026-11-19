import * as vscode from 'vscode';
import { WorkspaceEntry } from './types';

export interface SmartExplorerNodeOptions {
  contextValue: string;
  iconId?: string;
  iconUri?: vscode.Uri;
  description?: string;
  tooltip?: string;
  command?: vscode.Command;
  entry?: WorkspaceEntry;
}

export class SmartExplorerNode extends vscode.TreeItem {
  public readonly entry?: WorkspaceEntry;

  constructor(
    public readonly label: string,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState,
    options: SmartExplorerNodeOptions
  ) {
    super(label, collapsibleState);
    this.contextValue = options.contextValue;
    this.iconPath = options.iconUri ?? (options.iconId ? new vscode.ThemeIcon(options.iconId) : undefined);
    this.description = options.description;
    this.tooltip = options.tooltip;
    this.command = options.command;
    this.entry = options.entry;
  }
}
