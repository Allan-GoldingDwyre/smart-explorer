// Câblage du serveur MCP hébergé par l'extension (démarré à l'activation).
// L'extension reste le rendering + registry ; toute l'intelligence est côté
// agent (client MCP). Les tools délèguent à mcpTools.ts (logique pure).
import * as vscode from 'vscode';
import { getGithubSession, getLinearToken } from './auth';
import {
  ToolEnv,
  applySyncTool,
  buildTreeTool,
  checkWorkspaceFilesTool,
  createWorkspaceTool,
  exportContextTool,
  fetchSourceTool,
  listWorkspacesTool,
  revealFileTool,
  setActiveWorkspaceTool,
  setInstructionsTool,
  syncWorkspaceTool,
} from './mcpTools';

export interface McpHooks {
  revealFile: (
    relPath: string,
    where: 'editor' | 'tree',
  ) => void | Promise<void>;
  setActiveWorkspace: (id: string) => void;
  getActiveWorkspace: () => string | undefined;
}

function toolResult(value: unknown): vscode.LanguageModelToolResult {
  return new vscode.LanguageModelToolResult([
    new vscode.LanguageModelTextPart(JSON.stringify(value, null, 2)),
  ]);
}

interface ToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  run: (env: ToolEnv, args: any) => Promise<unknown>;
}

const jsonStringArray = {
  type: 'array',
  items: { type: 'string' },
} as const;

function buildTools(): ToolSpec[] {
  return [
    {
      name: 'list_workspaces',
      description:
        'Liste les workspaces Smart Explorer du projet : id, nom, type de source, état de fraîcheur.',
      inputSchema: { type: 'object', properties: {} },
      run: (env) => listWorkspacesTool(env),
    },
    {
      name: 'create_workspace',
      description:
        'Crée un workspace à partir d’une source (URL issue/PR GitHub ou Linear, ou texte libre). Retourne workspace_id.',
      inputSchema: {
        type: 'object',
        properties: {
          source: { type: 'string', description: 'URL issue/PR ou texte' },
          name: { type: 'string' },
          instructions: jsonStringArray,
        },
        required: ['source'],
      },
      run: (env, args) => createWorkspaceTool(env, args),
    },
    {
      name: 'fetch_source',
      description:
        'Canonicalise une ref (issue/PR GitHub, ID Linear) : titre, description, fichiers modifiés (PR), SHA courant.',
      inputSchema: {
        type: 'object',
        properties: { ref: { type: 'string' } },
        required: ['ref'],
      },
      run: (env, args) => fetchSourceTool(env, args),
    },
    {
      name: 'build_tree',
      description:
        'Écrit l’arbre virtuel (virtual dirs + fichiers primaires) dans le YAML du workspace ; la vue VS Code re-render.',
      inputSchema: {
        type: 'object',
        properties: {
          workspace_id: { type: 'string' },
          tree: {
            type: 'object',
            description: 'Virtual dir racine : { name, icon?, files?, dirs? }',
          },
        },
        required: ['workspace_id', 'tree'],
      },
      run: (env, args) => buildTreeTool(env, args),
    },
    {
      name: 'set_instructions',
      description: 'Écrit les instructions d’organisation d’un workspace.',
      inputSchema: {
        type: 'object',
        properties: {
          workspace_id: { type: 'string' },
          instructions: jsonStringArray,
        },
        required: ['workspace_id', 'instructions'],
      },
      run: (env, args) => setInstructionsTool(env, args),
    },
    {
      name: 'sync_workspace',
      description:
        'Retourne le diff depuis base_commit (fichiers added/modified/deleted/renamed + drift de hash), sans appliquer.',
      inputSchema: {
        type: 'object',
        properties: { workspace_id: { type: 'string' } },
        required: ['workspace_id'],
      },
      run: (env, args) => syncWorkspaceTool(env, args),
    },
    {
      name: 'apply_sync',
      description:
        'Applique le diff validé par l’utilisateur : retire les fichiers supprimés/renommés acceptés, met à jour base_commit et file_hashes.',
      inputSchema: {
        type: 'object',
        properties: {
          workspace_id: { type: 'string' },
          accepted: jsonStringArray,
          rejected: jsonStringArray,
        },
        required: ['workspace_id', 'accepted', 'rejected'],
      },
      run: (env, args) => applySyncTool(env, args),
    },
    {
      name: 'check_workspace_files',
      description:
        'Liste les chemins du workspace introuvables dans le repo + candidats de résolution (fuzzy / similarité).',
      inputSchema: {
        type: 'object',
        properties: { workspace_id: { type: 'string' } },
        required: ['workspace_id'],
      },
      run: (env, args) => checkWorkspaceFilesTool(env, args),
    },
    {
      name: 'export_context',
      description:
        'Exporte le contexte du workspace (fichiers primaires, optionnellement avec dépendances directes), tronqué à max_tokens si fourni.',
      inputSchema: {
        type: 'object',
        properties: {
          workspace_id: { type: 'string' },
          mode: { type: 'string', enum: ['primary', 'with_dependencies'] },
          max_tokens: { type: 'number' },
        },
        required: ['workspace_id', 'mode'],
      },
      run: (env, args) => exportContextTool(env, args),
    },
    {
      name: 'reveal_file',
      description:
        'Révèle un fichier dans l’éditeur ou dans l’arbre Smart Explorer.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          workspace_id: { type: 'string' },
          reveal: { type: 'string', enum: ['editor', 'tree'] },
        },
        required: ['path', 'reveal'],
      },
      run: (env, args) => revealFileTool(env, args),
    },
    {
      name: 'set_active_workspace',
      description:
        'Bascule la workspace affichée dans le panel Smart Explorer.',
      inputSchema: {
        type: 'object',
        properties: { workspace_id: { type: 'string' } },
        required: ['workspace_id'],
      },
      run: (env, args) => setActiveWorkspaceTool(env, args),
    },
  ];
}

// Démarre le serveur MCP in-process. Retourne undefined (avec un warning)
// si l'API n'est pas disponible (VS Code < 1.99) : l'extension reste usable.
export function startMcpServer(
  context: vscode.ExtensionContext,
  hooks: McpHooks,
): vscode.Disposable | undefined {
  const create = (vscode as any).createMcpServer;
  if (typeof create !== 'function') {
    vscode.window.showWarningMessage(
      'Smart Explorer : vscode.createMcpServer indisponible (VS Code < 1.99 ?), serveur MCP non démarré.',
    );
    return undefined;
  }
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!root) {
    return undefined;
  }
  const env: ToolEnv = {
    root,
    revealFile: hooks.revealFile,
    setActiveWorkspace: hooks.setActiveWorkspace,
    getActiveWorkspace: hooks.getActiveWorkspace,
    githubToken: async () => (await getGithubSession(false))?.accessToken,
    linearToken: async () => getLinearToken(context),
  };
  const server: vscode.McpServerHandle = create(
    'smart-explorer',
    'Smart Explorer',
  );
  for (const spec of buildTools()) {
    server.registerTool(spec.name, {
      description: spec.description,
      inputSchema: spec.inputSchema,
      invoke: async (args) => toolResult(await spec.run(env, args)),
    });
  }
  context.subscriptions.push(server);
  return server;
}
