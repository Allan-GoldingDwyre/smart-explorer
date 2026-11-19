import * as vscode from 'vscode';
import { getLinearToken } from './auth';
import { fetchRefTitle } from './refs';
import { SmartExplorerNode } from './SmartExplorerNode';
import { TYPE_ICONS, WorkspaceEntry, truncate } from './types';
import { runAddWorkspaceFlow } from './workspaceForm';

const WORKSPACES_KEY = 'smartExplorer.workspaces';

export class SmartExplorerProvider implements vscode.TreeDataProvider<SmartExplorerNode> {
  private _onDidChangeTreeData = new vscode.EventEmitter<SmartExplorerNode | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private workspaces: WorkspaceEntry[];

  constructor(private context: vscode.ExtensionContext) {
    this.workspaces = context.workspaceState.get<WorkspaceEntry[]>(WORKSPACES_KEY, []);
  }

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  async addWorkspace(): Promise<void> {
    const entry = await runAddWorkspaceFlow(this.context);
    if (!entry) {
      return;
    }
    if (this.workspaces.some((w) => w.type === entry.type && w.ref === entry.ref)) {
      vscode.window.showWarningMessage(`Ce workspace existe déjà : ${entry.name} (${entry.ref})`);
      return;
    }
    this.workspaces.push(entry);
    await this.save();
    this.refresh();
  }

  async renameWorkspace(node: SmartExplorerNode | undefined): Promise<void> {
    const entry = node?.entry;
    if (!entry) {
      return;
    }
    const name = await vscode.window.showInputBox({
      title: 'Rename Workspace',
      prompt: 'Nouveau nom du workspace',
      value: entry.name
    });
    if (!name || name === entry.name) {
      return;
    }
    entry.name = name;
    await this.save();
    this.refresh();
  }

  async deleteWorkspace(node: SmartExplorerNode): Promise<void> {
    const entry = node.entry;
    if (!entry) {
      return;
    }
    const confirm = await vscode.window.showWarningMessage(
      `Supprimer le workspace "${entry.name}" ?`,
      { modal: true },
      'Supprimer'
    );
    if (confirm !== 'Supprimer') {
      return;
    }
    this.workspaces = this.workspaces.filter((w) => w !== entry);
    await this.save();
    this.refresh();
  }

  async addInstruction(node: SmartExplorerNode): Promise<void> {
    const entry = node.entry;
    if (!entry) {
      return;
    }
    const instruction = await vscode.window.showInputBox({
      title: 'Add Instruction',
      prompt: `Instruction liée au workspace "${entry.name}"`,
      placeHolder: 'Ex : se concentrer sur la logique métier, ignorer les tests...'
    });
    if (!instruction) {
      return;
    }
    entry.instructions = [...(entry.instructions ?? []), instruction];
    await this.save();
    this.refresh();
  }

  // Relance la résolution du workspace (titre à jour via l'API) — le run de
  // l'agent Mistral arrivera ici plus tard.
  async refreshWorkspace(node: SmartExplorerNode): Promise<void> {
    const entry = node.entry;
    if (!entry) {
      return;
    }
    const title = await fetchRefTitle(entry.type, entry.ref, this.context);
    if (title && title !== entry.name) {
      entry.name = truncate(title, 60);
      await this.save();
    }
    this.refresh();
    vscode.window.showInformationMessage(`Workspace "${entry.name}" rafraîchi.`);
  }

  private async save(): Promise<void> {
    await this.context.workspaceState.update(WORKSPACES_KEY, this.workspaces);
  }

  getTreeItem(element: SmartExplorerNode): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: SmartExplorerNode): Promise<SmartExplorerNode[]> {
    if (element || this.workspaces.length === 0) {
      return [];
    }
    const nodes: SmartExplorerNode[] = [];
    if (!(await getLinearToken(this.context))) {
      nodes.push(
        new SmartExplorerNode('Setup Linear', vscode.TreeItemCollapsibleState.None, {
          contextValue: 'action-linear',
          iconId: 'key',
          command: { command: 'smartExplorer.setupLinear', title: 'Setup Linear' }
        })
      );
    }
    nodes.push(
      ...this.workspaces.map(
        (w) =>
          new SmartExplorerNode(w.name, vscode.TreeItemCollapsibleState.None, {
            contextValue: `workspace-${w.type}`,
            iconId: TYPE_ICONS[w.type],
            description: truncate(w.ref),
            tooltip: [`${w.type}: ${w.ref}`, ...(w.instructions ?? [])].join('\n'),
            entry: w
          })
      )
    );
    return nodes;
  }
}
