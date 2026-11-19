#!/usr/bin/env node
// Serveur MCP stdio pour clients externes (Vibe, Claude Code CLI, CLI Mistral).
// Expose les mêmes 11 tools que la version in-process de l'extension VS Code :
// toute la logique vit dans mcpTools.ts (sans dépendance à vscode).
//
// Racine du projet, par ordre de priorité :
//   1. argument --root <path>
//   2. variable d'environnement SMART_EXPLORER_ROOT
//   3. répertoire courant (process.cwd())
//
// Config client (ex: .mcp.json à la racine du projet) :
//   { "mcpServers": { "smart-explorer": { "command": "node",
//       "args": ["/abs/path/smart-explorer/out/mcpStdio.js"] } } }
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';
import {
  ToolEnv,
  applySyncTool,
  buildTreeTool,
  checkWorkspaceFilesTool,
  createWorkspaceTool,
  exportContextTool,
  fetchSourceTool,
  listWorkspacesTool,
  setActiveWorkspaceTool,
  setInstructionsTool,
  syncWorkspaceTool,
} from './mcpTools';
import { loadWorkspace } from './workspaceStore';

function resolveRoot(): string {
  const argIdx = process.argv.indexOf('--root');
  if (argIdx >= 0 && process.argv[argIdx + 1]) {
    return path.resolve(process.argv[argIdx + 1]);
  }
  if (process.env.SMART_EXPLORER_ROOT) {
    return path.resolve(process.env.SMART_EXPLORER_ROOT);
  }
  return process.cwd();
}

const ACTIVE_FILE = '.smart-explorer/active';

function makeEnv(root: string): ToolEnv {
  return {
    root,
    // Hors VS Code : reveal_file retourne le chemin absolu (le client ouvre
    // le fichier lui-même) ; set_active_workspace écrit .smart-explorer/active
    // que l'extension lit au prochain rechargement.
    revealFile: undefined,
    setActiveWorkspace: (id) => {
      const file = path.join(root, ACTIVE_FILE);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, id);
    },
    getActiveWorkspace: () => {
      try {
        return fs.readFileSync(path.join(root, ACTIVE_FILE), 'utf8').trim();
      } catch {
        return undefined;
      }
    },
  };
}

function text(value: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
  };
}

async function main(): Promise<void> {
  const root = resolveRoot();
  const env = makeEnv(root);
  const server = new McpServer(
    { name: 'smart-explorer', version: '0.0.1' },
    {
      instructions: `Smart Explorer — workspaces à virtual tree pour ${root}.`,
    },
  );

  const strArray = z.array(z.string());

  server.registerTool(
    'list_workspaces',
    {
      description:
        'Liste les workspaces Smart Explorer du projet (id, nom, type de source, fraîcheur).',
      inputSchema: {},
    },
    async () => text(await listWorkspacesTool(env)),
  );
  server.registerTool(
    'create_workspace',
    {
      description:
        'Crée un workspace depuis une source (URL issue/PR GitHub ou Linear, ou texte). Retourne workspace_id.',
      inputSchema: {
        source: z.string(),
        name: z.string().optional(),
        instructions: strArray.optional(),
      },
    },
    async (args) => text(await createWorkspaceTool(env, args)),
  );
  server.registerTool(
    'fetch_source',
    {
      description:
        'Canonicalise une ref : titre, description, fichiers modifiés (PR), SHA courant.',
      inputSchema: { ref: z.string() },
    },
    async (args) => text(await fetchSourceTool(env, args)),
  );
  server.registerTool(
    'build_tree',
    {
      description:
        "Écrit l'arbre virtuel (virtual dirs + fichiers primaires) dans le YAML du workspace.",
      inputSchema: {
        workspace_id: z.string(),
        tree: z.record(z.string(), z.unknown()),
      },
    },
    async (args) => text(await buildTreeTool(env, args)),
  );
  server.registerTool(
    'set_instructions',
    {
      description: "Écrit les instructions d'organisation d'un workspace.",
      inputSchema: { workspace_id: z.string(), instructions: strArray },
    },
    async (args) => text(await setInstructionsTool(env, args)),
  );
  server.registerTool(
    'sync_workspace',
    {
      description:
        'Retourne le diff depuis base_commit (added/modified/deleted/renamed + drift), sans appliquer.',
      inputSchema: { workspace_id: z.string() },
    },
    async (args) => text(await syncWorkspaceTool(env, args)),
  );
  server.registerTool(
    'apply_sync',
    {
      description:
        'Applique le diff validé : retire les fichiers supprimés/renommés acceptés, met à jour base_commit et file_hashes.',
      inputSchema: {
        workspace_id: z.string(),
        accepted: strArray,
        rejected: strArray,
      },
    },
    async (args) => text(await applySyncTool(env, args)),
  );
  server.registerTool(
    'check_workspace_files',
    {
      description:
        'Liste les chemins introuvables du workspace + candidats de résolution (fuzzy).',
      inputSchema: { workspace_id: z.string() },
    },
    async (args) => text(await checkWorkspaceFilesTool(env, args)),
  );
  server.registerTool(
    'export_context',
    {
      description:
        'Exporte le contexte du workspace (primary | with_dependencies), tronqué à max_tokens si fourni.',
      inputSchema: {
        workspace_id: z.string(),
        mode: z.enum(['primary', 'with_dependencies']),
        max_tokens: z.number().optional(),
      },
    },
    async (args) => text(await exportContextTool(env, args)),
  );
  server.registerTool(
    'reveal_file',
    {
      description:
        "Hors VS Code : retourne le chemin absolu du fichier (le client l'ouvre). reveal='tree' sans effet ici.",
      inputSchema: {
        path: z.string(),
        workspace_id: z.string().optional(),
        reveal: z.enum(['editor', 'tree']),
      },
    },
    async (args) => {
      if (args.workspace_id && !loadWorkspace(root, args.workspace_id)) {
        throw new Error(`Workspace introuvable : ${args.workspace_id}`);
      }
      return text({
        ok: true,
        path: args.path,
        absolute_path: path.join(root, args.path),
        note: 'Client externe : ouvre ce chemin dans ton éditeur.',
      });
    },
  );
  server.registerTool(
    'set_active_workspace',
    {
      description:
        "Bascule la workspace affichée dans VS Code (écrit .smart-explorer/active, lu par l'extension).",
      inputSchema: { workspace_id: z.string() },
    },
    async (args) => text(await setActiveWorkspaceTool(env, args)),
  );

  await server.connect(new StdioServerTransport());
  // eslint-disable-next-line no-console
  console.error(`smart-explorer MCP stdio démarré (root=${root})`);
}

main().catch((error) => {
  console.error('smart-explorer MCP stdio: erreur fatale', error);
  process.exit(1);
});
