import * as vscode from 'vscode';
import { registerMcpServer } from './mcpServer';
import { SmartExplorerNode } from './SmartExplorerNode';
import { SmartExplorerProvider } from './SmartExplorerProvider';
import {
  listOrphanProjects,
  migrateLegacyStore,
  projectDataDir,
  removeProjectData,
  workspacesDir,
} from './workspaceStore';

export function activate(context: vscode.ExtensionContext) {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (root) {
    // Anciennes données (dans le projet) -> dossier de données utilisateur.
    try {
      migrateLegacyStore(root);
    } catch {
      // migration best-effort : le store reste utilisable
    }
  }

  // Deux vues : le workspace actif (haut) et les autres, repliés (bas).
  const provider = new SmartExplorerProvider('main');
  const othersProvider = new SmartExplorerProvider('others');
  const treeView = vscode.window.createTreeView('smartExplorerView', {
    treeDataProvider: provider,
    showCollapseAll: true,
  });
  const othersView = vscode.window.createTreeView('smartExplorerOthers', {
    treeDataProvider: othersProvider,
  });

  // Serveur MCP déclaré à VS Code (lancé par VS Code, exposé au chat). Les
  // clients écrivent les YAML ; l'extension re-render via le watcher.
  registerMcpServer(context);

  const reload = () => {
    for (const p of [provider, othersProvider]) {
      p.reloadFromDisk();
      p.refresh();
    }
    void vscode.commands.executeCommand(
      'setContext',
      'smartExplorer.hasOthers',
      othersProvider.othersCount() > 0,
    );
  };
  reload();
  const disposables: vscode.Disposable[] = [];
  if (root) {
    // Les données vivent hors du projet : on surveille leur dossier.
    const wsDir = vscode.Uri.file(workspacesDir(root));
    const projectDir = vscode.Uri.file(projectDataDir(root));
    for (const watcher of [
      vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(wsDir, '*.yaml'),
      ),
      vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(projectDir, 'active'),
      ),
    ]) {
      watcher.onDidChange(reload);
      watcher.onDidCreate(reload);
      watcher.onDidDelete(reload);
      disposables.push(watcher);
    }
  }

  context.subscriptions.push(
    treeView,
    othersView,
    ...disposables,
    vscode.commands.registerCommand('smartExplorer.refresh', reload),
    vscode.commands.registerCommand(
      'smartExplorer.activateWorkspace',
      (node: SmartExplorerNode) => {
        provider.activateWorkspace(node);
        reload();
      },
    ),
    vscode.commands.registerCommand(
      'smartExplorer.renameWorkspace',
      async () => {
        const node = (treeView.selection[0] ?? othersView.selection[0]) as
          | SmartExplorerNode
          | undefined;
        await provider.renameWorkspace(node);
        reload();
      },
    ),
    vscode.commands.registerCommand(
      'smartExplorer.deleteWorkspace',
      async (node: SmartExplorerNode) => {
        await provider.deleteWorkspace(node);
        reload();
      },
    ),
    vscode.commands.registerCommand(
      'smartExplorer.addInstruction',
      async (node: SmartExplorerNode) => {
        await provider.addInstruction(node);
        reload();
      },
    ),
    vscode.commands.registerCommand(
      'smartExplorer.revealInExplorer',
      (node: SmartExplorerNode) => provider.revealInExplorer(node),
    ),
    vscode.commands.registerCommand('smartExplorer.cleanOrphans', async () => {
      const orphans = listOrphanProjects();
      if (orphans.length === 0) {
        vscode.window.showInformationMessage(
          'Smart Explorer : aucune donnée orpheline.',
        );
        return;
      }
      const count = orphans.reduce((n, o) => n + o.workspaces, 0);
      const confirm = await vscode.window.showWarningMessage(
        `Supprimer les données de ${orphans.length} projet(s) introuvable(s) (${count} workspace(s)) ?`,
        { modal: true, detail: orphans.map((o) => o.root ?? o.dir).join('\n') },
        'Supprimer',
      );
      if (confirm === 'Supprimer') {
        orphans.forEach((o) => removeProjectData(o.dir));
      }
    }),
  );
}

export function deactivate() {}
