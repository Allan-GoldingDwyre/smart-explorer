import * as vscode from 'vscode';
import { getLinearToken } from './auth';
import { fetchRefTitle } from './refs';
import { SmartExplorerNode } from './SmartExplorerNode';
import { FileTreeNode, TYPE_ICONS, WorkspaceEntry, truncate } from './types';
import { runAddWorkspaceFlow } from './workspaceForm';

const WORKSPACES_KEY = 'smartExplorer.workspaces';
const IGNORED_DIRS = new Set(['node_modules', '.git', 'out', 'dist']);

export class SmartExplorerProvider
  implements vscode.TreeDataProvider<SmartExplorerNode>
{
  private _onDidChangeTreeData = new vscode.EventEmitter<
    SmartExplorerNode | undefined
  >();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private workspaces: WorkspaceEntry[];
  private fileTreeCache = new Map<string, FileTreeNode[]>();

  constructor(private context: vscode.ExtensionContext) {
    this.workspaces = context.workspaceState.get<WorkspaceEntry[]>(
      WORKSPACES_KEY,
      [],
    );
  }

  refresh(): void {
    this.fileTreeCache.clear();
    this._onDidChangeTreeData.fire(undefined);
  }

  async addWorkspace(): Promise<void> {
    const entry = await runAddWorkspaceFlow(this.context);
    if (!entry) {
      return;
    }
    if (
      this.workspaces.some((w) => w.type === entry.type && w.ref === entry.ref)
    ) {
      vscode.window.showWarningMessage(
        `Ce workspace existe déjà : ${entry.name} (${entry.ref})`,
      );
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
      value: entry.name,
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
      'Supprimer',
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
      placeHolder:
        'Ex : se concentrer sur la logique métier, ignorer les tests...',
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
    vscode.window.showInformationMessage(
      `Workspace "${entry.name}" rafraîchi.`,
    );
  }

  // Révèle le fichier dans le vrai panel Explorer (sélectionné dans l'arbre).
  async revealInExplorer(node: SmartExplorerNode): Promise<void> {
    const file = node.fileNode;
    if (!file || file.type !== 'file') {
      return;
    }
    const root = vscode.workspace.workspaceFolders?.[0]?.uri;
    const uri = root
      ? vscode.Uri.joinPath(root, file.path)
      : vscode.Uri.file(file.path);
    await vscode.commands.executeCommand('revealInExplorer', uri);
  }

  private async save(): Promise<void> {
    await this.context.workspaceState.update(WORKSPACES_KEY, this.workspaces);
  }

  getTreeItem(element: SmartExplorerNode): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: SmartExplorerNode): Promise<SmartExplorerNode[]> {
    if (!element) {
      return this.getRootChildren();
    }
    if (element.entry) {
      return this.getWorkspaceChildren(element.entry);
    }
    if (element.fileNode) {
      return (element.fileNode.children ?? []).map((n) => this.toFileNode(n));
    }
    return [];
  }

  private async getRootChildren(): Promise<SmartExplorerNode[]> {
    const nodes: SmartExplorerNode[] = [];
    if (!(await getLinearToken(this.context))) {
      nodes.push(
        new SmartExplorerNode(
          'Setup Linear',
          vscode.TreeItemCollapsibleState.None,
          {
            contextValue: 'action-linear',
            iconId: 'key',
            command: {
              command: 'smartExplorer.setupLinear',
              title: 'Setup Linear',
            },
          },
        ),
      );
    }
    nodes.push(
      ...this.workspaces.map(
        (w) =>
          new SmartExplorerNode(
            w.name,
            vscode.TreeItemCollapsibleState.Collapsed,
            {
              contextValue: `workspace-${w.type}`,
              iconId: TYPE_ICONS[w.type],
              description: truncate(w.ref),
              tooltip: [`${w.type}: ${w.ref}`, ...(w.instructions ?? [])].join(
                '\n',
              ),
              entry: w,
            },
          ),
      ),
    );
    return nodes;
  }

  // Enfants d'un workspace : l'arbre virtuel de l'agent s'il existe,
  // sinon l'arbre physique du projet.
  private async getWorkspaceChildren(
    entry: WorkspaceEntry,
  ): Promise<SmartExplorerNode[]> {
    const tree = entry.tree ?? (await this.buildProjectTree());
    return tree.map((n) => this.toFileNode(n));
  }

  private toFileNode(n: FileTreeNode): SmartExplorerNode {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri;
    const abs = root
      ? vscode.Uri.joinPath(root, n.path)
      : vscode.Uri.parse(n.path);
    const isFolder = n.type !== 'file';
    return new SmartExplorerNode(
      n.name,
      isFolder
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None,
      {
        contextValue: isFolder ? 'folder' : 'file',
        resourceUri: abs,
        fileNode: n,
        command: isFolder
          ? undefined
          : { command: 'vscode.open', title: 'Open', arguments: [abs] },
      },
    );
  }

  private async buildProjectTree(): Promise<FileTreeNode[]> {
    const root = vscode.workspace.workspaceFolders?.[0];
    if (!root) {
      return [];
    }
    const cached = this.fileTreeCache.get(root.uri.fsPath);
    if (cached) {
      return cached;
    }
    const tree = await this.readDir(root.uri, '');
    this.fileTreeCache.set(root.uri.fsPath, tree);
    return tree;
  }

  private async readDir(
    dirUri: vscode.Uri,
    rel: string,
  ): Promise<FileTreeNode[]> {
    let entries: [string, vscode.FileType][];
    try {
      entries = await vscode.workspace.fs.readDirectory(dirUri);
    } catch {
      return [];
    }
    const nodes: FileTreeNode[] = [];
    for (const [name, type] of entries) {
      if (type === vscode.FileType.Directory && IGNORED_DIRS.has(name)) {
        continue;
      }
      const childRel = rel ? `${rel}/${name}` : name;
      if (type === vscode.FileType.Directory) {
        nodes.push({
          name,
          path: childRel,
          type: 'folder',
          children: await this.readDir(
            vscode.Uri.joinPath(dirUri, name),
            childRel,
          ),
        });
      } else {
        nodes.push({ name, path: childRel, type: 'file' });
      }
    }
    nodes.sort((a, b) =>
      a.type === b.type
        ? a.name.localeCompare(b.name)
        : a.type === 'folder' || a.type === 'virtualFolder'
          ? -1
          : 1,
    );
    return nodes;
  }
}
