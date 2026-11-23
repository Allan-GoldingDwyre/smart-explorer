import * as vscode from 'vscode';
import { FileTreeNode } from '../core/types';
import { VirtualDir, WorkspaceFile } from '../core/workspaceStore';

export interface SmartExplorerNodeOptions {
  // Identifiant stable (même élément = même id d'un rendu à l'autre) : permet
  // à TreeView.reveal de retrouver un noeud recréé.
  id?: string;
  parent?: SmartExplorerNode;
  contextValue: string;
  iconId?: string;
  // Si renseigné, VS Code applique dessus le thème d'icônes de fichiers
  // choisi par l'utilisateur (Material Icon Theme, etc.).
  resourceUri?: vscode.Uri;
  description?: string;
  tooltip?: string;
  command?: vscode.Command;
  fileNode?: FileTreeNode;
  // Workspace du store YAML (créé par l'agent via les tools MCP).
  workspaceFile?: WorkspaceFile;
  // Virtual dir de l'arbre de l'agent (rendu avec un codicon).
  virtualDir?: VirtualDir;
}

export class SmartExplorerNode extends vscode.TreeItem {
  public readonly fileNode?: FileTreeNode;
  public readonly workspaceFile?: WorkspaceFile;
  public readonly virtualDir?: VirtualDir;
  public readonly parent?: SmartExplorerNode;

  constructor(
    public readonly label: string,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState,
    options: SmartExplorerNodeOptions,
  ) {
    super(label, collapsibleState);
    this.id = options.id;
    this.parent = options.parent;
    this.contextValue = options.contextValue;
    this.iconPath = options.iconId
      ? new vscode.ThemeIcon(options.iconId)
      : undefined;
    this.resourceUri = options.resourceUri;
    this.description = options.description;
    this.tooltip = options.tooltip;
    this.command = options.command;
    this.fileNode = options.fileNode;
    this.workspaceFile = options.workspaceFile;
    this.virtualDir = options.virtualDir;
  }
}
