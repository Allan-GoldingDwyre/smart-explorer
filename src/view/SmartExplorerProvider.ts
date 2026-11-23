import * as path from 'path';
import * as vscode from 'vscode';
import { SmartExplorerNode } from './SmartExplorerNode';
import { TYPE_ICONS, truncate } from '../core/types';
import { workspaceKind } from '../core/links';
import { fuseTree } from '../core/treeFusion';
import {
  VirtualDir,
  WorkspaceFile,
  deleteWorkspace as deleteWorkspaceFile,
  listWorkspaces,
  readActive,
  saveWorkspace,
  workspaceFiles,
  writeActive,
} from '../core/workspaceStore';

// 'main' : le workspace actif, déplié. 'others' : les autres workspaces du
// projet, repliés (vue du bas).
export type ProviderSection = 'main' | 'others';

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

  constructor(private readonly section: ProviderSection = 'main') {
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

  // Workspace affiché en haut : l'actif, sinon le premier du projet.
  private effectiveActiveId(): string | undefined {
    return this.activeId ?? this.workspaces[0]?.id;
  }

  // Nombre de workspaces de la vue du bas (pilote sa visibilité).
  othersCount(): number {
    const active = this.effectiveActiveId();
    return this.workspaces.filter((w) => w.id !== active).length;
  }

  // Rend un workspace actif (écrit le fichier lu aussi par les clients MCP).
  activateWorkspace(node: SmartExplorerNode | undefined): void {
    const ws = node?.workspaceFile;
    const root = this.projectRoot();
    if (!ws || !root) {
      return;
    }
    writeActive(root, ws.id);
    this.reloadFromDisk();
    this.refresh();
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

  // Requis par TreeView.reveal (sélection d'un fichier dans l'arbre).
  getParent(element: SmartExplorerNode): SmartExplorerNode | undefined {
    return element.parent;
  }

  // Workspace mis en avant dans la vue du haut (actif, sinon le premier).
  activeWorkspaceId(): string | undefined {
    return this.effectiveActiveId();
  }

  // Ids des workspaces dont l'arbre contient ce fichier.
  workspacesContaining(relPath: string): string[] {
    return this.workspaces
      .filter((w) => workspaceFiles(w).includes(relPath))
      .map((w) => w.id);
  }

  // Noeud d'un fichier (chemin relatif au projet) dans le workspace mis en
  // avant, ou undefined s'il n'y figure pas.
  async findFileNode(relPath: string): Promise<SmartExplorerNode | undefined> {
    const search = async (
      node: SmartExplorerNode,
    ): Promise<SmartExplorerNode | undefined> => {
      if (node.fileNode?.type === 'file' && node.fileNode.path === relPath) {
        return node;
      }
      for (const child of await this.getChildren(node)) {
        const found = await search(child);
        if (found) {
          return found;
        }
      }
      return undefined;
    };
    for (const root of await this.getRootChildren()) {
      const found = await search(root);
      if (found) {
        return found;
      }
    }
    return undefined;
  }

  async getChildren(element?: SmartExplorerNode): Promise<SmartExplorerNode[]> {
    if (!element) {
      return this.getRootChildren();
    }
    if (element.workspaceFile) {
      return this.getWorkspaceChildren(element.workspaceFile, element);
    }
    if (element.virtualDir) {
      return this.virtualDirChildren(element.virtualDir, element);
    }
    return [];
  }

  // Vue principale : le workspace actif, déplié. Vue du bas : les autres,
  // repliés.
  private async getRootChildren(): Promise<SmartExplorerNode[]> {
    const active = this.effectiveActiveId();
    const shown = this.workspaces.filter((w) =>
      this.section === 'main' ? w.id === active : w.id !== active,
    );
    return shown.map((w) => this.workspaceNode(w));
  }

  private workspaceNode(w: WorkspaceFile): SmartExplorerNode {
    const kind = workspaceKind(w.links);
    const refs = (w.links ?? []).map((l) => l.ref);
    return new SmartExplorerNode(
      w.name ?? w.links?.find((l) => l.title)?.title ?? w.id,
      this.section === 'main'
        ? vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.Collapsed,
      {
        id: `ws:${w.id}`,
        contextValue: `workspace-${kind}`,
        iconId: TYPE_ICONS[kind],
        description: refs.length ? truncate(refs.join(', ')) : undefined,
        tooltip: (w.links ?? [])
          .map((l) => `${l.kind}: ${l.ref}${l.title ? ` — ${l.title}` : ''}`)
          .join('\n'),
        workspaceFile: w,
      },
    );
  }

  // Enfants d'un workspace : l'arbre est recalculé par fusion à partir des
  // fichiers retenus (set_files), il n'est jamais stocké.
  private getWorkspaceChildren(
    ws: WorkspaceFile,
    parent: SmartExplorerNode,
  ): SmartExplorerNode[] {
    const files = workspaceFiles(ws);
    if (!files.length) {
      return [
        new SmartExplorerNode(
          'Aucun fichier — demande à l’agent d’appeler set_files',
          vscode.TreeItemCollapsibleState.None,
          {
            id: `${parent.id}/info`,
            parent,
            contextValue: 'info',
            iconId: 'info',
          },
        ),
      ];
    }
    return this.virtualDirChildren(fuseTree(files, ws.fusion), parent);
  }

  // Virtual dir -> noeuds : dossiers d'abord, puis fichiers, chacun trié par
  // nom. Fichiers et virtual dirs délèguent au thème d'icônes de fichiers de
  // l'utilisateur via resourceUri (un virtual dir "tests" hérite donc de
  // l'icône du dossier "tests" du thème actif).
  private virtualDirChildren(
    dir: VirtualDir,
    parent: SmartExplorerNode,
  ): SmartExplorerNode[] {
    const nodes: SmartExplorerNode[] = [];
    for (const sub of byName(dir.dirs ?? [], (d) => d.name)) {
      nodes.push(
        new SmartExplorerNode(
          sub.name,
          vscode.TreeItemCollapsibleState.Collapsed,
          {
            id: `${parent.id}/${sub.name}`,
            parent,
            contextValue: 'virtualFolder',
            iconId: 'folder',
            resourceUri: this.virtualDirUri(sub.name),
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
        this.toFilePathNode(
          file,
          parent,
          (counts.get(path.basename(file)) ?? 0) > 1,
        ),
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
    parent: SmartExplorerNode,
    ambiguous = false,
  ): SmartExplorerNode {
    const abs = this.fileUri(relPath);
    const name = path.basename(relPath);
    return new SmartExplorerNode(name, vscode.TreeItemCollapsibleState.None, {
      id: `${parent.id}|${relPath}`,
      parent,
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
