import * as path from 'path';
import * as vscode from 'vscode';
import { SmartExplorerNode } from './SmartExplorerNode';
import { TYPE_ICONS, truncate } from './types';
import {
  VirtualDir,
  WorkspaceFile,
  dedupeTree,
  deleteWorkspace as deleteWorkspaceFile,
  listWorkspaces,
  readActive,
  saveWorkspace,
} from './workspaceStore';

export class SmartExplorerProvider
  implements vscode.TreeDataProvider<SmartExplorerNode>
{
  private _onDidChangeTreeData = new vscode.EventEmitter<
    SmartExplorerNode | undefined
  >();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  // Workspaces du projet ouvert (store YAML partagé avec les tools MCP).
  private workspaces: WorkspaceFile[] = [];
  private activeId?: string;

  constructor() {
    this.reloadFromDisk();
  }

  private projectRoot(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  }

  // Recharge workspaces et workspace actif depuis le disque (appelé aussi par
  // le watcher quand un agent écrit via les tools MCP).
  reloadFromDisk(): void {
    const root = this.projectRoot();
    this.workspaces = root ? listWorkspaces(root) : [];
    // Un actif périmé (workspace supprimé) est ignoré : la vue ne reste pas vide.
    const active = root ? readActive(root) : undefined;
    this.activeId = this.workspaces.some((w) => w.id === active)
      ? active
      : undefined;
  }

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  async renameWorkspace(node: SmartExplorerNode | undefined): Promise<void> {
    const ws = node?.workspaceFile;
    if (!ws) {
      return;
    }
    const name = await vscode.window.showInputBox({
      title: 'Rename Workspace',
      prompt: 'Nouveau nom du workspace',
      value: ws.name,
    });
    if (!name) {
      return;
    }
    ws.name = name;
    this.persist(ws);
    this.refresh();
  }

  // Supprime le workspace et ses données (fichier YAML).
  async deleteWorkspace(node: SmartExplorerNode): Promise<void> {
    const ws = node.workspaceFile;
    const root = this.projectRoot();
    if (!ws || !root) {
      return;
    }
    const confirm = await vscode.window.showWarningMessage(
      `Supprimer le workspace "${ws.name ?? ws.id}" et ses données ?`,
      { modal: true },
      'Supprimer',
    );
    if (confirm !== 'Supprimer') {
      return;
    }
    deleteWorkspaceFile(root, ws.id);
    this.reloadFromDisk();
    this.refresh();
  }

  async addInstruction(node: SmartExplorerNode): Promise<void> {
    const ws = node.workspaceFile;
    if (!ws) {
      return;
    }
    const instruction = await vscode.window.showInputBox({
      title: 'Add Instruction',
      prompt: `Besoin lié au workspace "${ws.name ?? ws.id}"`,
      placeHolder: 'Ex : relire la migration serde, ignorer les tests…',
    });
    if (!instruction) {
      return;
    }
    ws.instructions = [...(ws.instructions ?? []), instruction];
    this.persist(ws);
    this.refresh();
  }

  // Révèle le fichier dans le vrai panel Explorer (sélectionné dans l'arbre).
  async revealInExplorer(node: SmartExplorerNode): Promise<void> {
    const file = node.fileNode;
    if (!file || file.type !== 'file') {
      return;
    }
    await vscode.commands.executeCommand(
      'revealInExplorer',
      this.fileUri(file.path),
    );
  }

  private fileUri(relPath: string): vscode.Uri {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri;
    return root ? vscode.Uri.joinPath(root, relPath) : vscode.Uri.file(relPath);
  }

  private persist(ws: WorkspaceFile): void {
    const root = this.projectRoot();
    if (!root) {
      return;
    }
    try {
      saveWorkspace(root, ws);
      this.reloadFromDisk();
    } catch {
      // best-effort
    }
  }

  getTreeItem(element: SmartExplorerNode): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: SmartExplorerNode): Promise<SmartExplorerNode[]> {
    if (!element) {
      return this.getRootChildren();
    }
    if (element.workspaceFile) {
      return this.getWorkspaceChildren(element.workspaceFile);
    }
    if (element.virtualDir) {
      return this.virtualDirChildren(element.virtualDir);
    }
    return [];
  }

  private async getRootChildren(): Promise<SmartExplorerNode[]> {
    const nodes = this.workspaces.map((w) => {
      return new SmartExplorerNode(
        w.name ?? w.source.title ?? w.id,
        vscode.TreeItemCollapsibleState.Collapsed,
        {
          contextValue: `workspace-${w.source.type}`,
          iconId: TYPE_ICONS[w.source.type] ?? TYPE_ICONS.text,
          description: truncate(w.source.url),
          tooltip: [
            `${w.source.type}: ${w.source.url}`,
            ...(w.instructions ?? []),
          ].join('\n'),
          workspaceFile: w,
        },
      );
    });
    if (this.activeId) {
      const active = nodes.filter((n) => n.workspaceFile?.id === this.activeId);
      if (active.length > 0) {
        return active;
      }
    }
    return nodes;
  }

  // Enfants d'un workspace : l'arbre construit par l'agent (build_tree).
  private getWorkspaceChildren(ws: WorkspaceFile): SmartExplorerNode[] {
    if (!ws.tree) {
      return [
        new SmartExplorerNode(
          'Aucun fichier — demande à l’agent d’appeler build_tree',
          vscode.TreeItemCollapsibleState.None,
          { contextValue: 'info', iconId: 'info' },
        ),
      ];
    }
    return this.virtualDirChildren(dedupeTree(ws.tree));
  }

  // Virtual dir -> noeuds : dossiers d'abord, puis fichiers, chacun trié par
  // nom. Fichiers et virtual dirs délèguent au thème d'icônes de fichiers de
  // l'utilisateur via resourceUri (un virtual dir "tests" hérite donc de
  // l'icône du dossier "tests" du thème actif). Un `icon` explicite du YAML
  // reste prioritaire (codicon).
  private virtualDirChildren(dir: VirtualDir): SmartExplorerNode[] {
    const nodes: SmartExplorerNode[] = [];
    for (const sub of byName(dir.dirs ?? [], (d) => d.name)) {
      const icon = sub.icon?.trim();
      nodes.push(
        new SmartExplorerNode(
          sub.name,
          vscode.TreeItemCollapsibleState.Collapsed,
          {
            contextValue: 'virtualFolder',
            iconId: icon || 'folder',
            resourceUri: icon ? undefined : this.virtualDirUri(sub.name),
            fileNode: { name: sub.name, path: '', type: 'virtualFolder' },
            virtualDir: sub,
          },
        ),
      );
    }
    // Fusion de dossiers : deux fichiers de même nom peuvent se retrouver dans
    // le même virtual dir ; on affiche alors leur vrai dossier pour les distinguer.
    const files = byName(dir.files ?? [], (f) => path.basename(f));
    const counts = new Map<string, number>();
    for (const f of files) {
      counts.set(path.basename(f), (counts.get(path.basename(f)) ?? 0) + 1);
    }
    for (const file of files) {
      nodes.push(
        this.toFilePathNode(file, (counts.get(path.basename(file)) ?? 0) > 1),
      );
    }
    return nodes;
  }

  // URI synthétique (inexistante sur disque) dont le basename est le nom du
  // virtual dir : c'est lui que le thème d'icônes apparie (folderNames).
  private virtualDirUri(name: string): vscode.Uri {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri;
    const segment = name.replace(/[\\/]/g, '-');
    return root
      ? vscode.Uri.joinPath(root, '.smart-explorer-virtual', segment)
      : vscode.Uri.file(`/.smart-explorer-virtual/${segment}`);
  }

  private toFilePathNode(
    relPath: string,
    ambiguous = false,
  ): SmartExplorerNode {
    const abs = this.fileUri(relPath);
    const name = path.basename(relPath);
    return new SmartExplorerNode(name, vscode.TreeItemCollapsibleState.None, {
      contextValue: 'file',
      resourceUri: abs,
      tooltip: relPath,
      description: ambiguous ? path.dirname(relPath) : undefined,
      fileNode: { name, path: relPath, type: 'file' },
      command: { command: 'vscode.open', title: 'Open', arguments: [abs] },
    });
  }
}

// Tri par nom, insensible à la casse et aux accents.
function byName<T>(items: T[], key: (item: T) => string): T[] {
  return [...items].sort((x, y) => key(x).localeCompare(key(y)));
}
