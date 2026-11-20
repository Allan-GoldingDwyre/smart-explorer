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

  const provider = new SmartExplorerProvider();
  const treeView = vscode.window.createTreeView('smartExplorerView', {
    treeDataProvider: provider,
    showCollapseAll: true,
  });

  // Serveur MCP déclaré à VS Code (lancé par VS Code, exposé au chat). Les
  // clients écrivent les YAML ; l'extension re-render via le watcher.
  registerMcpServer(context);

  const reload = () => {
    provider.reloadFromDisk();
    provider.refresh();
  };
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
    ...disposables,
    vscode.commands.registerCommand('smartExplorer.refresh', reload),
    vscode.commands.registerCommand('smartExplorer.renameWorkspace', () => {
      provider.renameWorkspace(
        treeView.selection[0] as SmartExplorerNode | undefined,
      );
    }),
    vscode.commands.registerCommand(
      'smartExplorer.deleteWorkspace',
      (node: SmartExplorerNode) => provider.deleteWorkspace(node),
    ),
    vscode.commands.registerCommand(
      'smartExplorer.addInstruction',
      (node: SmartExplorerNode) => provider.addInstruction(node),
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
