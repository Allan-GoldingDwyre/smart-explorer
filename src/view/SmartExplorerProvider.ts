import * as path from 'path';
import * as vscode from 'vscode';
import { FOLLOWING_URI_SCHEME, SmartExplorerNode } from './SmartExplorerNode';
import { TYPE_ICONS, truncate } from '../core/types';
import {
  WalkSession,
  isLiveSession,
  readEvents,
  readWalkthrough,
  walkProgress,
} from '../walkthrough/walkthrough';
import {
  FollowState,
  VirtualDir,
  WorkspaceFile,
  dedupeTree,
  deleteWorkspace as deleteWorkspaceFile,
  listWorkspaces,
  readActive,
  readFollow,
  saveWorkspace,
  treeFiles,
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
  private follow?: FollowState;
  private walk?: { session: WalkSession; current: number };

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
    this.follow = root ? readFollow(root) : undefined;
    // Visite guidée en cours : étape courante = celle du dernier événement.
    const session = root ? readWalkthrough(root) : undefined;
    this.walk =
      root && session && isLiveSession(root, session)
        ? {
            session,
            current: Math.min(
              Math.max(
                readEvents(root)
                  .filter((e) => e.session === session.id)
                  .at(-1)?.step ?? 1,
                1,
              ),
              Math.max(session.steps.length, 1),
            ),
          }
        : undefined;
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
      .filter((w) => treeFiles(w).includes(relPath))
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
    return [...this.followRow(), ...shown.map((w) => this.workspaceNode(w))];
  }

  // La ligne « Following agent » est-elle affichée ? (pilote le bouton Stop
  // de la barre de titre et le raccourci clavier)
  isFollowing(): boolean {
    return this.followRow().length > 0;
  }

  // Ligne « Following agent » au-dessus du workspace actif tant que l'agent
  // mène (disparaît quand l'agent ou l'utilisateur arrête le suivi).
  private followRow(): SmartExplorerNode[] {
    const walk = this.walk;
    if (this.section === 'main' && walk && walk.session.steps.length > 0) {
      const step = walk.session.steps[walk.current - 1];
      const progress = walkProgress(walk.session);
      return [
        new SmartExplorerNode(
          'Following agent',
          vscode.TreeItemCollapsibleState.None,
          {
            id: 'following',
            contextValue: 'following',
            iconId: 'eye',
            iconColor: 'smartExplorer.agentActive',
            resourceUri: vscode.Uri.from({
              scheme: FOLLOWING_URI_SCHEME,
              path: '/agent',
            }),
            description: `étape ${walk.current}/${progress.total}${
              progress.generating ? ' …' : ''
            }`,
            tooltip: `Visite guidée : ${
              step?.title ?? ''
            }\nCliquer pour revenir à l'étape, ✕ pour arrêter.`,
            command: {
              command: 'smartExplorer.followingAgent',
              title: "Revenir à l'étape de l'agent",
            },
          },
        ),
      ];
    }

    const focus = this.follow?.focus;
    if (
      this.section !== 'main' ||
      this.follow?.status !== 'following' ||
      !focus
    ) {
      return [];
    }
    return [
      new SmartExplorerNode(
        'Following agent',
        vscode.TreeItemCollapsibleState.None,
        {
          id: 'following',
          contextValue: 'following',
          iconId: 'eye',
          iconColor: 'smartExplorer.agentActive',
          // L'URI permet à la décoration orange de colorer le texte de la ligne.
          resourceUri: vscode.Uri.from({
            scheme: FOLLOWING_URI_SCHEME,
            path: '/agent',
          }),
          description: `${path.basename(focus.path)}${
            focus.line ? `:${focus.line}` : ''
          }`,
          tooltip: `Suit l'agent : ${focus.path}${
            focus.line ? `:${focus.line}` : ''
          }\nCliquer pour y revenir, ✕ pour arrêter le suivi.`,
          command: {
            command: 'smartExplorer.followingAgent',
            title: "Aller à la position de l'agent",
          },
        },
      ),
    ];
  }

  private workspaceNode(w: WorkspaceFile): SmartExplorerNode {
    return new SmartExplorerNode(
      w.name ?? w.source.title ?? w.id,
      this.section === 'main'
        ? vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.Collapsed,
      {
        id: `ws:${w.id}`,
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
  }

  // Enfants d'un workspace : l'arbre construit par l'agent (build_tree).
  private getWorkspaceChildren(
    ws: WorkspaceFile,
    parent: SmartExplorerNode,
  ): SmartExplorerNode[] {
    if (!ws.tree) {
      return [
        new SmartExplorerNode(
          'Aucun fichier — demande à l’agent d’appeler build_tree',
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
    return this.virtualDirChildren(dedupeTree(ws.tree), parent);
  }

  // Virtual dir -> noeuds : dossiers d'abord, puis fichiers, chacun trié par
  // nom. Fichiers et virtual dirs délèguent au thème d'icônes de fichiers de
  // l'utilisateur via resourceUri (un virtual dir "tests" hérite donc de
  // l'icône du dossier "tests" du thème actif). Un `icon` explicite du YAML
  // reste prioritaire (codicon).
  private virtualDirChildren(
    dir: VirtualDir,
    parent: SmartExplorerNode,
  ): SmartExplorerNode[] {
    const nodes: SmartExplorerNode[] = [];
    for (const sub of byName(dir.dirs ?? [], (d) => d.name)) {
      const icon = sub.icon?.trim();
      nodes.push(
        new SmartExplorerNode(
          sub.name,
          vscode.TreeItemCollapsibleState.Collapsed,
          {
            id: `${parent.id}/${sub.name}`,
            parent,
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
