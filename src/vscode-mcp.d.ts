// Déclaration locale de l'API MCP in-process (vscode.createMcpServer),
// disponible à partir de VS Code 1.99. Absente des @types/vscode stables
// installés, d'où ce shim typé ; le garde-fou runtime est dans mcpServer.ts.
declare module 'vscode' {
  export interface McpServerToolDefinition {
    description: string;
    inputSchema?: Record<string, unknown>;
    invoke(
      args: Record<string, unknown>,
      token?: CancellationToken,
    ): ProviderResult<LanguageModelToolResult>;
  }

  export interface McpServerHandle extends Disposable {
    readonly id: string;
    registerTool(name: string, tool: McpServerToolDefinition): Disposable;
  }

  export function createMcpServer(id: string, label: string): McpServerHandle;
}
