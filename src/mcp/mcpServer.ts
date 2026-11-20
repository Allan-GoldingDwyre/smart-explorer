// Déclare le serveur MCP de l'extension auprès de VS Code (≥ 1.101) : VS Code
// lance lui-même le serveur stdio livré dans le vsix (dist/smart-explorer-mcp.js)
// et l'expose au chat (Chat → MCP Servers). Même binaire que pour les clients
// externes : une seule implémentation (mcpStdio.ts / mcpTools.ts).
import * as vscode from 'vscode';

const MCP_PROVIDER_ID = 'smartExplorer.mcp';

export function registerMcpServer(
  context: vscode.ExtensionContext,
): vscode.Disposable | undefined {
  if (typeof vscode.lm?.registerMcpServerDefinitionProvider !== 'function') {
    vscode.window.showWarningMessage(
      'Smart Explorer : VS Code ≥ 1.101 requis pour le serveur MCP intégré.',
    );
    return undefined;
  }
  const script = context.asAbsolutePath('dist/smart-explorer-mcp.js');
  const version: string = context.extension.packageJSON.version;
  const provider: vscode.McpServerDefinitionProvider = {
    provideMcpServerDefinitions: () => {
      const root = vscode.workspace.workspaceFolders?.[0]?.uri;
      if (!root) {
        return [];
      }
      return [
        new vscode.McpStdioServerDefinition(
          'Smart Explorer',
          process.execPath,
          [script, '--root', root.fsPath],
          { ELECTRON_RUN_AS_NODE: '1' },
          version,
        ),
      ];
    },
  };
  const registration = vscode.lm.registerMcpServerDefinitionProvider(
    MCP_PROVIDER_ID,
    provider,
  );
  context.subscriptions.push(registration);
  return registration;
}
