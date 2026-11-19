import * as vscode from 'vscode';
import { FileTreeNode, WorkspaceEntry } from './types';
import { VirtualDir, WorkspaceFile } from './workspaceStore';

export interface SmartExplorerNodeOptions {
  contextValue: string;
  iconId?: string;
  iconUri?: vscode.Uri;
  // Si renseigné, VS Code applique dessus le thème d'icônes de fichiers
  // choisi par l'utilisateur (Material Icon Theme, etc.).
  resourceUri?: vscode.Uri;
  description?: string;
  tooltip?: string;
  command?: vscode.Command;
  entry?: WorkspaceEntry;
  fileNode?: FileTreeNode;
  // Workspace du store YAML (créé via les tools MCP).
  workspaceFile?: WorkspaceFile;
  // Virtual dir de l'arbre de l'agent (rendu avec un codicon).
  virtualDir?: VirtualDir;
}

export class SmartExplorerNode extends vscode.TreeItem {
  public readonly entry?: WorkspaceEntry;
  public readonly fileNode?: FileTreeNode;
  public readonly workspaceFile?: WorkspaceFile;
  public readonly virtualDir?: VirtualDir;

  constructor(
    public readonly label: string,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState,
    options: SmartExplorerNodeOptions,
  ) {
    super(label, collapsibleState);
    this.contextValue = options.contextValue;
    this.iconPath =
      options.iconUri ??
      (options.iconId ? new vscode.ThemeIcon(options.iconId) : undefined);
    this.resourceUri = options.resourceUri;
    this.description = options.description;
    this.tooltip = options.tooltip;
    this.command = options.command;
    this.entry = options.entry;
    this.fileNode = options.fileNode;
    this.workspaceFile = options.workspaceFile;
    this.virtualDir = options.virtualDir;
  }
}
