import * as vscode from 'vscode';
import { getLinearToken } from './auth';
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
    await this.context.workspaceState.update(WORKSPACES_KEY, this.workspaces);
    this.refresh();
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
            tooltip: `${w.type}: ${w.ref}`
          })
      )
    );
    return nodes;
  }
}
