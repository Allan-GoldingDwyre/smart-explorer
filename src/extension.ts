import * as vscode from 'vscode';
import { loginGithub, logoutGithub, logoutLinear, setupLinear } from './auth';
import { SmartExplorerNode } from './SmartExplorerNode';
import { SmartExplorerProvider } from './SmartExplorerProvider';

export function activate(context: vscode.ExtensionContext) {
  const provider = new SmartExplorerProvider(context);

  const treeView = vscode.window.createTreeView('smartExplorerView', {
    treeDataProvider: provider,
    showCollapseAll: true,
  });

  context.subscriptions.push(
    treeView,
    vscode.commands.registerCommand('smartExplorer.addWorkspace', () => {
      provider.addWorkspace();
    }),
    vscode.commands.registerCommand('smartExplorer.renameWorkspace', () => {
      provider.renameWorkspace(
        treeView.selection[0] as SmartExplorerNode | undefined,
      );
    }),
    vscode.commands.registerCommand(
      'smartExplorer.deleteWorkspace',
      (node: SmartExplorerNode) => {
        provider.deleteWorkspace(node);
      },
    ),
    vscode.commands.registerCommand(
      'smartExplorer.addInstruction',
      (node: SmartExplorerNode) => {
        provider.addInstruction(node);
      },
    ),
    vscode.commands.registerCommand(
      'smartExplorer.refreshWorkspace',
      (node: SmartExplorerNode) => {
        provider.refreshWorkspace(node);
      },
    ),
    vscode.commands.registerCommand(
      'smartExplorer.revealInExplorer',
      (node: SmartExplorerNode) => {
        provider.revealInExplorer(node);
      },
    ),
    vscode.commands.registerCommand('smartExplorer.loginGithub', () => {
      loginGithub();
    }),
    vscode.commands.registerCommand('smartExplorer.logoutGithub', () => {
      logoutGithub();
    }),
    vscode.authentication.onDidChangeSessions((e) => {
      if (e.provider.id === 'github') {
        provider.refresh();
      }
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('smartExplorer')) {
        provider.refresh();
      }
    }),
    vscode.commands.registerCommand('smartExplorer.setupLinear', async () => {
      await setupLinear(context);
      provider.refresh();
    }),
    vscode.commands.registerCommand('smartExplorer.logoutLinear', async () => {
      await logoutLinear(context);
      provider.refresh();
    }),
  );
}

export function deactivate() {}
