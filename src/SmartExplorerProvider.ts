import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { getLinearToken } from './auth';
import { fetchRefTitle } from './refs';
import { SmartExplorerNode } from './SmartExplorerNode';
import { FileTreeNode, TYPE_ICONS, WorkspaceEntry, truncate } from './types';
import { iconForVirtualDir } from './virtualDirIcon';
import { runAddWorkspaceFlow } from './workspaceForm';
import {
  VirtualDir,
  WorkspaceFile,
  deleteWorkspace as deleteWorkspaceFile,
  listWorkspaces,
  saveWorkspace,
  uniqueWorkspaceId,
} from './workspaceStore';

const WORKSPACES_KEY = 'smartExplorer.workspaces';
const ACTIVE_KEY = 'smartExplorer.activeWorkspace';
const IGNORED_DIRS = new Set(['node_modules', '.git', 'out', 'dist']);

export class SmartExplorerProvider
  implements vscode.TreeDataProvider<SmartExplorerNode>
{
  private _onDidChangeTreeData = new vscode.EventEmitter<
    SmartExplorerNode | undefined
  >();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private workspaces: WorkspaceEntry[];
  // Workspaces issus du store YAML (state partagé avec les tools MCP).
  private yamlWorkspaces: WorkspaceFile[] = [];
  private activeId?: string;
  private fileTreeCache = new Map<string, FileTreeNode[]>();
  private treeView?: vscode.TreeView<SmartExplorerNode>;

  constructor(private context: vscode.ExtensionContext) {
    this.workspaces = context.workspaceState.get<WorkspaceEntry[]>(
      WORKSPACES_KEY,
      [],
    );
    this.activeId = context.workspaceState.get<string | undefined>(ACTIVE_KEY);
    this.reloadFromDisk();
  }

  setTreeView(view: vscode.TreeView<SmartExplorerNode>): void {
    this.treeView = view;
  }

  // Recharge les workspaces YAML depuis le disque (appelé aussi par le
  // watcher quand un agent écrit un fichier via les tools MCP).
  reloadFromDisk(): void {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    this.yamlWorkspaces = root ? listWorkspaces(root) : [];
    // Workspace active choisi par un client MCP externe (serveur stdio).
    if (root) {
      try {
        const activeFile = path.join(root, '.smart-explorer', 'active');
        const id = fs.readFileSync(activeFile, 'utf8').trim();
        const known =
          this.yamlWorkspaces.some((w) => w.id === id) ||
          this.workspaces.some((w) => w.id === id);
        if (id && known) {
          this.activeId = id;
        }
      } catch {
        // pas de fichier active : on garde l'active courant
      }
    }
  }

  getActiveWorkspace(): string | undefined {
    return this.activeId;
  }

  setActiveWorkspace(id: string): void {
    this.activeId = id;
    void this.context.workspaceState.update(ACTIVE_KEY, id);
    this.refresh();
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
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (root) {
      // Persisté dans le store YAML pour être visible des tools MCP.
      // Best-effort : un souci disque ne doit pas bloquer le flux UI.
      try {
        const id = uniqueWorkspaceId(root, entry.name);
        entry.id = id;
        saveWorkspace(root, {
          version: 1,
          id,
          name: entry.name,
          source: {
            type: entry.type === 'smart' ? 'text' : entry.type,
            url: entry.ref,
          },
          lifecycle:
            entry.type === 'pr'
              ? 'pr'
              : entry.type === 'issue'
                ? 'issue'
                : 'exploration',
          instructions: entry.instructions ?? [],
          freshness: {},
        });
        this.reloadFromDisk();
      } catch {
        // store YAML indisponible : le workspace reste en workspaceState.
      }
    }
    this.workspaces.push(entry);
    await this.save();
    this.refresh();
  }

  async renameWorkspace(node: SmartExplorerNode | undefined): Promise<void> {
    const name = await vscode.window.showInputBox({
      title: 'Rename Workspace',
      prompt: 'Nouveau nom du workspace',
      value: node?.entry?.name ?? node?.workspaceFile?.name,
    });
    if (!name) {
      return;
    }
    if (node?.workspaceFile) {
      node.workspaceFile.name = name;
      this.persistYaml(node.workspaceFile);
    }
    if (node?.entry && name !== node.entry.name) {
      node.entry.name = name;
      await this.save();
    }
    this.refresh();
  }

  async deleteWorkspace(node: SmartExplorerNode): Promise<void> {
    const label = node.workspaceFile?.name ?? node.entry?.name;
    const confirm = await vscode.window.showWarningMessage(
      `Supprimer le workspace "${label}" ?`,
      { modal: true },
      'Supprimer',
    );
    if (confirm !== 'Supprimer') {
      return;
    }
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (node.workspaceFile && root) {
      deleteWorkspaceFile(root, node.workspaceFile.id);
      this.reloadFromDisk();
    }
    if (node.entry) {
      this.workspaces = this.workspaces.filter((w) => w !== node.entry);
      await this.save();
    }
    this.refresh();
  }

  async addInstruction(node: SmartExplorerNode): Promise<void> {
    const target = node.workspaceFile ?? node.entry;
    if (!target) {
      return;
    }
    const instruction = await vscode.window.showInputBox({
      title: 'Add Instruction',
      prompt: `Instruction liée au workspace "${target.name}"`,
      placeHolder:
        'Ex : se concentrer sur la logique métier, ignorer les tests...',
    });
    if (!instruction) {
      return;
    }
    if (node.workspaceFile) {
      node.workspaceFile.instructions = [
        ...(node.workspaceFile.instructions ?? []),
        instruction,
      ];
      this.persistYaml(node.workspaceFile);
    }
    if (node.entry) {
      node.entry.instructions = [
        ...(node.entry.instructions ?? []),
        instruction,
      ];
      await this.save();
    }
    this.refresh();
  }

  // Relance la résolution du workspace (titre à jour via l'API).
  async refreshWorkspace(node: SmartExplorerNode): Promise<void> {
    const entry = node.entry;
    const file = node.workspaceFile;
    const type = file?.source.type ?? entry?.type;
    const ref = file?.source.url ?? entry?.ref;
    if (!type || !ref) {
      return;
    }
    const title = await fetchRefTitle(type, ref, this.context);
    if (title) {
      const name = truncate(title, 60);
      if (file && name !== file.name) {
        file.name = name;
        this.persistYaml(file);
      }
      if (entry && name !== entry.name) {
        entry.name = name;
        await this.save();
      }
    }
    this.refresh();
    vscode.window.showInformationMessage(
      `Workspace "${file?.name ?? entry?.name}" rafraîchi.`,
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

  // Hook pour le tool MCP reveal_file.
  async revealFile(relPath: string, where: 'editor' | 'tree'): Promise<void> {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri;
    const uri = root
      ? vscode.Uri.joinPath(root, relPath)
      : vscode.Uri.file(relPath);
    if (where === 'editor') {
      await vscode.commands.executeCommand('vscode.open', uri);
      return;
    }
    // 'tree' : sélectionne le fichier dans la vue Smart Explorer.
    const node = await this.findFileNode(relPath);
    if (node && this.treeView) {
      await this.treeView.reveal(node, {
        select: true,
        focus: false,
        expand: true,
      });
    } else {
      await vscode.commands.executeCommand('revealInExplorer', uri);
    }
  }

  private async findFileNode(
    relPath: string,
  ): Promise<SmartExplorerNode | undefined> {
    const roots = await this.getRootChildren();
    for (const rootNode of roots) {
      const found = await this.findFileNodeIn(rootNode, relPath);
      if (found) {
        return found;
      }
    }
    return undefined;
  }

  private async findFileNodeIn(
    node: SmartExplorerNode,
    relPath: string,
  ): Promise<SmartExplorerNode | undefined> {
    if (node.fileNode?.type === 'file' && node.fileNode.path === relPath) {
      return node;
    }
    for (const child of await this.getChildren(node)) {
      const found = await this.findFileNodeIn(child, relPath);
      if (found) {
        return found;
      }
    }
    return undefined;
  }

  private persistYaml(ws: WorkspaceFile): void {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
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
    if (element.workspaceFile) {
      return this.getYamlWorkspaceChildren(element.workspaceFile);
    }
    if (element.entry) {
      return this.getWorkspaceChildren(element.entry);
    }
    if (element.virtualDir) {
      return this.getVirtualDirChildren(element);
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
    const yamlNodes = this.yamlWorkspaces.map((w) => {
      const sourceType = w.source.type;
      return new SmartExplorerNode(
        w.name ?? w.source.title ?? w.id,
        vscode.TreeItemCollapsibleState.Collapsed,
        {
          contextValue: `workspace-${sourceType}`,
          iconId: TYPE_ICONS[sourceType] ?? TYPE_ICONS.text,
          description: truncate(w.source.url),
          tooltip: [
            `${sourceType}: ${w.source.url}`,
            ...(w.instructions ?? []),
          ].join('\n'),
          workspaceFile: w,
        },
      );
    });
    // Workspaces legacy (workspaceState) dont l'id n'est pas déjà dans le YAML.
    const yamlIds = new Set(this.yamlWorkspaces.map((w) => w.id));
    const legacyNodes = this.workspaces
      .filter((w) => !w.id || !yamlIds.has(w.id))
      .map(
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
      );
    const all = [...nodes, ...yamlNodes, ...legacyNodes];
    if (this.activeId) {
      return all.filter(
        (n) =>
          n.workspaceFile?.id === this.activeId ||
          n.entry?.id === this.activeId,
      );
    }
    return all;
  }

  // Enfants d'un workspace YAML : l'arbre virtuel de l'agent s'il existe,
  // sinon l'arbre physique du projet.
  private async getYamlWorkspaceChildren(
    ws: WorkspaceFile,
  ): Promise<SmartExplorerNode[]> {
    if (ws.tree) {
      return this.virtualDirChildren(ws.tree);
    }
    return (await this.buildProjectTree()).map((n) => this.toFileNode(n));
  }

  // Virtual dir -> noeuds : les virtual dirs portent un codicon (icon du
  // YAML ou déduit du nom), les fichiers délèguent au thème d'icônes via
  // resourceUri.
  private virtualDirChildren(dir: VirtualDir): SmartExplorerNode[] {
    const nodes: SmartExplorerNode[] = [];
    for (const file of dir.files ?? []) {
      nodes.push(this.toFilePathNode(file));
    }
    for (const sub of dir.dirs ?? []) {
      nodes.push(
        new SmartExplorerNode(
          sub.name,
          vscode.TreeItemCollapsibleState.Collapsed,
          {
            contextValue: 'virtualFolder',
            iconId: iconForVirtualDir(sub.name, sub.icon),
            fileNode: {
              name: sub.name,
              path: '',
              type: 'virtualFolder',
              children: [],
            },
            virtualDir: sub,
          },
        ),
      );
    }
    return nodes;
  }

  private toFilePathNode(relPath: string): SmartExplorerNode {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri;
    const abs = root
      ? vscode.Uri.joinPath(root, relPath)
      : vscode.Uri.file(relPath);
    return new SmartExplorerNode(
      path.basename(relPath),
      vscode.TreeItemCollapsibleState.None,
      {
        contextValue: 'file',
        resourceUri: abs,
        fileNode: { name: path.basename(relPath), path: relPath, type: 'file' },
        command: { command: 'vscode.open', title: 'Open', arguments: [abs] },
      },
    );
  }

  // Enfants d'un virtual dir imbriqué (stocké sur le noeud parent).
  private getVirtualDirChildren(node: SmartExplorerNode): SmartExplorerNode[] {
    const dir = node.virtualDir;
    if (!dir) {
      return [];
    }
    return this.virtualDirChildren(dir);
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
        resourceUri: isFolder ? undefined : abs,
        iconId: isFolder ? 'folder' : undefined,
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
